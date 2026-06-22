# Lanelet Intersection — Phase 1: Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the derived lane+lanelet graph + precise geometric conflict matrix (incl. pedestrian crosswalks) behind the `experimental_lanelet_intersections` flag, with NO change to traffic behavior yet — fully unit/property-tested and observable via BRP.

**Architecture:** A new `transport/lanelet/` module derives, once per `GraphVersion`, a `LaneletGraph` (RoadLane nodes reusing the existing per-tile-lane model + Lanelet nodes = one per legal entry-lane→exit-lane maneuver per cluster, internal path strictly 4-adjacent) and a `ConflictMatrix` per intersection (two lanelets/crosswalks conflict iff their internal cells overlap). Everything is derived from `MapGrid` + `IntersectionIndex`; nothing persisted. The build system runs in `GameSet::GraphUpdate`, gated by the flag, alongside `build_lane_graph`.

**Tech Stack:** Rust 1.96 (edition 2024), Bevy 0.19, `bevy_egui`. Workspace crate `simcity_sim`. Tests co-located (`#[cfg(test)] mod tests`). Config in `assets/config/traffic.ron` via `config_loader`.

**Spec:** `docs/superpowers/specs/2026-06-22-lanelet-intersection-architecture-design.md` (§S1 graph model, §S2 geometry, §S3 conflict matrix, §S10 observability).

## Global Constraints

- Toolchain pinned `1.96.0`, edition `2024` (`rust-toolchain.toml`). Verification floor: `cargo fmt --all` → `cargo clippy --all-targets --all-features -- -D warnings` → `cargo test`.
- **Determinism:** seeded `SimRng` only; NO `HashMap`-iteration-order dependence in any output; iterate clusters by `IntersectionId`, lanelets by stable sorted key. Reproducible across rebuilds (asserted by test).
- **No behavior change in Phase 1:** the flag default is `false`; the new build system is a no-op when off; `move_vehicles`/admission untouched.
- **Persistence:** add NOTHING to `SaveGameV3`. `LaneletGraph`/`ConflictMatrix` are `Resource`s rebuilt from the map, like `LaneGraph`.
- **Observability mandate:** new state exposed via BRP/MCP through a FLAT reflected `Debug*State` mirror — do NOT reflect-register complex types (see memory `simcity-reflect-registration-breaks-load`).
- **Style:** match existing `transport/` patterns; no comments narrating what code does (only non-obvious why); smallest change that satisfies the task.

---

### Task 1: Feature flag in TrafficConfig

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/config.rs` (TrafficConfig struct + Default)
- Modify: `assets/config/traffic.ron` (document the key; serde-default makes it optional)
- Test: in `simcity_data` config parse test (the existing traffic.ron parse test) OR a `#[cfg(test)]` in `config.rs`

**Interfaces:**
- Produces: `TrafficConfig.experimental_lanelet_intersections: bool` (default `false`), read by later tasks via `Res<TrafficConfig>`.

- [ ] **Step 1: Write the failing test** — assert the field exists and defaults false when absent from RON.

```rust
// in crates/simcity_sim/src/game/traffic/config.rs #[cfg(test)] mod tests
#[test]
fn experimental_lanelet_flag_defaults_false() {
    // RON without the key must still parse, defaulting the flag to false.
    let ron = "(max_active_vehicles: 1500, max_route_plans_per_tick: 64, heat_ema_decay: 0.92, drive_on_right: true)";
    let cfg: TrafficConfig = ron::from_str(ron).expect("parse");
    assert!(!cfg.experimental_lanelet_intersections);
}
```

- [ ] **Step 2: Run test, verify it fails** — `cargo test -p simcity_sim traffic::config::tests::experimental_lanelet_flag_defaults_false` → FAIL (no field).

- [ ] **Step 3: Add the field** — in `TrafficConfig`, mirroring the existing `#[serde(default = ...)]` pattern:

```rust
    /// Phase-gate for the experimental lanelet/conflict-point intersection system (see
    /// docs/superpowers/specs/2026-06-22-lanelet-intersection-architecture-design.md). When false,
    /// the legacy connector/admission pipeline runs (unchanged).
    #[serde(default)]
    pub experimental_lanelet_intersections: bool,
```

