# Handoff: finish the lanelet-arbiter throughput (flag-on gridlock)

## Mission
Make the lanelet intersection arbiter (the `experimental_lanelet_intersections` flag-ON path) flow like
the legacy path — NO permanent gridlock on the auto-loaded test city — then enable the flag by default.

**Invariants — do NOT change:** keep the collision-safety conflict matrix (lanelet `try_admit`) + full
ПДД (lights, помеха-справа, RTOR, protected-left, pedestrians). Redesign ONLY admission **throughput**.

**Success bar (user's):** flag-on, run the test city ~10 min — `max_stopped_secs` stays bounded
(~60-100 s, like legacy), `crossing>0` sustained, no permanent gridlock. Legacy + the jam-recovery fix
already meets this; the arbiter does not.

## Where it stands (git log on `main`; all LOCAL, not pushed)
The P3a–P3c arbiter is collision-safe + full ПДД but UNDER-ADMITS on a populated city → gridlock.
Causes fixed so far:
- `30de443` jam-recovery fix → **legacy path is healthy** (max_stopped bounded). Recovery now clears
  WaitingForGreen-wedged cars via the never-reset `VehicleMotionTimer` (was blind to them).
- `ca89844` flag default **OFF** (arbiter gridlocks the real city).
- `2a62318` re-populate the lanelet sidecar on reroute (reduces unresolved-lanelet drops).
- `577d1b1` (+ `2cef226`) arbiter **refusal histogram** + **coarse-fallback admission** + force-admit
  valve. Coarse-fallback eliminated the dominant G1 cause: live `drop_unresolved` fell **120 → 0**.

## The RESIDUAL to solve (whack-a-mole: G1 fixed, next bottleneck appeared)
With the coarse fix the bottleneck SHIFTED from collection (G1 unresolved-lanelet) to the GRANT PHASE:
at gridlock `admitted~0` even with `drop_unresolved=0`, and `max_stopped` still climbs unbounded.
`candidates_built>0` (cars reach the grant loop) but aren't admitted — refused (yield/matrix) or
**skipped as already-reserved** (a car holds a reservation but never enters the box). Suspected: a car
with an arbiter reservation but `VehicleTrafficState::WaitingForGreen` is blocked by `drive.rs:279-280`
("never enter even with a reservation while WaitingForGreen") → holds the reservation, blocks the queue.
**First task: a SUMMED time-series of the histogram at gridlock to pin the new dominant cause.**

## CRITICAL methodology — TWO diagnostic errors came from ignoring this
The arbiter histogram (`DebugArbiterLedgerState`) is PER-TICK + sparse. A single snapshot misdiagnosed
this TWICE (looked like capacity-starvation; was actually 94% unresolved-lanelet). ALWAYS **sum over a
window** (~24 ticks):
```bash
DAL="simcity_debug::game::debug_world::DebugArbiterLedgerState"
Q="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"world.query\",\"params\":{\"data\":{\"components\":[\"$DAL\"]},\"filter\":{\"with\":[\"$DAL\"]}}}"
tmp=$(mktemp)
for i in $(seq 1 24); do curl -s -X POST http://127.0.0.1:15702 -H 'Content-Type: application/json' -d "$Q" --max-time 6 | jq -c ".result[0].components.\"$DAL\"" >> "$tmp"; sleep 1.2; done
jq -s 'reduce .[] as $x ({cand:0,built:0,adm:0,ref:0,yld:0,cap:0,mtx:0,du:0,doth:0,force:0};
  {cand:(.cand+$x.cand_approaching),built:(.built+$x.candidates_built),adm:(.adm+$x.admitted_this_tick),
   ref:(.ref+$x.refused_this_tick),yld:(.yld+$x.yield_refusals),cap:(.cap+$x.refused_capacity),
   mtx:(.mtx+$x.refused_matrix),du:(.du+$x.drop_unresolved_lanelet),doth:(.doth+$x.drop_other_collection),
   force:(.force+$x.ring_force_admits)})' "$tmp"; rm -f "$tmp"
```
Read it: `built≈0 & cand>0` ⇒ loss in COLLECTION (G1 unresolved / other). `built>0 & adm≈0` ⇒ loss in
GRANT phase (yield=G2 red / capacity=G4-G5 / matrix=G3) OR admitted-but-not-entering (counted neither
admitted nor refused — they're "already-reserved" skips).

## Diagnosis toolkit (game must be running flag-on)
Per-vehicle — CORRECT type path is `simcity_sim::game::traffic::components::DebugVehicleState`
(NOT `simcity_debug::...`). Fields: tile_x/y, next_tile_x/y, speed, state, path_cursor, path_len,
route_sample_x/y[8]. Build a tile→occupancy map from all cars' tiles to see what's "ahead".
Traffic health — `DebugTrafficSnapshot`: active_vehicles, frozen_vehicles (stopped>30 s, Without<Parked>),
max_stopped_secs, max_moving_secs, worst_stopped_tile_x/y.
Lights — `DebugIntersectionSnapshot.light_phase_counts[8]` (poll: they DO cycle, even at gridlock).
BLIND SPOT: `Parked` + `TrafficLight` are NOT reflect-registered → `has:[Parked]` returns false for ALL
cars; trust the in-engine `Without<Parked>` motion timer, not BRP `has`.

## Reproduce + verify
1. `assets/config/traffic.ron`: set `experimental_lanelet_intersections: true` (DEV; revert to false
   before committing the default).
2. Kill any running game, `cargo build`, launch via the `bevy-brp` MCP (`brp_launch` target `simcity`).
3. Gridlock forms in ~3-5 min (frozen_vehicles + max_stopped climb). Run the time-series at gridlock.
4. A WORKING fix: flag-on, `max_stopped_secs` stays bounded ~60-100 s + `crossing>0` over ~8 min.

## Separate bug capping verification
City PANICS after long gridlock: `building_decay_low_happiness` (crates/simcity_sim/src/game/buildings/
decay.rs) — low happiness from the gridlock triggers it. Unrelated to traffic; caps the run to ~5 min.
Worth fixing first so the arbiter can be verified over a longer window.

## Candidate fix directions (grant-phase residual)
- **Admitted-but-not-entering**: reconcile arbiter readiness (admits on `is_green`) with `drive.rs:279-280`
  (blocks entry while `WaitingForGreen`). A reserved car stuck WaitingForGreen holds the box-entry slot.
- **Resolve precisely instead of coarse**: coarse admission is whole-box-exclusive (low throughput). Better
  to make rerouted routes lane-legal so cars resolve their lanelet PRECISELY. `reroute_planner.rs` already
  calls `find_route`; investigate why cars still fall to coarse (`upcoming_lanelet_at` cursor misalignment?
  `find_route` returning empty at weird gridlock positions?).
- **Queue-streaming**: candidates are only the car 1 tile before the box; consider admitting deeper into a
  green-axis queue so it drains faster than it forms.

## Key files
- `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` — `arbitrate_lanelet_reservations`
  (collection loop, the histogram + coarse-fallback), `arbitrate_grants_inner` (grant loop + force valve),
  `lanelet_readiness`.
- `.../intersection/reservations.rs` — `IntersectionLedger` (try_admit, try_admit_coarse, coarse_held).
- `.../traffic/movement/drive.rs` — entry gate (~274-396), WaitingForGreen-blocks-entry (279-280),
  capacity gate (346-359).
- `.../traffic/movement/state.rs` — `update_vehicle_traffic_state` (sets WaitingForGreen).
- `.../traffic/reroute_planner.rs` — sidecar re-population on reroute.

## Project constraints
- Russian to the user; English code/commits. Conventional Commits + trailer
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- No commit/push without explicit ask. Work LOCAL on `main`, not pushed.
- Do NOT raise `capacity_per_lane_tile`.
- Floor before done: `cargo fmt --all` → `cargo clippy --all-targets --all-features -- -D warnings` →
  `cargo test` (baseline: simcity_sim 163, simcity_data 4, simcity_debug 2).
- Kill the running game before launching a new instance.
- Memory: `simcity-gridlock-recovery-blindspot.md` holds the durable findings.
