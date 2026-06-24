# Lanelet Intersection — Phase 3c: Liveness + Sidecar Lifecycle + Enable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the flag-on correctness gaps that block enabling `experimental_lanelet_intersections` — mid-trip sidecar invalidation, precise lanelet fallback, the graph-rebuild-mid-box ledger window — add the liveness machinery (ORD-DAG argument, ring-free topology invariant, cross-feeder fairness, mandatory-merge), prove it with a flag-on App-level end-to-end + twice-run determinism test, then enable the flag and observe.

**Architecture:** P3a established the admission substrate (collision-safe by construction); P3b added full ПДД. P3c makes flag-on SOUND end-to-end and LIVE: when a vehicle reroutes mid-trip its `VehicleLaneletPlan` (absolute cursor offsets) is stale → clear it at the 5 re-intern sites and have the arbiter resolve the lanelet from the actual route geometry (precise-fallback) instead of the stale sidecar; on a graph rebuild while a vehicle is mid-box, re-seed `active_mask` from the surviving Inside rows so no conflicting entrant slips in for a tick; guarantee progress via the ascending-`IntersectionId` ORD-DAG plus the ring-free topology invariant (every drained cluster has ≥1 exit to open road) and cross-feeder exit-slot fairness; force a merge/reroute when a vehicle's actual lane no longer matches its plan. Then a seeded App-level test drives real vehicles through admission→cross→exit over many ticks, asserting no collision, liveness (drain), and twice-run determinism — the gate for flipping the flag.

**Tech Stack:** Rust 1.96 (edition 2024), Bevy 0.19. Crates `simcity_sim` (traffic, transport/lanelet, intersections, zone_placement/map) + `simcity_data` (test city / scenarios). Tests co-located.

**Spec:** `docs/superpowers/specs/2026-06-22-lanelet-intersection-architecture-design.md` (§S1-S10, the honest deadlock-freedom argument). Prior: P3a/P3b plans. P2 PREREQUISITE carried here: `VehicleLaneletPlan.entries.clear()` at the re-intern sites (deferred from P2 Task 8 as reviewer-confirmed safe until the arbiter reads the sidecar).

## Global Constraints

- Toolchain `1.96.0`, edition `2024`. Verification floor: `cargo fmt --all` → `cargo clippy --all-targets --all-features -- -D warnings` → `cargo test`.
- **FLAG OFF = BYTE-IDENTICAL** until Task 8. The sidecar clears (Task 1) run only flag-on (gated). The arbiter changes are behind `run_if`. The ring-free topology invariant (Task 4) must NOT reject any road edit when the flag is off — enforcement is flag-gated. Task 8 is the ONLY task that changes the default behavior (flipping the flag), done last and explicitly.
- **Collision-safety preserved unconditionally** (matrix AND incl. `ped_mask`). Liveness additions (fairness, merge, ring-free) change ordering/topology, never the matrix gate.
- **Determinism.** Seeded `SimRng` / stable integer keys; ascending `IntersectionId` sweep; precise-fallback resolves a deterministic lanelet; fairness uses a stable counter, not wall-clock; every non-commutative write entity-sorted.
- **Honest liveness claim:** collision-safe + bounded-box UNCONDITIONALLY by construction; deadlock-free by construction for open-drainable topologies (the ascending-ORD-sweep DAG); the closed-ring residual is eliminated by the Task 4 ring-free topology invariant. The legacy `stall_ticks` valve stays for the LEGACY (flag-off) path; the flag-on arbiter never touches it (tripwire confirms 0).
- No `SaveGameV3` change (except Task 8 may flip the config default, which is additive `#[serde(default)]`).
- **Ring-free topology invariant is gameplay-affecting** (Task 4 rejects road edits that would create a closed cluster with no open-road exit, flag-on). Confirm the exact UX (reject vs warn) with the human before enforcing.

---