Add `experimental_lanelet_intersections: false` to the struct's `Default` impl if it has an explicit one (check; if it derives Default, nothing needed — but `bool` default is false either way via `#[serde(default)]`).

- [ ] **Step 4: Run test, verify it passes.** Also `cargo test -p simcity_data` (the existing traffic.ron roundtrip parse test must still pass).

- [ ] **Step 5: Document the key** in `assets/config/traffic.ron` (a trailing comment line; do NOT set it true).

- [ ] **Step 6: Commit** — `git commit -am "feat(traffic): add experimental_lanelet_intersections flag (default off)"`

---

### Task 2: Lanelet graph data types + module

**Files:**
- Create: `crates/simcity_sim/src/game/transport/lanelet/mod.rs`
- Create: `crates/simcity_sim/src/game/transport/lanelet/graph.rs`
- Modify: `crates/simcity_sim/src/game/transport/mod.rs` (`mod lanelet;` + re-exports)
- Test: `#[cfg(test)] mod tests` in `graph.rs`

**Interfaces:**
- Produces:
  - `pub struct LaneletId(pub u32);` (+ `INVALID`)
  - `pub struct Lanelet { pub id: LaneletId, pub intersection: IntersectionId, pub entry_lane: LaneId, pub exit_lane: LaneId, pub maneuver: ManeuverKind, pub internal_path: Vec<TilePos> }`
  - `#[derive(Resource, Default)] pub struct LaneletGraph { pub lanelets: Vec<Lanelet>, pub by_intersection: HashMap<IntersectionId, Vec<LaneletId>>, pub version: u64 }`
  - `impl LaneletGraph { pub fn is_built_for(&self, v: u64) -> bool; pub fn get(&self, id: LaneletId) -> Option<&Lanelet>; pub fn of_intersection(&self, id: IntersectionId) -> &[LaneletId] }`
  - Reuse existing `ManeuverKind` (`traffic/intersection/zones.rs`), `LaneId` (`transport/lane_graph.rs`), `IntersectionId` (`intersections`).

- [ ] **Step 1: Write the failing test** — empty graph invariants.

```rust
#[test]
fn empty_lanelet_graph_reports_unbuilt_and_no_lanelets() {
    let g = LaneletGraph::default();
    assert!(!g.is_built_for(1));
    assert!(g.get(LaneletId(0)).is_none());
    assert!(g.of_intersection(IntersectionId(0)).is_empty());
}
```

- [ ] **Step 2: Run, verify fail** (module/types missing).

- [ ] **Step 3: Implement** the types above in `graph.rs`; `mod.rs` does `pub mod graph; pub use graph::{Lanelet, LaneletId, LaneletGraph};`. Wire `mod lanelet;` + `pub use lanelet::{LaneletGraph, LaneletId, Lanelet};` in `transport/mod.rs`. `version: 0` default; `is_built_for` returns `self.version == v && !self.lanelets.is_empty()` style mirroring `LaneGraph::is_built_for` (lane_graph.rs:54).

- [ ] **Step 4: Run, verify pass.** `cargo clippy ... -D warnings` clean.

- [ ] **Step 5: Commit** — `feat(transport): lanelet graph data types`

---

### Task 3: Orthogonal lanelet internal-path generator (the diagonal-bug killer)

**Files:**
- Create: `crates/simcity_sim/src/game/transport/lanelet/build.rs` (start the generator; system added in Task 6)
- Test: `#[cfg(test)] mod tests` in `build.rs`

**Interfaces:**
- Produces: `pub(crate) fn build_internal_path(cluster_tiles: &HashSet<TilePos>, entry_tile: TilePos, exit_tile: TilePos) -> Option<Vec<TilePos>>` — returns a strictly 4-adjacent path entirely within `cluster_tiles` from `entry_tile` to a cluster tile adjacent to `exit_tile`, or `None` if none exists. NO diagonal step is ever emitted.
- Consumes: cluster tile set (from `IntersectionCluster.tiles`).

- [ ] **Step 1: Write the failing test** — the property that previously broke (diagonal exit). Build a 2-wide cluster where a naive generator would produce `(31,61)->(32,60)`; assert every consecutive pair is Manhattan-adjacent.

