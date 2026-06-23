# Lanelet Intersection — Phase 2: Lane-Level Pathfinding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Behind the `experimental_lanelet_intersections` flag, route vehicles with an A* over a combined RoadLane+Lanelet graph so routes are correct-by-construction (the vehicle pre-positions into the legal turn lane upstream of the intersection), emitting the unchanged `Vec<TilePos>` route plus a per-vehicle `(IntersectionId, LaneletId)` sidecar for Phase 3 — with NO gameplay change when the flag is off.

**Architecture:** Phase 1 built the derived `LaneletGraph` + `ConflictMatrix` (flag-gated, in `GameSet::GraphUpdate`). Phase 2 adds: (a) a `by_entry_lane` index on `LaneletGraph`; (b) `find_combined_path` — a structural clone of `find_lane_path` over `CombinedNode = {Road(LaneId), Lanelet(LaneletId)}`, reusing the existing dense-vec A* + per-trip splitmix64 jitter, with an admissible scaled heuristic; (c) a `find_route` flag seam at the sole spawn call site that returns the same `Vec<TilePos>` into `PathPool` plus the sidecar; (d) a `VehicleLaneletPlan` component holding the sidecar, cleared on any mid-trip reroute. The route format and `drive.rs` are untouched because the model is **1 tile == 1 lane** (each `RoadCell` carries its own `lane`/`dir`), so a tile sequence implicitly encodes the lane.

**Tech Stack:** Rust 1.96 (edition 2024), Bevy 0.19. Workspace crate `simcity_sim` (+ `simcity_debug` for observability). Tests co-located.

**Spec:** `docs/superpowers/specs/2026-06-22-lanelet-intersection-architecture-design.md` (§S7). Phase 1 plan: `docs/superpowers/plans/2026-06-22-lanelet-intersection-phase1.md`.

## Global Constraints

- Toolchain pinned `1.96.0`, edition `2024`. Verification floor: `cargo fmt --all` → `cargo clippy --all-targets --all-features -- -D warnings` → `cargo test`.
- **Flag-off = byte-identical behavior.** When `experimental_lanelet_intersections == false`, `find_route` delegates to the existing `find_lane_path` + `lane_path_to_tiles` with an empty sidecar; the RNG stream and the resulting route must be byte-identical to today. Verify the existing 3 `lane_pathfinding` tests stay green.
- **Route stays `Vec<TilePos>`.** `PathPool`, `PathHandle`, `Vehicle.path_handle/path_cursor`, and `drive.rs` are NOT changed. The sidecar `Vec<(IntersectionId, LaneletId)>` is the ONLY new data channel.
- **Determinism.** Seeded `SimRng` / splitmix64 only; no `HashMap`-iteration-order dependence in any route output; A* tie-break stays a total order (`f → g → packed node id`); preserve the per-TRIP jitter (seed drawn at `spawn.rs:96`, added to EDGE cost only, never the heuristic). No NEW `sim_rng` draws (jitter is a pure hash of `(seed, id)`).
- **Heuristic admissibility (the load-bearing correctness fix).** `h = (dx+dy) * MIN_PER_TILE_BASE` where `MIN_PER_TILE_BASE = 7` (global min over `RoadKind` of `floor((1/speed)*(1/desirability)*cost_scale)` = SixLane `(1/80)*(1/1.6)*1000 = 7.8125 → 7`). Penalties and jitter are EXCLUDED from `h` (added only to real edges) so `h` never overestimates. Using the global min guarantees admissibility everywhere.
- **No `SaveGameV3` / persistence change** (all derived). **No complex-type BRP reflect registration** (flat mirrors only).
- **Sidecar invalidation is P0:** every mid-trip tile-A* re-intern site must clear `VehicleLaneletPlan` when the flag is on (a stale cursor offset mis-feeds the Phase-3 arbiter). A cleared plan is a safe degenerate (Phase 3 falls back to legacy admission for that vehicle).
- **Phase-2/Phase-3 boundary:** Phase 2 ships correct-by-construction routes + `by_entry_lane` + flag seam + sidecar + invalidation + observability. The mandatory-merge ENFORCEMENT and reroute-from-actual-lane are DEFERRED to Phase 3 (the happy-path merge is free — the routed lateral tiles ARE the merge, executed by the existing driver). Phase 2 adds NO new lateral movements and NO new deadlock-class behavior.
- Style: match `transport/` patterns; no narrating comments (only non-obvious WHY); smallest change.