### Task 1: Clear the lanelet sidecar at the 5 mid-trip re-intern sites (flag-on)

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/stuck.rs` (`:162` reroute, `:236` reverse) — add `&mut VehicleLaneletPlan` to the query, clear after `intern`
- Modify: `crates/simcity_sim/src/game/traffic/swap_break.rs` (`:252`)
- Modify: `crates/simcity_sim/src/game/traffic/lane_change.rs` (`:350`)
- Modify: `crates/simcity_sim/src/game/traffic/lane_change/planning.rs` (`:418`)
- Test: a co-located test asserting the plan is cleared after a re-intern

**Interfaces:**
- Produces: at each `v.path_handle = path_pool.intern(new_route)` site, when the flag is on, `lanelet_plan.entries.clear()` (the absolute cursor offsets no longer match the new route). Queries gain `Option<&mut VehicleLaneletPlan>` (all spawned vehicles carry it, but Option keeps service/edge cases safe). Gate on `traffic_cfg.experimental_lanelet_intersections` (cheap; flag-off the clear is skipped so behavior is byte-identical — though clearing an unused component flag-off would also be inert, gate it to make flag-off provably a no-op).

- [ ] **Step 1: Write the failing test** — drive a vehicle into a stuck reroute (or unit-test the helper) with a non-empty `VehicleLaneletPlan`; after the re-intern, `entries` is empty.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the query additions + flag-gated `entries.clear()` at all 5 sites. Factor a tiny helper `fn clear_lanelet_plan_on_reroute(plan: Option<Mut<VehicleLaneletPlan>>, flag: bool)` to avoid duplication.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `fix(traffic): clear VehicleLaneletPlan sidecar at the 5 mid-trip re-intern sites (flag-on)`

---

### Task 2: Precise lanelet fallback when the sidecar is empty

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (candidate resolution)
- Test: `#[cfg(test)] mod tests` in `arbiter.rs`

**Interfaces:**
- Consumes: `LaneletGraph` (`lanelets_from(entry_lane)`, `Lanelet.exit_lane`), the vehicle's route (`remaining_from`), `LaneGraph.pos_to_id`.
- Produces: when `VehicleLaneletPlan::upcoming_lanelet_at(cursor)` returns `None` (cleared/empty plan), the arbiter resolves the lanelet geometrically: from the approach lane (`pos_to_id[cur]`) and the post-cluster exit lane (`pos_to_id[exit_tile]`), find the unique `Lanelet` in `llg.lanelets_from(entry_lane)` whose `exit_lane` matches. `fn resolve_lanelet_fallback(llg, lanes, cur, exit_tile) -> Option<(IntersectionId, LaneletId)>`. A vehicle whose lanelet cannot be resolved (off-graph) gets NO candidate (it waits; the legacy emergency path is gone flag-on, so Task 6 mandatory-merge handles the persistent case).

- [ ] **Step 1: Write the failing test** — a vehicle with an empty plan but a valid route through a built cluster resolves the same lanelet the sidecar would have.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the fallback; call it in the candidate loop when `upcoming_lanelet_at` is `None`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(traffic): precise lanelet fallback resolves the lanelet from route geometry`

---

### Task 3: Graph-rebuild-mid-box ledger re-seed

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (the version-reset path)
- Test: `#[cfg(test)] mod tests` in `arbiter.rs`

**Interfaces:**
- Produces: on `reset_for_version` (graph rebuild), before the grant sweep, re-seed each ledger's `active_mask` from the vehicles currently INSIDE that cluster (the `ReservationState::Inside` rows in `by_intersection`), resolving each to its lanelet local index (via the sidecar or the Task 2 fallback). This closes the P3a-final-review window where a rebuild cleared a holder and the safety-net Inside row was recreated WITHOUT a ledger bit, momentarily under-representing `active_mask` and risking a one-tick conflicting admit. `fn reseed_inside_holders(reservations, matrices, cache, ...)`.

- [ ] **Step 1: Write the failing test** — simulate a version bump with an Inside vehicle; assert its lanelet bit is present in `active_mask` immediately after reset (a conflicting entrant is refused the same tick).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the re-seed in the version-change branch.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `fix(traffic): re-seed active_mask from inside holders on graph rebuild (closes the mid-box window)`

---

### Task 4: ORD-DAG liveness + ring-free topology invariant

**Files:**
- Modify: `crates/simcity_sim/src/game/zone_placement.rs` or the road-edit command handler (`simcity_sim` map/command path) — reject (or warn) a road edit that would leave a cluster with no open-road exit, flag-on
- Modify: `crates/simcity_sim/src/game/intersections/index.rs` — a `cluster_has_open_exit(cluster, grid) -> bool` helper
- Test: co-located tests

**Interfaces:**
- Produces: `cluster_has_open_exit` (a cluster has ≥1 exit lane to a road that eventually drains off-cluster). The road-edit/zone command checks the invariant flag-on and rejects/warns the edit that would close a cluster ring. Document the ORD-DAG argument inline: the arbiter sweeps clusters in ascending `IntersectionId`; with every cluster drainable, the wait-for graph is acyclic → progress. **The exact UX (hard reject vs soft warn + allow) is a human decision — confirm before implementing.**

