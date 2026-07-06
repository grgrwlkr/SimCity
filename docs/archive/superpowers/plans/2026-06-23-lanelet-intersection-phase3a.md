# Lanelet Intersection — Phase 3a: Matrix Correctness + Ledger + Atomic Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Behind the `experimental_lanelet_intersections` flag, make the conflict matrix lane-faithful + pedestrian-aware, then stand up the `IntersectionLedger` + atomic admission + a deterministic per-intersection arbiter (stub ПДД readiness) that writes the SAME `is_reserved_by` truth `move_vehicles` reads — collision-safe by construction, on open-drainable maps, with NO gameplay change when the flag is off.

**Architecture:** Phase 3 is the behavioral phase, split into P3a (this plan, the foundation + admission substrate), P3b (full ПДД readiness + lights + pedestrian activation + protected-left), P3c (liveness: ORD-DAG + ring-free topology invariant + cross-feeder fairness + sidecar clears + mandatory-merge + graph-edit safety). P3a delivers: lane-faithful `build_internal_path` (parallel lanes no longer falsely conflict), pedestrian crosswalk pseudo-lanelets as first-class matrix rows, an `IntersectionLedger` (active_mask BitSet of held conflict points + persistent per-exit-lane reserved slots), an atomic admission predicate `(matrix.row(L) & active_mask)==0 AND exit_slot_reservable AND downstream-headroom`, a single deterministic arbiter sweeping intersections in ascending `IntersectionId` order with GRANT-ON-ENTRY-ONLY, and BRP observability. The arbiter writes the shared `IntersectionReservations` truth so `move_vehicles`/`drive.rs` is unforked.

**Tech Stack:** Rust 1.96 (edition 2024), Bevy 0.19. Crates `simcity_sim` (+ `simcity_core` roads, `simcity_debug` BRP). Tests co-located.

**Spec:** `docs/superpowers/specs/2026-06-22-lanelet-intersection-architecture-design.md` (§3 invariants, §S4 ledger, §S6 ПДД). Prior: Phase 1/2 plans.

## Global Constraints

- Toolchain `1.96.0`, edition `2024`. Verification floor: `cargo fmt --all` → `cargo clippy --all-targets --all-features -- -D warnings` → `cargo test`.
- **FLAG OFF = BYTE-IDENTICAL.** With `experimental_lanelet_intersections == false`: the legacy `collect_/apply_intersection_reservation_candidates` run (gated ON when flag off), the arbiter does NOT run, routes + SimRng draw order unchanged. The ONLY allowed flag-off effect is inert empty/derived data not read by any running system. (Lane-faithful `build_internal_path` + ped rows change the matrix + flag-ON route geometry only; the matrix is consumed only flag-on by P3+.)
- **Shared admission contract:** the arbiter writes the SAME `IntersectionReservations` such that `is_reserved_by(id, entity)` (reservations.rs:57) returns identically — `move_vehicles` / `drive.rs` entry gate (drive.rs:273-293) is NOT forked. Exactly one producer per tick via `run_if`.
- **Decisions (locked):** (1) **ring-free topology** — liveness will be pure by-construction (no surviving force-admit valve); the closed-ring residual is closed in P3c by a topology invariant (every cluster has ≥1 exit to open road) enforced at zone_placement/road-edit. P3a keeps `INTERSECTION_STALL_FORCE_TICKS` as a tripwire only (arbiter never increments it). (2) **pedestrians first-class in the matrix** — crosswalk pseudo-lanelets get real conflict rows (this plan, structural); ped-crossing → row-activation wires in P3b. (3) **lane-faithful internal paths** — `build_internal_path` offsets by lane so parallel/opposite lanes don't share cells; throughput parity vs legacy is an acceptance gate. (4) **exit-slot `ArrayVec` cap N = 4** (headroom over the current `capacity_per_lane_tile()`=2).
- **Determinism:** seeded `SimRng` / stable integer keys only; sweep intersections by ascending `IntersectionId.0` (NOT a HashMap iteration, NOT width — width has ties); sort candidates by `(priority desc, dist asc, entity.to_bits asc)`; every non-commutative write (exit-slot push, safety-net insert, par-merge consume) is `entity.to_bits`-sorted. `active_mask` is an OR-fold over holders, never XOR.
- **Honest deadlock-freedom claim (post-adversary):** collision-safe + bounded-box UNCONDITIONALLY by construction (S1 mask soundness, S2 reserved exit slot); deadlock-free by construction for open-drainable topologies (P3c DAG); the closed-ring residual is eliminated by the P3c ring-free topology invariant. P3a establishes SAFETY; LIVENESS lands in P3c.
- No `SaveGameV3` change. No complex-type BRP reflect registration (flat scalar mirrors only — registering complex types empties the test city on load). par_iter for the read-only candidate scan; the grant sweep is sequential per the determinism rule.
- Style: match existing `traffic/intersection/` + `transport/lanelet/` patterns; no narrating comments; smallest change.