---

### Task 1: `by_entry_lane` derived index on `LaneletGraph`

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/lanelet/graph.rs` (add field + accessor)
- Modify: `crates/simcity_sim/src/game/transport/lanelet/build.rs` (populate in the existing id-ordered loop; clear alongside the others)
- Test: `#[cfg(test)] mod tests` in `build.rs`

**Interfaces:**
- Consumes: `LaneletGraph`, `LaneId`, `LaneletId` (Phase 1).
- Produces: `LaneletGraph.by_entry_lane: HashMap<LaneId, Vec<LaneletId>>`; `impl LaneletGraph { pub fn lanelets_from(&self, l: LaneId) -> &[LaneletId] }` (empty slice if absent).

- [ ] **Step 1: Write the failing test** — extend the existing `build_lanelet_graph_flag_on_populates_graph` harness: after build, pick an entry lane that feeds multiple lanelets and assert:
```rust
#[test]
fn by_entry_lane_indexes_lanelets_ascending_by_exit() {
    // (reuse the flag-on App+grid harness from build_lanelet_graph_flag_on_populates_graph)
    // for some entry lane `e` that feeds >1 lanelet:
    let from = graph.lanelets_from(e);
    let expected: Vec<LaneletId> = graph.lanelets.iter()
        .filter(|l| l.entry_lane == e).map(|l| l.id).collect();
    assert_eq!(from, expected.as_slice());
    // ascending by exit_lane.0 (free from the id-ordered build loop):
    let exits: Vec<u32> = from.iter().map(|id| graph.get(*id).unwrap().exit_lane.0).collect();
    assert!(exits.windows(2).all(|w| w[0] <= w[1]));
    assert!(graph.lanelets_from(LaneId(u32::MAX)).is_empty());
}
```

- [ ] **Step 2: Run, verify fail** (field/accessor missing).
- [ ] **Step 3: Implement** — add `by_entry_lane: HashMap<LaneId, Vec<LaneletId>>` (derive into `Default`); inside the existing lanelet-assign loop (`build.rs` ~:275-280, which already runs in id order and per-cluster sorted by `(entry_lane.0, exit_lane.0)`), `by_entry_lane.entry(l.entry_lane).or_default().push(l.id)` — buckets come out exit-ascending for free, no extra sort. Clear it alongside `lanelets`/`by_intersection` at the rebuild reset (`build.rs` ~:150-152). Add `lanelets_from`.
- [ ] **Step 4: Run, verify pass.** Verification floor green.
- [ ] **Step 5: Commit** — `feat(transport): by_entry_lane index on LaneletGraph`

---

### Task 2: Admissible scaled heuristic (`MIN_PER_TILE_BASE`)

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/lane_pathfinding.rs` (the `heuristic_lane` fn ~:154-165)
- Reference: `crates/simcity_core/src/game/roads.rs:35-66` (`speed_limit`, `desirability`)
- Test: `#[cfg(test)] mod tests` in `lane_pathfinding.rs`

**Interfaces:**
- Produces: `pub(crate) const MIN_PER_TILE_BASE: u32 = 7;` (with a comment deriving it: global min over `RoadKind` of `floor((1/speed)*(1/desirability)*cost_scale)`, SixLane = `(1/80)*(1/1.6)*1000 = 7.8125 → 7`); `heuristic_lane` returns `(dx+dy) * MIN_PER_TILE_BASE`.