```rust
#[test]
fn internal_path_is_strictly_4_adjacent_never_diagonal() {
    use std::collections::HashSet;
    // cluster occupies x in 31..=34, y in 61..=66 (the 4x6 monster shape).
    let cluster: HashSet<TilePos> =
        (31..=34).flat_map(|x| (61..=66).map(move |y| TilePos { x, y })).collect();
    let entry = TilePos { x: 34, y: 64 };   // enters from the east
    let exit = TilePos { x: 30, y: 64 };     // straight-through west exit (outside cluster)
    let path = build_internal_path(&cluster, entry, exit).expect("path exists");
    assert!(path.len() >= 2);
    for w in path.windows(2) {
        let d = (w[1].x - w[0].x).abs() + (w[1].y - w[0].y).abs();
        assert_eq!(d, 1, "non-orthogonal step {:?}->{:?}", w[0], w[1]);
    }
    assert!(path.iter().all(|t| cluster.contains(t)), "path stays inside the cluster");
}
```

- [ ] **Step 2: Run, verify fail** (function missing).

- [ ] **Step 3: Implement** a BFS/greedy 4-neighbor router over `cluster_tiles` from `entry_tile` to the cluster tile orthogonally adjacent to `exit_tile` (the "exit correction is applied to the GOAL" rule — the goal is the in-cluster tile next to the real exit lane, so the final emitted step is always orthogonal). Use a deterministic neighbor order (E,W,N,S) and BFS for shortest in-cluster path; return the tile sequence. Reuse geometry ideas from `connectors.rs build_connector_path` but as a pure 4-adjacent BFS — never the lateral-shift-then-append that produced the diagonal.

- [ ] **Step 4: Run, verify pass.** Add a second test: a U-turn / left-turn shape also stays 4-adjacent.

- [ ] **Step 5: Commit** — `feat(transport): orthogonal lanelet internal-path generator`

---

### Task 4: LaneType-based lanelet enter-rule

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/lanelet/build.rs`
- Test: `#[cfg(test)] mod tests` in `build.rs`

**Interfaces:**
- Produces: `pub(crate) fn lane_allows_maneuver(lane_type: LaneType, maneuver: ManeuverKind, dir: RoadDir, drive_on_right: bool) -> bool` — whether an approach lane of the given `lane_type` may feed a lanelet of `maneuver` (e.g. `LeftTurnOnly` feeds only `LeftTurn`; `Regular` feeds `Straight`+the side turn per drive side; `RightTurnOnly` feeds only `RightTurn`).
- Consumes: `LaneType` (`simcity_core roads.rs:155`), `ManeuverKind` (zones.rs), `is_leftmost/rightmost_for_dir` (roads.rs:245).

- [ ] **Step 1: Write the failing test** — table of (lane_type, maneuver) → allowed.

```rust
#[test]
fn left_only_lane_feeds_only_left_lanelets() {
    assert!(lane_allows_maneuver(LaneType::Left, ManeuverKind::LeftTurn, RoadDir::North, true));
    assert!(!lane_allows_maneuver(LaneType::Left, ManeuverKind::Straight, RoadDir::North, true));
    assert!(!lane_allows_maneuver(LaneType::Left, ManeuverKind::RightTurn, RoadDir::North, true));
    assert!(lane_allows_maneuver(LaneType::Regular, ManeuverKind::Straight, RoadDir::North, true));
}
```
(Verify exact `LaneType` variant names in roads.rs:155 first — they may be `Left/Right/StraightOnly/Regular`.)

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the predicate by matching on `lane_type`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(transport): lanelet enter-rule from lane_type`

---

### Task 5: ConflictMatrix (precise geometric, deterministic)

**Files:**
- Create: `crates/simcity_sim/src/game/transport/lanelet/conflict.rs`
- Modify: `lanelet/mod.rs` (re-export)
- Test: `#[cfg(test)] mod tests` in `conflict.rs`