---

### Task 1: Lane-faithful `build_internal_path` (lane-side offset)

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/lanelet/build.rs` (the BFS generator + its 5 tests)
- Test: `#[cfg(test)] mod tests` in `build.rs`

**Interfaces:**
- Consumes: `build_internal_path(cluster_tiles, entry_tile, exit_tile)` (Phase-1).
- Produces: the generated internal path now keeps a lane-distinct cell sequence so two parallel same-direction lanelets (and opposite-direction straights) through a multi-tile cluster do NOT share internal tiles. Signature may extend to take the entry/exit lane cross-section index (`lane_idx`) to compute the lateral offset — `build_internal_path(cluster_tiles, entry_tile, exit_tile, lane_offset: i32)` or derive the offset from entry/exit positions. Keep strictly 4-adjacent.

- [ ] **Step 1: Write the failing test** — on the chronic 4×6 cluster, two parallel eastbound through lanes produce DISJOINT internal paths:
```rust
#[test]
fn parallel_through_lanes_take_disjoint_internal_paths() {
    // 4x6 cluster (x 31..=34, y 61..=66). Two eastbound approaches on adjacent rows (y=63, y=64),
    // each going straight through to the west side on its own row.
    let cluster: HashSet<TilePos> = (31..=34).flat_map(|x| (61..=66).map(move |y| TilePos{x,y})).collect();
    let p_a = build_internal_path(&cluster, TilePos{x:34,y:63}, TilePos{x:30,y:63}, /*offset for row 63*/).unwrap();
    let p_b = build_internal_path(&cluster, TilePos{x:34,y:64}, TilePos{x:30,y:64}, /*offset for row 64*/).unwrap();
    let sa: HashSet<_> = p_a.iter().collect();
    assert!(p_b.iter().all(|t| !sa.contains(t)), "parallel lanes must not share internal tiles");
    // still 4-adjacent:
    for w in p_a.windows(2) { assert_eq!((w[1].x-w[0].x).abs()+(w[1].y-w[0].y).abs(),1); }
}
```

- [ ] **Step 2: Run, verify fail** — today both share the single BFS corridor (verified build.rs:52-107).
- [ ] **Step 3: Implement** — make the BFS lane-faithful: bias the path to the row/column matching the entry/exit lane's cross-section (e.g. prefer cells whose lateral coordinate matches the straight-through lane, or compute a per-lanelet offset corridor). A straight maneuver keeps its lane row; turns cross between the entry row and the exit column. Preserve the orthogonal/no-diagonal property and the deterministic (x,y) tiebreak.
- [ ] **Step 4: Run, verify pass.** UPDATE the 5 existing `build_internal_path` tests for the new geometry (they assert specific paths; re-derive the expected paths — the orthogonality/inside-cluster/entry-start invariants must still hold). Verification floor green.
- [ ] **Step 5: Commit** — `feat(transport): lane-faithful lanelet internal paths (parallel lanes don't share cells)`

---

### Task 2: Throughput-parity gate — matrix doesn't over-report parallel straights

**Files:**
- Test: `#[cfg(test)] mod tests` in `transport/lanelet/build.rs` (App-level build of a multi-lane cluster) or `conflict.rs`

**Interfaces:**
- Consumes: `build_lanelet_graph` + `ConflictMatrix` (Phase 1/2) with the now lane-faithful paths (Task 1).
- Produces: test only — proves the acceptance gate (no whitelist needed because paths are lane-faithful).

- [ ] **Step 1: Write the failing test** — build the lanelet graph for a multi-lane cross; assert an N-bound straight and an S-bound straight (and two parallel E-bound straights) do NOT conflict in the matrix:
```rust
#[test]
fn opposite_and_parallel_straights_do_not_conflict() {
    // build a 2-lane-each-way cross intersection; get its ConflictMatrix.
    // find the N-straight and S-straight lanelets; assert !matrix.conflicts(ns, sn).
    // find two parallel E-straight lanelets (different rows); assert !matrix.conflicts(e0, e1).
    // a crossing pair (N-straight vs E-straight) MUST still conflict.
}
```