- [ ] **Step 1: Write the failing test** — a road layout forming a closed cluster ring is rejected/warned flag-on; an open layout is accepted; flag-off both accepted (byte-identical).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the invariant check, flag-gated.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(map): ring-free topology invariant — clusters keep an open-road exit (flag-on)`

---

### Task 5: Cross-feeder exit-slot fairness

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` / `reservations.rs` (exit-slot acquisition fairness)
- Test: `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: when multiple feeders compete for the same exit tile's slots, rotate which feeder wins via a stable per-exit-tile round-robin counter (bounded-fairness, deterministic) so no feeder starves. `exit_slots` acquisition consults the counter; the counter advances deterministically (not wall-clock).

- [ ] **Step 1: Write the failing test** — two feeders contend for a 1-capacity exit tile over N ticks; both eventually win (no permanent starvation), deterministically.
- [ ] **Step 2-4:** implement + verify.
- [ ] **Step 5: Commit** — `feat(traffic): cross-feeder exit-slot fairness (bounded, deterministic)`

---

### Task 6: Mandatory-merge / reroute-from-actual-lane

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (or a sibling system)
- Test: `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: a vehicle whose ACTUAL lane no longer matches any admissible lanelet (e.g. after a lane change or a cleared+unresolvable plan) is forced to merge/reroute from its actual lane rather than waiting forever (the legacy emergency valve is gone flag-on). A bounded wait counter triggers a reroute request (existing reroute machinery) keyed off the vehicle's actual lane.

- [ ] **Step 1: Write the failing test** — a vehicle wedged with an unresolvable lanelet for > N ticks triggers a reroute.
- [ ] **Step 2-4:** implement + verify.
- [ ] **Step 5: Commit** — `feat(traffic): mandatory merge/reroute when the actual lane has no admissible lanelet`

---

### Task 7: Flag-ON App-level end-to-end + twice-run determinism test

**Files:**
- Test: a new co-located App-level test in `crates/simcity_sim/src/game/traffic/intersection/` (or `traffic/tests/`)

**Interfaces:**
- Produces: a seeded App that builds a small multi-cluster grid (reusing the test-city/scenario builders or a hand-built grid + `build_lanelet_graph`), spawns several vehicles with routes through the clusters, flips the flag ON, and runs the full FixedUpdate schedule for many ticks. Asserts: (a) NO two conflicting vehicles ever co-occupy a box (sample `is_reserved_by` / positions); (b) liveness — every vehicle eventually reaches its goal (the cluster drains); (c) `reservations.stall_tripwire()` stays false (tripwire); (d) running the same seeded world twice yields identical end state (twice-run determinism). This is the GATE for Task 8.

- [ ] **Step 1: Write the test** (it will fail until the schedule + map are wired correctly).
- [ ] **Step 2: Run, fix wiring until green.**
- [ ] **Step 3:** ensure determinism (twice-run identical) + no tripwire.
- [ ] **Step 4: Run full floor.**
- [ ] **Step 5: Commit** — `test(traffic): flag-on end-to-end lifecycle + twice-run determinism gate`

---

### Task 8: Enable the flag + observe

**Files:**
- Modify: `assets/config/traffic.ron` (set `experimental_lanelet_intersections: true`) OR keep the config default and enable at runtime for observation
- Modify: `README.md` if the behavior/hotkeys change

**Interfaces:**
- Produces: the flag enabled (default-on, OR a documented runtime toggle), the game run, traffic observed flowing through intersections via BRP (`DebugArbiterLedgerState`, `DebugLaneletState`) + a screenshot. This task is ONLY done after Task 7 is green. **Flipping the default is the explicit behavior change — confirm with the human first.**

- [ ] **Step 1:** confirm Task 7 green.
- [ ] **Step 2:** enable the flag; `cargo run`; observe via BRP that the arbiter is the sole producer (`DebugArbiterLedgerState.admitted > 0`, `stall_tripwire_fired == 0`) and vehicles flow.
- [ ] **Step 3:** capture a screenshot; verify no gridlock on the test city.
- [ ] **Step 4: Commit** — `feat(traffic): enable lanelet intersection arbiter by default` (only after observation confirms it works).

---

## Phase 3c exit criteria
- `cargo fmt` clean, `cargo clippy --all-targets --all-features -- -D warnings` clean, `cargo test` green.
- Flag OFF: byte-identical through Task 7 (Task 8 is the explicit flip).
- Flag ON: sidecar correct across reroutes (precise-fallback), no graph-rebuild-mid-box window, liveness on open-drainable maps (ring-free invariant + ORD-DAG + fairness + mandatory-merge), tripwire 0, deterministic (twice-run identical). Verified by the App-level e2e test.
- The lanelet intersection system is observable, collision-safe, deadlock-free on drainable topologies, and ENABLED — a visible working result.