**Interfaces:**
- Produces:
  - `pub struct ConflictMatrix { rows: Vec<SmallVec<[u64; 2]>>, n: usize }` (bitset rows; index = local lanelet index within the intersection)
  - `impl ConflictMatrix { pub fn from_paths(internal_paths: &[Vec<TilePos>]) -> Self; pub fn conflicts(&self, a: usize, b: usize) -> bool; pub fn row(&self, a: usize) -> &[u64] }`
  - Conflict iff the two lanelets' internal tile sets intersect.
- Consumes: `smallvec` (already a dep? if not, add to `simcity_sim/Cargo.toml`).

- [ ] **Step 1: Write the failing test** — crossing lanelets conflict, disjoint don't, and determinism across rebuilds.

```rust
#[test]
fn crossing_paths_conflict_disjoint_dont_and_build_is_deterministic() {
    let p_we = vec![TilePos{x:1,y:1}, TilePos{x:0,y:1}];           // west-through on y=1
    let p_ns = vec![TilePos{x:0,y:0}, TilePos{x:0,y:1}, TilePos{x:0,y:2}]; // north-through crossing (0,1)
    let p_far = vec![TilePos{x:5,y:5}, TilePos{x:5,y:6}];          // disjoint
    let m = ConflictMatrix::from_paths(&[p_we.clone(), p_ns.clone(), p_far.clone()]);
    assert!(m.conflicts(0, 1), "they share (0,1)");
    assert!(!m.conflicts(0, 2));
    assert!(!m.conflicts(1, 2));
    // determinism: identical inputs -> identical rows
    let m2 = ConflictMatrix::from_paths(&[p_we, p_ns, p_far]);
    assert_eq!(m.row(0), m2.row(0));
    assert_eq!(m.row(1), m2.row(1));
}
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `from_paths`: build a `HashMap<TilePos, SmallVec<usize>>` cell→lanelets occupancy, then for each pair sharing any cell set both bits; store as bitset rows. No RNG, no iteration-order output (the rows are deterministic given indices).
- [ ] **Step 4: Run, verify pass.** clippy clean (add `smallvec` dep if needed, sync `Cargo.lock`).
- [ ] **Step 5: Commit** — `feat(transport): precise geometric lanelet conflict matrix`

---

### Task 6: build_lanelet_graph system + flag-gated GraphUpdate wiring

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/lanelet/build.rs` (the system)
- Modify: `crates/simcity_sim/src/game/transport/mod.rs` (init resource + add system to `GameSet::GraphUpdate` with `run_if(flag)`)
- Test: `#[cfg(test)] mod tests` (a small App that builds for a hand-made grid+clusters)

**Interfaces:**
- Produces: `pub fn build_lanelet_graph(grid: Res<MapGrid>, intersections: Res<IntersectionIndex>, lanes: Res<LaneGraph>, gv: Res<GraphVersion>, traffic_cfg: Res<TrafficConfig>, mut graph: ResMut<LaneletGraph>, mut matrices: ResMut<LaneletConflictMatrices>)` — builds `LaneletGraph` + per-intersection `ConflictMatrix` once per `GraphVersion`; early-returns if `!flag` or already built for this version.
- Produces: `#[derive(Resource, Default)] pub struct LaneletConflictMatrices { pub by_intersection: HashMap<IntersectionId, ConflictMatrix>, pub version: u64 }`

- [ ] **Step 1: Write the failing test** — a 1-cluster grid (a single cross intersection) builds N lanelets and a matrix; with flag off, builds nothing.

```rust
#[test]
fn build_lanelet_graph_produces_lanelets_when_flag_on_and_nothing_when_off() {
    // construct App with MinimalPlugins, a tiny grid (a + cross), IntersectionIndex with 1 cluster,
    // LaneGraph built, GraphVersion=1, TrafficConfig{experimental_lanelet_intersections: true, ..}.
    // run build_lanelet_graph once.
    // assert: graph.lanelets non-empty, by_intersection has the cluster id, matrices has it.
    // then flip flag false + bump version, run again on a fresh graph -> stays empty.
}
```
(Fill the App setup mirroring the existing transport/intersection tests, e.g. `tests` in `lane_graph.rs` / `traffic/tests/mod.rs` harness.)

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `build_lanelet_graph`: for each `IntersectionCluster`, derive approach lanes per entry dir + legal exit dirs (reuse `turn_lanes.rs:67` logic), enumerate `(entry_lane, exit_lane)` maneuvers passing `lane_allows_maneuver`, build each `internal_path` via `build_internal_path`, push `Lanelet`s sorted by `(entry_lane, exit_lane)`, build the cluster's `ConflictMatrix::from_paths`. Stamp `version = gv.0`. Wire into `transport/mod.rs` GraphUpdate after `build_lane_graph` with `.run_if(|c: Res<TrafficConfig>| c.experimental_lanelet_intersections)`; `init_resource::<LaneletGraph>()` + `LaneletConflictMatrices`.
- [ ] **Step 4: Run, verify pass.** clippy + fmt clean.
- [ ] **Step 5: Commit** — `feat(transport): build lanelet graph + conflict matrices behind flag`