- [ ] **Step 2: Run, verify fail** if Task 1 is incomplete (shared corridor → false conflict).
- [ ] **Step 3:** No new impl — this gate passes once Task 1 is correct. If it fails, Task 1's offset logic is incomplete; fix there.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `test(transport): matrix throughput-parity gate for non-crossing straights`

---

### Task 3: Pedestrian crosswalk cells per cluster

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/lanelet/build.rs` (crosswalk derivation)
- Test: `#[cfg(test)] mod tests` in `build.rs`

**Interfaces:**
- Produces: `pub(crate) fn crosswalk_cells(cluster: &IntersectionCluster, grid: &MapGrid) -> Vec<(CrosswalkId, Vec<TilePos>)>` — per cluster approach, the set of cluster-edge cells a pedestrian crosses (derived from cluster geometry + the approach directions). `CrosswalkId` is a per-cluster local index. Deterministic.

- [ ] **Step 1: Write the failing test** — a 4-way cross yields one crosswalk per approach, each a contiguous cell set on the cluster boundary perpendicular to the approach:
```rust
#[test]
fn crosswalk_cells_one_per_approach_on_cluster_edge() {
    // build a 4-way cross cluster; crosswalk_cells returns 4 crosswalks (one per approach),
    // each a non-empty set of cluster-boundary cells; deterministic across calls.
}
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — derive crosswalk cells from cluster geometry (the boundary cells facing each approach road). Deterministic ordering.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(transport): derive pedestrian crosswalk cells per intersection cluster`

---

### Task 4: Pedestrian pseudo-lanelets as first-class matrix rows

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/lanelet/conflict.rs` (extend the matrix to include ped rows) + `build.rs` (pass crosswalk cells into the matrix build)
- Test: `#[cfg(test)] mod tests` in `conflict.rs`

**Interfaces:**
- Produces: `ConflictMatrix::from_paths_with_crosswalks(lanelet_paths: &[Vec<TilePos>], crosswalk_cells: &[Vec<TilePos>]) -> Self` — crosswalks become extra rows appended after the vehicle lanelets; a vehicle lanelet conflicts with a crosswalk iff their cells overlap. The matrix exposes `crosswalk_base(): usize` (the index where crosswalk rows begin) so the arbiter can OR a crosswalk's row into `active_mask` when a pedestrian occupies it (wired in P3b). `LaneletConflictMatrices` build wires crosswalk cells from Task 3.

- [ ] **Step 1: Write the failing test**:
```rust
#[test]
fn vehicle_lanelet_conflicts_with_crossed_crosswalk() {
    // a straight lanelet path [(0,0),(1,0)] and a crosswalk [(1,0),(1,1)] share (1,0).
    let m = ConflictMatrix::from_paths_with_crosswalks(&[vec![TilePos{x:0,y:0},TilePos{x:1,y:0}]], &[vec![TilePos{x:1,y:0},TilePos{x:1,y:1}]]);
    let cw = m.crosswalk_base(); // index of the first crosswalk row
    assert!(m.conflicts(0, cw), "vehicle lanelet crossing the crosswalk must conflict with it");
    // a non-crossing crosswalk does not conflict.
}
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — extend `from_paths` to append crosswalk paths as additional rows (same tile-overlap logic). Record `crosswalk_base`. Wire `build_lanelet_graph` to pass `crosswalk_cells` (Task 3). Keep determinism + the `Vec<u64>` bitset.
- [ ] **Step 4: Run, verify pass.** Full suite + clippy.
- [ ] **Step 5: Commit** — `feat(transport): pedestrian crosswalks as first-class conflict-matrix rows`

---

### Task 5: Width-priority `is_main_road` via `RoadKind.lanes()`

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/pdd_check.rs` (is_main_road) + `crates/simcity_core/src/game/roads.rs` (ensure a width key — `lanes()` or equivalent that distinguishes kinds)
- Test: `#[cfg(test)] mod tests` in `pdd_check.rs`

