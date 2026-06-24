# Lanelet Intersection — Phase 3b: Full ПДД Readiness + Lights + Pedestrian Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Behind the `experimental_lanelet_intersections` flag, replace the P3a stub readiness/priority of `arbitrate_lanelet_reservations` with full ПДД: signalized green/yellow/all-red + right-turn-on-red, width-priority main-road + помеха-справа for uncontrolled, pedestrian crosswalk row-activation in the ledger, and a demand-actuated protected-left light phase — all collision-safe by construction, with NO gameplay change when the flag is off.

**Architecture:** P3b is the behavioral ПДД layer on top of P3a's admission substrate. The arbiter's per-candidate `ready: bool` and `priority: u8` become a real `lanelet_readiness` (signalized/RTOR/all-red/uncontrolled) and a width-aware ПДД priority; помеха-справа is a deterministic pairwise tiebreak inside the per-intersection grant sweep. Pedestrians stay first-class in the geometric matrix: an active `PedestrianCrossing` ORs the crossed crosswalks' INDEX bits into a per-tick `ped_mask` that the ledger ANDs alongside `active_mask`, so a vehicle lanelet crossing an occupied crosswalk fails `try_admit`. A new protected-left `LightPhase` pair gives left turns an exclusive interval, inserted into the cycle only when left-turn demand exists. Liveness (ring-free topology, drain, mandatory-merge) remains P3c.

**Tech Stack:** Rust 1.96 (edition 2024), Bevy 0.19. Crates `simcity_sim` (`traffic/intersection`, `transport/lanelet`, `intersections/lights`, `pedestrians`) + `simcity_debug`. Tests co-located.

**Spec:** `docs/superpowers/specs/2026-06-22-lanelet-intersection-architecture-design.md` (§S6 ПДД). Prior: P3a plan (`2026-06-23-lanelet-intersection-phase3a.md`) — establishes the ledger (held-INDEX `active_mask`, `try_admit`, exit slots), the arbiter grant sweep, `crosswalk_cells` + `from_paths_with_crosswalks` + `crosswalk_base()`, `is_main_road`, `ArbiterIndexCache.priority_road_class`.

## Global Constraints