---

### Task 7: BRP/MCP observability mirror

**Files:**
- Modify: `crates/simcity_debug/src/game/debug_world.rs` (add `DebugLaneletState` flat mirror + update system + registration)
- Test: `#[cfg(test)] mod tests` or rely on the existing debug-snapshot smoke test

**Interfaces:**
- Produces: `#[derive(Component, Reflect, Default)] pub struct DebugLaneletState { pub built_version: u64, pub lanelet_count: u32, pub intersection_count: u32, pub max_lanelets_per_intersection: u32, pub max_conflicts_per_lanelet: u32 }` — a FLAT reflected mirror (no nested complex types), updated each frame from `LaneletGraph`/`LaneletConflictMatrices`, registered for BRP like the other `Debug*Snapshot` mirrors.

- [ ] **Step 1: Write the failing test** — the mirror reflects counts after a build (or a registration smoke check matching the existing Debug*Snapshot pattern).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the flat component + update system (read `LaneletGraph`, fill counts) + `register_type::<DebugLaneletState>()` + `ensure_component` in the same place as `DebugTrafficSnapshot` (debug_world.rs ~685/760). Do NOT register `LaneletGraph`/`Lanelet` themselves (reflect-registration-breaks-load).
- [ ] **Step 4: Run, verify pass.** Full suite + clippy + fmt.
- [ ] **Step 5: Commit** — `feat(debug): BRP DebugLaneletState mirror for the lanelet graph`

---

## Phase 1 exit criteria
- `cargo fmt --all` clean, `cargo clippy --all-targets --all-features -- -D warnings` clean, `cargo test` green.
- With flag ON, `build_lanelet_graph` produces a deterministic lanelet graph + conflict matrices for the test city (verify live via BRP `DebugLaneletState`: lanelet_count > 0, no diagonal in any internal_path — add a debug assertion/tripwire).
- With flag OFF, zero new work runs; traffic behavior byte-identical to today.
- No `SaveGameV3` change; save/load roundtrip unchanged.

## Roadmap (detailed into their own plans when reached)
- **Phase 2 — Lane-level pathfinding:** `find_lanelet_path` (A* over RoadLane+Lanelet edges with turn/lane-change costs + scaled-admissible heuristic), route flattener to `Vec<TilePos>` + sidecar `Vec<(IntersectionId, LaneletId)>`, lane pre-positioning (mandatory-merge + reroute fallback), `pathfinding.ron` knobs + spread tests. Behind flag; old admission still runs.
- **Phase 3 — Arbiter + ledger + ПДД + acyclic order (behavior change):** `IntersectionLedger` (active_mask + reserved exit slots), `arbitrate_lanelet_reservations` single deterministic arbiter, `lanelet_readiness()` (signalized phases / uncontrolled priority-by-width / RTOR), global acyclic progress order (the liveness proof), reserved-exit-slot, soft Approaching reservations. Writes the shared `is_reserved_by` truth; `move_vehicles` unforked.
- **Phase 4 — Pedestrians + protected-left + cleanup + live verification:** crosswalk conflict rows + WALK sub-phase + actuated ped fairness, extended `LightPhase`/PhasePlan, delete the band-aids (stall_ticks valve, swap_break, diagonal fallback) keeping `INTERSECTION_STALL_FORCE_TICKS` as a tripwire, the live stress/A-B verification gate before flipping the default.