**Interfaces:**
- Produces: `is_main_road(self_kind, other_kind) -> bool` using a width key that distinguishes `SixLane > FourLane > TwoLane` (NOT `capacity_per_lane_tile()`, which collapses all to 2). If `RoadKind` lacks a `lanes()` accessor, add one returning the cross-section lane count (TwoLane→2, FourLane→4, SixLane→6 — confirm against roads.rs).

- [ ] **Step 1: Write the failing test**:
```rust
#[test]
fn main_road_is_the_wider_kind() {
    assert!(is_main_road(RoadKind::SixLane, RoadKind::TwoLane));
    assert!(is_main_road(RoadKind::FourLane, RoadKind::TwoLane));
    assert!(!is_main_road(RoadKind::TwoLane, RoadKind::FourLane));
    assert!(!is_main_road(RoadKind::TwoLane, RoadKind::TwoLane)); // equal width: not main
}
```
(This FAILS today: `capacity_per_lane_tile` is 2 for all → all equal → false. Verified roads.rs:55-58.)

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — add/confirm `RoadKind::lanes()`; rewrite `is_main_road` to compare `lanes()`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `fix(traffic): width-based is_main_road via RoadKind::lanes (not per-lane capacity)`

---

### Task 6: `upcoming_lanelet_at` sidecar consumer helper

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/components.rs` (helper on VehicleLaneletPlan)
- Test: `#[cfg(test)] mod tests` in `components.rs`

**Interfaces:**
- Produces: `impl VehicleLaneletPlan { pub fn upcoming_lanelet_at(&self, cursor: usize) -> Option<(IntersectionId, LaneletId)> }` — returns the lanelet whose `cursor_offset == cursor + 1` (the vehicle is one tile before entering it), via a search over `entries` (ascending). `None` if no entry matches (empty plan or not at a lanelet seam).

- [ ] **Step 1: Write the failing test**:
```rust
#[test]
fn upcoming_lanelet_resolves_at_offset_minus_one() {
    let plan = VehicleLaneletPlan { entries: vec![(3, IntersectionId(7), LaneletId(2)), (9, IntersectionId(8), LaneletId(5))] };
    assert_eq!(plan.upcoming_lanelet_at(2), Some((IntersectionId(7), LaneletId(2)))); // cursor+1==3
    assert_eq!(plan.upcoming_lanelet_at(5), None);
    assert_eq!(VehicleLaneletPlan::default().upcoming_lanelet_at(0), None);
}
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — `entries.iter().find(|(off,_,_)| *off == cursor + 1).map(|(_,i,l)| (*i,*l))`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(traffic): VehicleLaneletPlan::upcoming_lanelet_at consumer helper`

---

### Task 7: `IntersectionLedger` + exit slots + atomic `try_admit`

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/reservations.rs` (add ledger + exit_slots fields + methods)
- Modify: `crates/simcity_sim/src/game/transport/lanelet/conflict.rs` (a `rows_overlap(&[u64], &[u64]) -> bool` helper if not present)
- Test: `#[cfg(test)] mod tests` in `reservations.rs`