- [ ] **Step 1: Write the failing test** — admissibility + no-suboptimality:
```rust
#[test]
fn scaled_heuristic_is_admissible_and_optimal() {
    // Build a small LaneGraph with a corridor. For every lane node n, assert
    // heuristic_lane(n.pos, goal.pos) <= true_min_cost(n -> goal) where true_min_cost
    // is computed by a heuristic-free Dijkstra over the SAME lane_edge_cost (jitter_seed=0).
    // And: find_lane_path cost == Dijkstra cost (no heuristic-induced suboptimality).
}
```
(If a brute-force Dijkstra helper doesn't exist, write a tiny one in the test module over `graph.get_connections` + `lane_edge_cost` with seed 0.)

- [ ] **Step 2: Run, verify fail** (raw `dx+dy` heuristic may already be admissible, so the admissibility half passes — the FAILING assertion is the perf/scaling one; if needed, add the explicit check that `heuristic_lane(pos,goal) == manhattan * MIN_PER_TILE_BASE`, which fails against the current raw `dx+dy`).
- [ ] **Step 3: Implement** — add the const, multiply the Manhattan distance by it. Do NOT add jitter or penalties to `h`.
- [ ] **Step 4: Run, verify pass.** Confirm the existing `lane_pathfinding` spread/path tests still pass (the heuristic only speeds search; optimal routes unchanged for the existing cost model).
- [ ] **Step 5: Commit** — `fix(transport): admissible scaled lane-pathfinding heuristic (MIN_PER_TILE_BASE)`

---

### Task 3: `CombinedNode` graph view + deterministic successors

**Files:**
- Create: `crates/simcity_sim/src/game/transport/lanelet/pathfinding.rs` (+ `pub(crate) mod pathfinding;` in `lanelet/mod.rs`)
- Reference: `crates/simcity_sim/src/game/transport/lane_graph.rs:161-211` (`road_lane_connections`, `intersection_connections`); `pathfinding/mod.rs:27,29` (`lane_change_penalty=40`, `turn_penalty=80`)
- Test: `#[cfg(test)] mod tests` in `pathfinding.rs`

**Interfaces:**
- Consumes: `LaneGraph`, `LaneId`, `LaneletGraph`, `LaneletId`, `LaneCostCtx` (`lane_pathfinding.rs:27`), `lane_edge_cost`.
- Produces:
  - `pub(crate) enum CombinedNode { Road(LaneId), Lanelet(LaneletId) }`
  - packing: `Road(l) -> l.0 as usize`; `Lanelet(ll) -> road_len + ll.0 as usize` (where `road_len = lg.lanes.len()`); + unpack.
  - `pub(crate) fn for_each_succ(node: CombinedNode, lg: &LaneGraph, llg: &LaneletGraph, ctx: &LaneCostCtx, f: impl FnMut(CombinedNode, u32))` — emits successors with edge cost, deterministically (id-sorted, no HashMap iteration).

- [ ] **Step 1: Write the failing test**:
```rust
#[test]
fn successors_enter_only_legal_lanes_and_are_deterministic() {
    // small intersection graph (reuse build harness). For a road lane `e` feeding a multi-approach
    // intersection: collect for_each_succ edges. Assert:
    // - ENTER edges go ONLY to lanelets with entry_lane==e (set equals llg.lanelets_from(e));
    // - each ENTER cost == turn_penalty + sum(internal-tile base cost at e's road kind);
    // - lane-change lateral edges carry +lane_change_penalty;
    // - calling for_each_succ twice yields byte-identical (CombinedNode, cost) sequences.
    // For a Lanelet node ll: exactly one EXIT edge to Road(ll.exit_lane), cost 1.
}
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — Road successors: lane-follow forward in `lane.dir` to the next ROAD lane (REUSE `road_lane_connections` semantics MINUS the `next.dir == None` cluster-entry clause — that clause is what the old turn-blind path used; here intersection entry happens via lanelet ENTER instead); lateral lane-change neighbors `+lane_change_penalty`; for each `ll in llg.lanelets_from(l)` emit `ENTER -> Lanelet(ll)` with cost `turn_penalty + Σ internal_path tile base costs at l's road kind` (NO live congestion → preserves admissibility). Lanelet successors: one `EXIT -> Road(ll.exit_lane)` cost 1. Keep emission order id-sorted (iterate the existing connection vecs in order; `lanelets_from` is already exit-ascending). Does NOT touch `intersection_connections` (stays for the flag-off path).
- [ ] **Step 4: Run, verify pass.** Verification floor green.
- [ ] **Step 5: Commit** — `feat(transport): combined RoadLane+Lanelet graph successors`

---

### Task 4: `find_combined_path` A* + jitter preservation

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/lanelet/pathfinding.rs`
- Reference: `crates/simcity_sim/src/game/transport/lane_pathfinding.rs:31-151` (structure to clone: dense vecs, `HeapState`, lazy-delete, `lane_jitter`)
- Test: `#[cfg(test)] mod tests` in `pathfinding.rs`

**Interfaces:**
- Produces: `pub(crate) fn find_combined_path(lg: &LaneGraph, llg: &LaneletGraph, ctx: &LaneCostCtx, start: LaneId, goal: LaneId) -> Option<Vec<CombinedNode>>`; internal `HeapState { f: u32, g: u32, idx: usize }` with `f → g → idx` total-order tie-break (mirroring `lane_pathfinding.rs:137-145`).

- [ ] **Step 1: Write the failing test**:
```rust
#[test]
fn combined_path_deterministic_reduces_to_lane_path_and_spreads() {
    // (a) determinism: find_combined_path(seed=7) == find_combined_path(seed=7).
    // (b) reduction: on an intersection-FREE grid, the flattened tiles of find_combined_path equal
    //     find_lane_path's tiles (same optimal route when no lanelets exist).
    // (c) spread: 64 distinct per-trip seeds on equal parallel corridors THROUGH an intersection
    //     produce >=2 distinct route classes and max_freq < 64 (within-OD spread survives lanelet edges).
}
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — clone `find_lane_path`: `best_g: Vec<u32>` + `came_from: Vec<Option<usize>>` sized `road_len + llg.lanelets.len()` (indexed by packed node id), `BinaryHeap<HeapState>`, lazy-delete stale-pop, `saturating_add`, `f = g + heuristic` where the heuristic uses the node's representative tile (Road → `lane.pos`; Lanelet → `internal_path` last/exit tile) and `heuristic_lane` (Task 2). Successors via `for_each_succ` (Task 3). RoadLane edge costs call `lane_edge_cost` VERBATIM (carries congestion + `lane_jitter`); the ENTER edge adds `lane_jitter(seed, stable_per_lanelet_u32)` (ceiling 8 ≪ penalties, breaks equal-maneuver ties only). NO new `sim_rng` draws. Reconstruct to `Vec<CombinedNode>`.
- [ ] **Step 4: Run, verify pass.** Verification floor green.
- [ ] **Step 5: Commit** — `feat(transport): find_combined_path A* over lane+lanelet graph`

---

### Task 5: Flatten to `Vec<TilePos>` + sidecar with cursor offsets

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/lanelet/pathfinding.rs`
- Reference: `crates/simcity_sim/src/game/transport/lanelet/build.rs:52-66` (internal_path geometry)
- Test: `#[cfg(test)] mod tests` in `pathfinding.rs`

**Interfaces:**
- Produces: `pub(crate) fn flatten(nodes: &[CombinedNode], lg: &LaneGraph, llg: &LaneletGraph) -> (Vec<TilePos>, Vec<(usize, IntersectionId, LaneletId)>)` — the `usize` is the cursor offset (the tile index where that lanelet's `internal_path` begins in the flattened route).

- [ ] **Step 1: Write the failing test**:
```rust
#[test]
fn flatten_is_4_adjacent_and_sidecar_offsets_match() {
    // build a turn route's CombinedNode sequence; flatten it.
    let (tiles, side) = flatten(&nodes, &lg, &llg);
    // strict 4-adjacency end-to-end (a diagonal silently breaks drive.rs heading/lerp):
    for w in tiles.windows(2) { assert_eq!((w[1].x-w[0].x).abs()+(w[1].y-w[0].y).abs(), 1); }
    // no duplicate consecutive tile:
    for w in tiles.windows(2) { assert_ne!(w[0], w[1]); }
    // each sidecar entry's offset indexes the lanelet's internal_path[0], with matching ids:
    for (off, isx, llid) in &side {
        let ll = llg.get(*llid).unwrap();
        assert_eq!(tiles[*off], ll.internal_path[0]);
        assert_eq!(*isx, ll.intersection);
    }
}
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — walk `nodes`: `Road(l)` → push `lg.get_lane(l).pos`; `Lanelet(ll)` → record current `tiles.len()` as the cursor offset, push all `ll.internal_path` tiles in order, append `(offset, ll.intersection, ll.id)` to the sidecar. Seam 4-adjacency holds by Phase-1 geometry (approach→`internal_path[0]` dist-1, internal steps dist-1, `internal_path.last`→exit dist-1); guard against a duplicate tile at a seam (skip a push that equals the last pushed tile). `nodes` empty → `(vec![], vec![])`.
- [ ] **Step 4: Run, verify pass.** Verification floor green.
- [ ] **Step 5: Commit** — `feat(transport): flatten combined path to tiles + lanelet sidecar`

---

### Task 6: `find_route` wrapper + flag seam at spawn

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/lanelet/pathfinding.rs` (the wrapper) + re-export in `transport/mod.rs`
- Modify: `crates/simcity_sim/src/game/traffic/spawn.rs:99-130` (replace the lane-path block) + the spawn system params (~:266) to add `Option<Res<LaneletGraph>>`
- Test: `#[cfg(test)] mod tests` in `pathfinding.rs` (+ keep the 3 existing `lane_pathfinding` tests green)

**Interfaces:**
- Produces: `pub fn find_route(flag: bool, lg: &LaneGraph, llg: &LaneletGraph, ctx: &LaneCostCtx, start: LaneId, goal: LaneId) -> (Vec<TilePos>, Vec<(usize, IntersectionId, LaneletId)>)` — the sidecar carries the cursor offset (from `flatten`, Task 5) so Task 7 stores `(offset, intersection, lanelet)` directly. Flag-off returns an empty sidecar.

- [ ] **Step 1: Write the failing test**:
```rust
#[test]
fn find_route_flag_off_matches_legacy_flag_on_emits_sidecar() {
    // flag=false: find_route tiles == lane_path_to_tiles(find_lane_path(...)), sidecar empty.
    // flag=true on a turn route: non-empty sidecar; the pre-intersection tiles sit in the legal turn lane.
    // empty combined result with flag on: returns (vec![], vec![]) so the caller's road-A* fallback fires.
}
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — `find_route`: flag off → `(lane_path_to_tiles(find_lane_path(lg, ctx, start, goal), lg), vec![])`; flag on → `find_combined_path` then `flatten` (return tiles + the offset sidecar); empty → `(vec![], vec![])`. At `spawn.rs:99-130`, replace the block with a single `find_route(cfg.experimental_lanelet_intersections, lg, llg, &lane_ctx, start_lane, goal_lane)` call; KEEP the per-trip `jitter_seed` draw (:96), `LaneCostCtx` (:103), the road-A* fallback (:115-128) when the route is empty, and the `max_route_plans_per_tick` guard (:51 — still one plan per trip). Pass `llg` via `Option<Res<LaneletGraph>>` (default empty when the resource is absent — avoid unwrap). Ensure the `SimRng` draw order is identical flag-on vs off (the jitter_seed is drawn the same way regardless).
- [ ] **Step 4: Run, verify pass.** The existing 3 `lane_pathfinding` tests + the spawn path must stay green flag-off.
- [ ] **Step 5: Commit** — `feat(traffic): find_route flag seam selects lanelet routing at spawn`

---

### Task 7: `VehicleLaneletPlan` component + spawn wiring

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/components.rs` (add component + re-export)
- Modify: `crates/simcity_sim/src/game/traffic/spawn.rs` (insert at the spawn command ~:222; overwrite on parked-car reuse ~:166)
- Test: `#[cfg(test)] mod tests` (spawn test) or `pathfinding.rs`

**Interfaces:**
- Produces: `#[derive(Component, Default)] pub struct VehicleLaneletPlan { pub entries: Vec<(usize, IntersectionId, LaneletId)> }` (cursor_offset, intersection, lanelet — sorted ascending by cursor_offset).

- [ ] **Step 1: Write the failing test**:
```rust
#[test]
fn spawned_turn_vehicle_carries_sorted_lanelet_plan() {
    // flag-on spawn through a turn: the vehicle entity has VehicleLaneletPlan whose entries are
    // ascending by cursor_offset and whose offsets index lanelet internal_path starts in the
    // vehicle's actual interned route (path_pool.get_tile(handle, offset) == lanelet.internal_path[0]).
    // flag-off (or no lanelets): entries empty.
}
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — define the component; at the spawn `commands.spawn((...))` (~:222) attach `VehicleLaneletPlan { entries: sidecar }`; at the parked-car reuse path (~:166) overwrite the existing component's `entries`. `entries` come from `find_route` already ascending by offset (flatten appends in route order). Immutable for the trip.
- [ ] **Step 4: Run, verify pass.** Verification floor green.
- [ ] **Step 5: Commit** — `feat(traffic): VehicleLaneletPlan sidecar component`

---

### Task 8: Sidecar invalidation on mid-trip reroute (P0)

**Files:**
- Modify (clear `VehicleLaneletPlan.entries` when flag-on at each tile-A* re-intern site): `crates/simcity_sim/src/game/traffic/intersection/connectors.rs:316`, `crates/simcity_sim/src/game/traffic/stuck.rs:162,236`, `crates/simcity_sim/src/game/traffic/swap_break.rs:252`, `crates/simcity_sim/src/game/traffic/lane_change.rs:350`, `crates/simcity_sim/src/game/traffic/lane_change/planning.rs:418`
- Modify: `crates/simcity_sim/src/game/traffic.rs:403-413` (gate the legacy connector rewrite off under the flag)
- Test: `#[cfg(test)] mod tests` near `stuck.rs` / `swap_break.rs`

**Interfaces:**
- Consumes: `VehicleLaneletPlan` (Task 7), the flag.
- Produces: each re-intern site clears `entries` (flag-on); `mark_vehicles_needing_connector_rewrite`/`rewrite_marked_intersection_connectors` produce no rewrites under the flag.

- [ ] **Step 1: Write the failing test**:
```rust
#[test]
fn reroute_clears_lanelet_plan_and_connector_rewrite_is_disabled_under_flag() {
    // flag on. Give a vehicle a non-empty VehicleLaneletPlan, force a stuck reroute (stuck.rs path)
    // that re-interns its route; assert entries.is_empty() afterward. Same for a swap_break re-intern.
    // Assert mark_vehicles_needing_connector_rewrite marks nothing when the flag is on.
}
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — at each of the 6 re-intern sites, when the flag is on, after re-interning the new route set `plan.entries.clear()` (query the entity's `VehicleLaneletPlan` mutably where the re-intern happens; if a site lacks access, thread the component in). Gate `mark_vehicles_needing_connector_rewrite` + `rewrite_marked_intersection_connectors` with `.run_if(|c: Res<TrafficConfig>| !c.experimental_lanelet_intersections)` (or an early-return) so the legacy per-vehicle connector rewrite doesn't fight lanelet routing. AUDIT all 6 sites — a missed one leaves a stale offset.
- [ ] **Step 4: Run, verify pass.** Verification floor green.
- [ ] **Step 5: Commit** — `fix(traffic): clear lanelet sidecar on reroute + disable legacy connector rewrite under flag`

---

### Task 9: BRP observability

**Files:**
- Modify: `crates/simcity_debug/src/game/debug_world.rs` (extend `DebugLaneletState`; add `LaneletRouteStats` resource + a flat `DebugLaneletRouteState` mirror + update system + registration)
- Modify: `crates/simcity_sim/src/game/transport/lanelet/pathfinding.rs` (increment stats in `find_route`) + the invalidation sites (Task 8) increment `plans_cleared_on_reroute`
- Test: `#[cfg(test)] mod tests` (mirror reflects counts)

**Interfaces:**
- Produces: `DebugLaneletState.entry_lane_index_size: u32`; `#[derive(Resource, Default)] pub struct LaneletRouteStats { pub lanelet_routes_built: u64, pub fallback_to_road: u64, pub plans_cleared_on_reroute: u64 }`; flat `#[derive(Component, Reflect, Default)] pub struct DebugLaneletRouteState { ... same 3 counters ... }` registered like the sibling mirrors (do NOT register `LaneletRouteStats` itself or any complex type).

- [ ] **Step 1: Write the failing test** — mirror reflects the stats after spawning flag-on vehicles (follow the `DebugLaneletState` test pattern from Phase 1 Task 7).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — add `entry_lane_index_size` to `DebugLaneletState` (fill `= by_entry_lane.len()` in its update system); add `LaneletRouteStats` resource (`init_resource`); increment `lanelet_routes_built`/`fallback_to_road` in `find_route` (needs the resource — either pass it into the spawn system and increment there, or make `find_route` return which branch it took and increment at the call site to keep the pure fn pure — prefer the latter); increment `plans_cleared_on_reroute` at the Task-8 sites; add the flat `DebugLaneletRouteState` mirror + update system + `register_type` + attach to the debug entity, mirroring Phase 1 Task 7. F8/F9 RON dump surfaces them.
- [ ] **Step 4: Run, verify pass.** Full workspace verification floor green.
- [ ] **Step 5: Commit** — `feat(debug): BRP lanelet route stats + entry-lane index size`

---

## Phase 2 exit criteria
- `cargo fmt --all` clean, `cargo clippy --all-targets --all-features -- -D warnings` clean, `cargo test` green.
- Flag OFF: routes + RNG stream byte-identical to today; existing `lane_pathfinding` tests green; no behavior change.
- Flag ON: spawned vehicles get lanelet routes (sidecar non-empty for turns), pre-intersection tiles land in the legal turn lane, the heuristic keeps A* expansion bounded (no Dijkstra blow-up), and every reroute clears the sidecar. Observe via BRP `DebugLaneletRouteState`: `lanelet_routes_built > 0`, `plans_cleared_on_reroute` increments on forced reroutes.
- No `SaveGameV3` change.

## Open tuning knobs (set at plan-execution time, in `pathfinding.ron` / `TrafficConfig`)
- `turn_penalty` (default 80) — set vs lanelet internal-path cost so ENTER ≈ going-straight; too low over-prefers turns.
- `lane_change_penalty` (default 40) — how far upstream merges are placed; higher = earlier/spread-out (fewer tile-swap pileups).
- lanelet internal-tile base cost — flat const vs entry-lane kind base; MUST stay off live congestion (admissibility).
- `MIN_PER_TILE_BASE` — global 7 (safe) vs min-over-present-kinds (tighter `h`, optional later tightening).

## Roadmap (later phases, their own plans)
- **Phase 3:** `IntersectionLedger` + `arbitrate_lanelet_reservations` (consumes `VehicleLaneletPlan`) + ПДД readiness (signalized/uncontrolled) + global acyclic progress order + reserved-exit-slot + soft Approaching reservations + the DEFERRED mandatory-merge enforcement + reroute-from-actual-lane.
- **Phase 4:** pedestrian crosswalk conflict rows + protected-left phases + band-aid deletion (keep `INTERSECTION_STALL_FORCE_TICKS` as a tripwire) + live stress/A-B verification before flipping the default.