- Toolchain `1.96.0`, edition `2024`. Verification floor: `cargo fmt --all` → `cargo clippy --all-targets --all-features -- -D warnings` → `cargo test`.
- **FLAG OFF = BYTE-IDENTICAL.** With `experimental_lanelet_intersections == false`: the legacy `collect_/apply_intersection_reservation_candidates` (gated ON when flag off) and the legacy ped-yield / signalized logic run unchanged; the arbiter never runs; routes + SimRng draw order unchanged. New LightPhase variants must not change the light cycle when flag off (the protected-left phase is only ever inserted by the flag-on arbiter's demand signal — OR: it is inserted by the light controller regardless of flag but is behavior-neutral for the legacy admission path, which already treats any non-green/non-yellow as red; **choose: the protected-left phase is gated so it is only inserted when the flag is on** — see Task 6).
- **Collision-safety preserved.** Admission remains `!rows_overlap(matrix.row(L), active_mask | ped_mask)` — the geometric matrix AND is the only collision gate. ПДД readiness/priority only changes WHICH non-conflicting candidate is granted and WHEN it is eligible; it never relaxes the matrix AND. Pedestrians block via real crosswalk index bits, never an out-of-band override.
- **Determinism.** Seeded `SimRng` / stable integer keys only. Ped-mask seeding ORs bits in a fixed crosswalk order. Помеха-справа tiebreak is a deterministic function of entry directions + a stable `entity.to_bits` final tiebreak (no cyclic non-determinism). Light-phase actuation reads stable per-tick demand counts. Sweep order unchanged (ascending `IntersectionId`).
- **No `SaveGameV3` change.** No complex-type BRP reflect registration (flat scalar mirrors only).
- **Tripwire stays 0.** The arbiter never increments `stall_ticks`. Ped/light staleness uses its own counters, never the legacy stall valve.
- Style: match existing `traffic/intersection/`, `intersections/lights.rs`, `transport/lanelet/` patterns; no narrating comments; smallest change. Reuse the legacy signalized/RTOR logic (`reservations.rs` collect, ~lines 854-907) as the reference for the ported arbiter readiness.

---

### Task 1: Signalized readiness + RTOR + all-red (port the stub)

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (replace the `ready` stub + extend the candidate with the fields RTOR needs)
- Test: `#[cfg(test)] mod tests` in `arbiter.rs`

**Interfaces:**
- Consumes: `ArbiterGrantCandidate` (P3a), `TrafficLight::{is_green,is_yellow,is_all_red}`, `VehicleTrafficState`, `intersections.traffic_lights`, the entry/exit dirs already computed in the wrapper.
- Produces: a free fn `pub(crate) fn lanelet_readiness(ctx) -> Readiness` where `Readiness { ready: bool, is_right_on_red: bool }`. Signalized: green/yellow for `entry_dir` → ready; all-red → not ready; red (not all-red) → ready ONLY as RTOR (vehicle `Stopped`/`WaitingForGreen` for THIS stop tile, `exit_dir == near-side turn dir`, matched to `drive_on_right`). Uncontrolled → ready (priority/yield handled in Task 2). The wrapper passes `state`, `cur` (stop tile), `entry_dir`, `exit_dir`, `drive_on_right`, the light, and whether the cluster is signalized.
- The candidate gains `is_right_on_red: bool` (the grant sweep already exists; RTOR additionally requires "only when the intersection is otherwise clear" — replicate the legacy `is_right_on_red && reservations.is_reserved(id) → skip` guard inside `arbitrate_grants_inner`).

- [ ] **Step 1: Write the failing test** — signalized cluster: a vehicle on green entry is ready; on red (non-RTOR maneuver) is not; on red doing a near-side right turn after stopping is ready-as-RTOR; during all-red nobody is ready.
```rust
#[test]
fn readiness_signalized_green_red_rtor_allred() { /* build TrafficLight phases; assert lanelet_readiness */ }
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `lanelet_readiness` + `Readiness`; wire it into the wrapper replacing the `let ready = …` stub; thread `is_right_on_red` into the candidate; add the RTOR "intersection must be clear" guard in `arbitrate_grants_inner` (skip RTOR candidate if `reservations.is_reserved(id)`).
- [ ] **Step 4: Run, verify pass.** Full suite + clippy.
- [ ] **Step 5: Commit** — `feat(traffic): arbiter signalized readiness + right-turn-on-red (replaces stub)`

---

### Task 2: Width-priority main-road + помеха-справа

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (candidate priority + a pairwise yield tiebreak in the grant sweep)
- Test: `#[cfg(test)] mod tests` in `arbiter.rs`

**Interfaces:**
- Consumes: `ArbiterIndexCache.priority_road_class` (P3a, max approach width per intersection), `RoadKind::lanes()` of the candidate's entry road (`grid.get(cur).road.kind`), `is_main_road`, `has_right_of_way_obstacle(entry_dir, other_entry_dir)` (pdd_check.rs).
- Produces: a layered priority where a candidate on the intersection's widest approach (`entry_lanes == priority_road_class[id]`) outranks narrower approaches, then maneuver (Straight > Right > Left), then a помеха-справа **direction-precedence rank** — all folded into the single `priority: u8` field so the sweep's `sort_by` stays a valid TOTAL order (`main_road_bonus*K2 + maneuver_rank*K1 + dir_rank`). помеха-справа is encoded as a fixed per-`entry_dir` precedence (a deterministic right-of-way approximation that is a total order, NOT a cyclic pairwise comparator — true 4-way simultaneous помеха-справа is undefined in ПДД and the ledger serializes conflicts regardless). The `entity.to_bits` remains the final tiebreak. Add `entry_dir: RoadDir` to the candidate for the rank computation.

- [ ] **Step 1: Write the failing test** — (a) a SixLane main-road straight outranks a TwoLane side-road straight; (b) for two equal-width conflicting approaches, the one with the other on its right yields (deterministic), and a 4-way equal cycle still grants exactly one (no panic / no deadlock).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the layered priority in the wrapper + the помеха-справа comparator in the sweep (only as a tiebreak among equal `priority`, never overriding width). Keep the sort total-ordered.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(traffic): width-priority main-road + помеха-справа yield in arbiter`

---

### Task 3: Crosswalk side metadata

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/lanelet/build.rs` (`crosswalk_cells` returns the side; `build_lanelet_graph` stores per-intersection crosswalk sides)
- Modify: `crates/simcity_sim/src/game/transport/lanelet/build.rs` (`LaneletConflictMatrices` gains `crosswalk_sides`)
- Test: `#[cfg(test)] mod tests` in `build.rs`

**Interfaces:**
- Produces: `crosswalk_cells` returns `Vec<(CrosswalkId, RoadDir /*side*/, Vec<TilePos>)>` (the cluster side each crosswalk faces). `LaneletConflictMatrices` gains `pub crosswalk_sides: HashMap<IntersectionId, Vec<RoadDir>>` (side per crosswalk in emission order — index `i` here corresponds to matrix row `crosswalk_base + i`). Build wires it. The arbiter maps a ped axis to crosswalk indices via these sides.

- [ ] **Step 1: Write the failing test** — on the 2x2 cross fixture, `crosswalk_cells` returns 4 crosswalks tagged `[West, East, South, North]`; the matrices' `crosswalk_sides[id]` matches in that order; a vehicle lanelet's matrix row that crosses the West crosswalk has the bit at `crosswalk_base + 0` set.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the side tag + storage; update the P3a crosswalk test for the new signature.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(transport): tag crosswalk side + store crosswalk_sides per intersection`

---

### Task 4: Ledger `ped_mask` (per-tick crosswalk activation)

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/reservations.rs` (`IntersectionLedger` gains `ped_mask` + seeding; `try_admit` ANDs against `active_mask | ped_mask`)
- Test: `#[cfg(test)] mod tests` in `reservations.rs`

**Interfaces:**
- Produces: `IntersectionLedger.ped_mask: Vec<u64>` (per-tick crosswalk-index bits; NOT holders — never persisted, never released). `clear_ped_mask(&mut self)` + `set_ped_crosswalk(&mut self, crosswalk_local_idx: usize)` (set the bit). `try_admit` admits iff `!rows_overlap(row, &self.active_mask) && !rows_overlap(row, &self.ped_mask)` (or pre-OR the two masks). `reset_for_version` also clears `ped_mask`. `active_points()` unchanged (held points only; ped bits are transient).

- [ ] **Step 1: Write the failing test** — a vehicle lanelet whose matrix row sets a crosswalk bit is refused while that crosswalk's `ped_mask` bit is set, and admitted after `clear_ped_mask`. A vehicle NOT crossing the active crosswalk still admits.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `ped_mask` + the two methods + the dual-overlap admission test.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(traffic): IntersectionLedger ped_mask — pedestrian crosswalk activation`

---

### Task 5: Pedestrian activation in the arbiter

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (seed each ledger's `ped_mask` from active `PedestrianCrossing` before the grant sweep)
- Test: `#[cfg(test)] mod tests` in `arbiter.rs`

**Interfaces:**
- Consumes: `Query<&PedestrianCrossing>` (id + `axis_ns`), `LaneletConflictMatrices.crosswalk_sides` + `crosswalk_base()`.
- Produces: before `arbitrate_grants_inner`, for each intersection: `clear_ped_mask`, then for each active `PedestrianCrossing(id, axis_ns)` set the bits for crosswalks whose side is in the active set (`axis_ns ⇒ {West,East}`, else `{North,South}`) at index `crosswalk_base + i`. A vehicle lanelet crossing an active crosswalk then fails `try_admit` (collision model). NO out-of-band yield. Pass the seeded ledger through the sweep. Add a small `ArbiterTickStats.ped_blocked_this_tick` counter (Task 7 mirrors it).

- [ ] **Step 1: Write the failing test** — flag-on small cluster: a `PedestrianCrossing(id, axis_ns=true)` blocks a vehicle whose lanelet crosses the West/East crosswalk, while a vehicle crossing only the North/South crosswalk is admitted; clearing the ped admits the blocked one next tick.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the seeding loop (deterministic crosswalk order) + `ped_blocked` count.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(traffic): pedestrian crosswalk activation seeds the arbiter ledger ped_mask`

---

### Task 6: Protected-left `LightPhase` + demand actuation

**Files:**
- Modify: `crates/simcity_sim/src/game/intersections/lights.rs` (new phases + cycle + is_* helpers)
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (readiness honours protected-left)
- Test: `#[cfg(test)] mod tests` in `lights.rs` and `arbiter.rs`

**Interfaces:**
- Produces: `LightPhase::{NorthSouthLeftProtected, EastWestLeftProtected}`; `TrafficLight::is_left_protected(dir) -> bool` (true for N/S dirs during NorthSouthLeftProtected, E/W during EastWestLeftProtected); the cycle inserts the protected-left interval BEFORE the matching green (`…AllRed → NorthSouthLeftProtected → NorthSouthGreen → …`) ONLY when actuated. **Actuation:** the light advance reads a per-tick left-turn demand signal (a `LeftTurnDemand` resource keyed by `IntersectionId`, populated flag-on by the arbiter from waiting left-turn candidates); with zero demand the protected-left phase is skipped (duration 0 / phase not entered). During a protected-left phase the arbiter readiness: left-turn lanelets from that axis → ready; opposing through → not ready (red); during a normal green, unprotected (permissive) left turns remain matrix-gated (the ledger blocks them vs opposing through). **Flag-off neutrality:** the protected-left phase is only entered when `LeftTurnDemand` is non-empty, which only the flag-on arbiter populates → flag-off the cycle is byte-identical (the new variants are never reached). Assert this with a flag-off cycle test.
- Consumes: arbiter writes `LeftTurnDemand` (a `Resource`), light controller reads it in `advance_traffic_lights`.

- [ ] **Step 1: Write the failing tests** — (a) cycle test: with non-empty demand the cycle visits `NorthSouthLeftProtected` before `NorthSouthGreen`; with empty demand (flag-off equivalent) the cycle is the original 6-phase sequence byte-identical; (b) readiness: during `NorthSouthLeftProtected` a N-bound left is ready and an opposing S-bound through is not.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the phases + `is_left_protected` + actuated cycle + `LeftTurnDemand` resource (arbiter populates flag-on) + readiness wiring.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(intersections): demand-actuated protected-left phase + arbiter readiness`

---

### Task 7: BRP observability + determinism guard

**Files:**
- Modify: `crates/simcity_debug/src/game/debug_world.rs` (`DebugArbiterLedgerState` += ped/readiness/protected-left scalars)
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (`ArbiterTickStats` += new counters; determinism test for ped + помеха-справа ordering)
- Test: `#[cfg(test)]` in both

**Interfaces:**
- Produces: `ArbiterTickStats` gains `ped_blocked_this_tick: u32`, `rtor_grants_this_tick: u32`, `left_protected_active: u32`, `yield_refusals_this_tick: u32`; `DebugArbiterLedgerState` mirrors them (flat scalars). A determinism test runs the wrapper's grant core twice with shuffled candidate + ped + light inputs and asserts identical output (rows, slots, counts) — extending the P3a order-independence test with the ПДД inputs.

- [ ] **Step 1: Write the failing tests** (mirror reflects new counters; determinism holds with ped + width-priority + помеха inputs in two orders).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the counters + mirror fields + determinism test.
- [ ] **Step 4: Run, verify pass.** Full workspace verification floor.
- [ ] **Step 5: Commit** — `feat(debug): arbiter ПДД observability + determinism guard for readiness/ped`

---

## Phase 3b exit criteria
- `cargo fmt` clean, `cargo clippy --all-targets --all-features -- -D warnings` clean, `cargo test` green.
- Flag OFF: byte-identical (legacy ПДД pipeline runs; new LightPhase variants never reached; routes + RNG unchanged).
- Flag ON: the arbiter admits with full ПДД — signalized green/yellow/all-red + RTOR; uncontrolled width-priority main-road + помеха-справа; pedestrians block conflicting maneuvers via real crosswalk matrix bits (`ped_mask`); demand-actuated protected-left phase. Collision-safety unchanged (matrix AND incl. `ped_mask`). Deterministic (twice-run identical). Observable via BRP `DebugArbiterLedgerState`. Tripwire still 0.
- No `SaveGameV3` change.

## Roadmap (next)
- **P3c — Liveness + ring-free topology + clears + merge + graph-edit:** the ORD-DAG liveness argument; the ring-free TOPOLOGY INVARIANT (every cluster has ≥1 open-road exit, enforced at zone_placement/road-edit) which closes the closed-ring residual and lets the `stall_ticks` valve be DELETED; cross-feeder exit-slot fairness; the 5 mid-trip sidecar clears; precise-fallback for cleared plans; mandatory-merge / reroute-from-actual-lane; graph-edit migration of in-flight INSIDE holders (the final-review-flagged graph-rebuild-mid-box window); the flag-on App-level end-to-end + twice-run integration test. This closes deadlock-freedom and enables flipping the flag on.