**Interfaces:**
- Produces:
  - `IntersectionReservations.ledger: HashMap<IntersectionId, IntersectionLedger>` + `exit_slots: HashMap<usize /*tile idx*/, ArrayVec<Entity, 4>>` (N=4).
  - `struct IntersectionLedger { active_mask: Vec<u64>, holders: Vec<(Entity, u32 /*local lanelet idx*/)>, built_for_version: u64 }`.
  - `fn rows_overlap(a: &[u64], b: &[u64]) -> bool` (bitwise-AND any word nonzero).
  - `IntersectionLedger::try_admit(&mut self, local_idx, row: &[u64]) -> bool` (admit iff `!rows_overlap(row, &active_mask)`; on success OR the row in + push holder).
  - `IntersectionLedger::release(&mut self, entity)` → remove holder + `rebuild_active_mask` (OR-fold over remaining holders' rows — needs the matrix; pass it or store rows).
  - `try_acquire_exit_slot(exit_tile_idx, cap, entity) -> bool` (push to the ArrayVec iff `phys_occ + slots.len() < cap`); slots are PERSISTENT (never reseeded), popped only when the holder physically occupies the tile.
  - `is_reserved_by` unchanged (still membership in `by_intersection`).

- [ ] **Step 1: Write the failing test**:
```rust
#[test]
fn ledger_atomic_admit_and_or_fold_release() {
    // matrix with rows: 0 conflicts 1, 0 disjoint from 2.
    // try_admit(0) ok; try_admit(1) fails (conflicts 0); try_admit(2) ok.
    // release(holder of 0); active_mask == OR-fold of {2} only (bit for 1 now admittable).
    // exit slot: cap=2, two acquires ok, third fails; pop on occupy frees one.
}
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the structs + methods. `active_mask` OR-fold (never XOR — shared bits). exit_slots persistent. cap read from `RoadKind::capacity_per_lane_tile()` at runtime, ArrayVec compile cap N=4.
- [ ] **Step 4: Run, verify pass.** Confirm `is_reserved_by` byte-identical (existing reservation tests pass).
- [ ] **Step 5: Commit** — `feat(traffic): IntersectionLedger atomic admission + persistent exit slots`

---

### Task 8: `ordered_intersection_ids` + `ArbiterIndexCache`

**Files:**
- Create: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (+ `mod arbiter;` in intersection module)
- Test: `#[cfg(test)] mod tests` in `arbiter.rs`

**Interfaces:**
- Produces:
  - `pub(crate) fn ordered_intersection_ids(llg: &LaneletGraph) -> Vec<IntersectionId>` — `sort_unstable_by_key(|id| id.0)` (strict ascending, the ORD for the P3c DAG; NOT width).
  - `#[derive(Resource, Default)] struct ArbiterIndexCache { version: u64, local_idx: HashMap<IntersectionId, HashMap<LaneletId, usize>>, priority_road_class: HashMap<IntersectionId, u8> }` + `ensure_built_for(version, llg, grid)` (rebuild only when `matrices.version` changes; `priority_road_class` via `RoadKind::lanes()`).

- [ ] **Step 1: Write the failing test**:
```rust
#[test]
fn ordered_ids_ascending_and_cache_rebuilds_on_version() {
    // ordered_intersection_ids strictly ascending by .0.
    // ArbiterIndexCache built for v1; local_idx maps each LaneletId to its matrix local index;
    // bump to v2 -> ensure_built_for rebuilds; stale v1 not reused.
}
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** local_idx derived from `llg.by_intersection[id]` ordering (must match the matrix row order — guarded by Task 2/the build alignment).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(traffic): arbiter ordered intersection ids + index cache`

---

### Task 9: `arbitrate_lanelet_reservations` skeleton (stub readiness, GRANT-ON-ENTRY-ONLY)

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (the system) + `traffic.rs` (registration, flag-gated)
- Test: `#[cfg(test)] mod tests` in `arbiter.rs`

**Interfaces:**
- Produces: `pub(crate) fn arbitrate_lanelet_reservations(...)` — collects candidates (par_iter read-only over non-parked vehicles approaching a cluster, resolving their lanelet via `VehicleLaneletPlan::upcoming_lanelet_at` (Task 6)), partitions by `IntersectionId`, sweeps in `ordered_intersection_ids` order; for each, sorts candidates `(priority desc, dist asc, entity.to_bits asc)` and atomically grants via `try_admit` + `try_acquire_exit_slot` + `downstream_link_has_headroom`. STUB readiness: ready iff (signalized → light green/yellow for entry_dir) OR uncontrolled. GRANT-ON-ENTRY-ONLY: only insert the `Inside`-bound reservation row when the vehicle's next move enters the box and it's unblocked. In-box safety-net: a vehicle physically on a cluster tile lacking a row gets a `tiles: vec![cur]` row (re-implements collect's reservations.rs:560-591 since legacy collect is gated off under the flag).

- [ ] **Step 1: Write the failing test**:
```rust
#[test]
fn arbiter_admits_nonconflicting_serializes_conflicting() {
    // flag-on small 2-arm cluster: two non-conflicting cars both get reservations same tick;
    // two conflicting cars -> exactly one row granted; the in-box rowless car gets a safety-net row.
}
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the system. Sequential grant per intersection (determinism). NEVER increment `stall_ticks` (tripwire stays 0).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(traffic): lanelet reservation arbiter skeleton (stub readiness)`

---

### Task 10: Flag seam + exit-slot release in cleanup + tripwire

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic.rs` (system registration) + `reservations.rs` (cleanup)
- Test: `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `collect_/apply_intersection_reservation_candidates` gated `run_if(legacy_connectors_enabled)` (already the flag-off predicate from P2 Task 8 — reuse it / rename to a shared `legacy_intersection_pipeline_enabled`); `arbitrate_lanelet_reservations` gated `run_if(flag)` in the apply slot, `.before(move_vehicles)`; `cleanup_intersection_reservations` pops `exit_slots` when the holder's `cur == exit_tile`.

- [ ] **Step 1: Write the failing test**:
```rust
#[test]
fn flag_seam_one_producer_and_tripwire_empty() {
    // flag-off: legacy collect/apply run, arbiter does not; existing reservation tests pass.
    // flag-on: arbiter is the sole producer; over N ticks on an open-drainable map, reservations.stall_ticks stays empty (tripwire).
}
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the `run_if` wiring + cleanup release. Cleanup runs `.after(move_vehicles)` (end of tick N), arbiter `.before(move_vehicles)` (start N+1) → release-before-next-grant. (No reseed; slots persistent.)
- [ ] **Step 4: Run, verify pass.** Existing traffic tests green flag-off.
- [ ] **Step 5: Commit** — `feat(traffic): flag seam — arbiter sole producer when flag on, legacy when off`

---

### Task 11: Determinism test + `DebugArbiterLedgerState` BRP mirror

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (determinism test + entity-sorted writes) + `crates/simcity_debug/src/game/debug_world.rs` (mirror)
- Test: `#[cfg(test)] mod tests`

**Interfaces:**
- Produces:
  - Determinism: every non-commutative write (`exit_slots` push, safety-net insert, par-merge consume) is `entity.to_bits`-sorted; a test runs the arbiter twice on a cloned seeded world and asserts identical `exit_slots` membership + `by_intersection` rows.
  - `#[derive(Component, Reflect, Default)] struct DebugArbiterLedgerState { admitted_this_tick: u32, refused_this_tick: u32, held_points_max: u32, reserved_exit_slots: u32, max_approaching_age_ms: u32, stall_tripwire_fired: u32 }` (flat scalars; `ring_force_admits` field reserved but unused until P3c) + update system in `GameSet::Ui` + `register_type` + `ensure_component` (mirror the `DebugLaneletState` pattern; do NOT reflect-register complex types).

- [ ] **Step 1: Write the failing tests** (determinism twice-run identical; mirror reflects admitted_this_tick>0 + stall_tripwire_fired==0 flag-on).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the entity-sorted writes + the flat mirror.
- [ ] **Step 4: Run, verify pass.** Full workspace verification floor.
- [ ] **Step 5: Commit** — `feat(debug): arbiter determinism guard + DebugArbiterLedgerState BRP mirror`

---

## Phase 3a exit criteria
- `cargo fmt` clean, `cargo clippy --all-targets --all-features -- -D warnings` clean, `cargo test` green.
- Flag OFF: byte-identical (legacy pipeline runs; existing tests pass; routes + RNG unchanged).
- Flag ON: the arbiter is the sole admission producer, admits via the lane-faithful geometric matrix + persistent exit slots, GRANT-ON-ENTRY-ONLY, sweeps intersections in ascending id order, writes the shared `is_reserved_by` truth, never increments `stall_ticks` (tripwire empty on open-drainable maps), and is deterministic (twice-run identical). Collision-safe by construction (matrix AND). Parallel/opposite straights don't falsely conflict (throughput parity). Pedestrian crosswalks have matrix rows (activation in P3b). Observable via BRP `DebugArbiterLedgerState`.
- No `SaveGameV3` change.

## Roadmap (own plans)
- **P3b — ПДД readiness + lights + ped activation:** replace the stub readiness with `lanelet_readiness` (width-priority, помеха-справа, RTOR, signalized), protected-left `LightPhase` extension + actuation + max-staleness, pedestrian row-ACTIVATION (OR a crosswalk's matrix row into `active_mask` while a ped crosses) + ped-phase max-staleness.
- **P3c — Liveness + ring-free topology + clears + merge + graph-edit:** the ORD-DAG liveness argument; the ring-free TOPOLOGY INVARIANT (every cluster has ≥1 open-road exit, enforced at zone_placement/road-edit) which closes the closed-ring residual and lets the `stall_ticks` valve be DELETED (tripwire-only confirmed); cross-feeder exit-slot fairness; the 5 mid-trip sidecar clears; precise-fallback for cleared plans; mandatory-merge / reroute-from-actual-lane; graph-edit migration of in-flight INSIDE holders. This is where deadlock-freedom is fully closed.
