# Lanelet Intersection Architecture — Design Spec

**Date:** 2026-06-22
**Status:** Design (approved architecture shape; pending written-spec review)
**Feature flag:** `TrafficConfig.experimental_lanelet_intersections` (default `false`)

## 1. Goal & requirements

Replace the current tile-graph + post-hoc connector-rewrite + coarse-zone admission model — which produced a *family* of intersection deadlocks (5 distinct variants found and patched at one oversized 4×6 cluster) — with an intersection-traversal + pathfinding architecture that is:

- **Full ПДД realism.** Signal phases (protected + permissive left turns), priority/yield for uncontrolled intersections (stop sign, priority road, yield-to-right), right-turn-on-red, dedicated turn lanes + lane discipline, yield to pedestrians, don't-block-the-box.
- **Deadlock-free by construction.** No reliance on recovery/despawn band-aids. The proof is the implementation contract (§3, the 11 invariants).
- **Correct-by-construction lane-level pathfinding.** Routes are built on a lane+lanelet graph so vehicles pre-position into the correct lane *before* the intersection — no per-tick connector rewrite, no live tile-swap.
- **Shipped alongside the old system behind a flag.** Old connectors/admission/lane-pathfinding remain the proven fallback until the new path shows zero deadlocks on live runs.

**Intersections may or may not be signalized.** Lights are user-placed; today 6 of 18 clusters have one. The arbiter handles both modes uniformly (§6): membership in `IntersectionIndex.traffic_lights` decides signalized (phase-gated) vs uncontrolled (priority/yield) readiness, re-derived on any graph/light change. All by-construction guarantees (§3) hold in **both** modes.

### Resolved design decisions

| Decision | Choice | Consequence |
|---|---|---|
| Reserved-exit-slot scarcity (cap=2, 1.4-tile cars) | Accept lower peak throughput; liveness from the acyclic order | cap stays physically correct; no overlap-invariant break |
| Strict ПДД priority vs fairness | **Guaranteed fairness** (aging promotion) | bounded wait per maneuver; documented ПДД deviation (priority sometimes yields to an older car) |
| Protected-left phase source | **Auto / actuated** (counter forces a protected left when lefts queue) | fully derived; **no save change** |
| Stop-sign / priority-road source | **Derived from road width** (SixLane > FourLane > TwoLane) | fully derived; **no save change** |
| Symmetric 4-way yield-to-right tiebreak | Deterministic `entity.to_bits()` tiebreak | documented ПДД deviation (real drivers negotiate) |
| Compile-time cargo feature | No — runtime config bool only (live-toggle via MCP) | simpler |
| Conflict BitSet width | Dynamic `SmallVec<[u64;2]>` (heap-spills) | no hard per-cluster lanelet cap |

**Net: `SaveGameV3` is unchanged** — graph, conflict matrices, reservations, phase plans, and priority are all derived from `MapGrid` + `GraphVersion`, rebuilt on load. (Caveat: `turn_lanes` autogen mutates the persisted `RoadCell.lane_type`; gate it behind the flag and verify idempotent save roundtrip so toggling never silently rewrites a saved map.)

## 2. End-to-end data flow (flag ON)

```
MapGrid (RoadCell: kind/dir/lane/lane_type) + IntersectionIndex clusters
  └─[GameSet::GraphUpdate, run_if(flag), once per GraphVersion]→ LaneletGraph + ConflictMatrix
  └─[A* find_lanelet_path]→ route = Vec<TilePos> (unchanged format) + sidecar Vec<(IntersectionId, LaneletId)>
  └─[GameSet::Sim, 10 Hz, one arbiter/intersection/tick]→ atomic admission writes is_reserved_by truth
  └─[move_vehicles (drive.rs), SHARED, unforked]→ reads is_reserved_by, advances IDM
```

Exactly **one** producer of admission truth runs per tick (old `collect/apply` OR new `arbitrate_lanelet_reservations`), selected by `run_if`. `move_vehicles` reads whichever filled the shared contract — no fork.

## 3. Deadlock-freedom contract (the 11 invariants)

The two "obvious" defenses (atomic conflict-point acquisition + don't-block-the-box) are **insufficient** — adversarial analysis broke 5 of 6 attacks through them. By-construction freedom requires all of:

1. **Reserved-exit-slot.** A vehicle is admitted onto a lanelet only after *atomically* acquiring BOTH its full conflict-point set AND a *reserved* standing slot for its whole body in the exit lane's tail cell. The slot is held from admission until physically occupied. Admission-time *observation* of exit room is insufficient (room can vanish after entry → hold-and-wait). Guarantees a **bounded crossing window** ⇒ conflict points always release.
2. **Atomic all-or-nothing, no incremental interior.** A vehicle acquires the complete fixed conflict-point set (from the precomputed matrix) in one indivisible step or does not enter. Never holds a subset and asks for more while inside. ⇒ the 2-vehicle X/Y cycle is *unreachable*.
3. **Single deterministic arbiter per intersection per tick.** One pass over candidates sorted by a total key `(priority_class desc, age asc, entity.to_bits asc)`; grants serialized so two conflicting reservations can't both land in a tick. No HashMap-iteration-order dependence; seeded `SimRng` only.
4. **Geometric conflict matrix (precise, not coarse) — vehicles AND pedestrian crosswalks.** Two lanelets conflict iff their precomputed internal tile/segment sets intersect. **Each pedestrian crosswalk is a first-class conflict element in the matrix:** a vehicle lanelet conflicts with a crosswalk iff its internal path overlaps the crosswalk cells, so a turning vehicle whose lanelet crosses a zebra cannot be admitted while that crosswalk is occupied/reserved by a crossing pedestrian (and vice-versa). The 5-zone coarse mask may only *reject* as a pre-filter, never *admit*. No `ZONE_ALL` widening/narrowing on multi-tile clusters. Cached by `GraphVersion`. ⇒ no center-tile false-admit, and no vehicle-vs-pedestrian collision by construction.
5. **Global acyclic progress order (liveness).** A strict total order on intersections (by `IntersectionId`). In any cyclically-blocked set, the lowest-ordered intersection is *guaranteed* to advance ≥1 vehicle whose own exit lead is draining. Makes the cross-intersection wait-for graph a **DAG by construction** (a cycle would require a node to wait on a strictly-lower-ordered node — contradiction). **This replaces the 30-tick force-admit valve and 8s emergency grant with a proof.**
6. **Don't-block-the-box is safety, ordering is liveness.** Don't-block-box guarantees no spill but NOT progress; starvation-freedom comes only from §5 + §1, never from mutual refusal.
7. **Bounded-fairness signal/priority — including pedestrians.** Every `(entry,exit)` maneuver — incl. permissive lefts and stop/yield movements — AND every pedestrian crosswalk is guaranteed a protected (highest-priority, all-conflicts-stopped) window within a bounded number of cycles/rounds (deterministic actuated counter, not RNG). A waiting pedestrian therefore gets a bounded-wait crossing window ⇒ no pedestrian starvation and no pedestrian↔vehicle deadlock. All-red clearance is a bounded fixed safety delay only.
8. **Soft revocable Approaching reservations.** Approaching (not-yet-entered) reservations hold NO conflict points and auto-expire after a bounded tick budget; only INSIDE (physically-occupying) reservations hold points + the exit slot. ⇒ the 6s timeout becomes a *correctness rule*, not a recovery hack.
9. **Correct-by-construction lane pre-positioning + mandatory merge + reroute fallback.** A* models lane-change as length-bearing cost (merges happen early); a mandatory-merge zone gives route-required lane changes non-discretionary priority (through traffic yields, deterministic tiebreak); a vehicle that reaches point-of-no-return in the wrong lane is **rerouted from its actual lane**, never made to wait for a gap. ⇒ no through-lane deadlock behind a mis-positioned car.
10. **Graph-edit safety for in-flight crossers.** On `GraphVersion` bump, vehicles occupying cluster tiles are migrated/re-seeded into the rebuilt matrix (ZONE_ALL-scoped to occupied tiles) or the edit is deferred until drain — never silently dropped mid-box.
11. **Determinism + observability.** All arbitration/ordering/expiry use seeded `SimRng` and stable integer keys only (reproducible tests). Lanelet reservations, held points, reserved exit slots, and per-intersection progress-order state are exported via BRP/MCP (flat `Debug*State` mirrors — do NOT reflect-register complex types).

**Residual risks (must be live-verified before removing the fallback):**
- (a) The reserved exit slot is itself a resource on the downstream lane → it must be acquired under the SAME total intersection order as §5, else the two reservations interleave into a new cycle.
- (b) The global order favors low-id intersections → must combine with §7 bounded-fairness so high-id ones aren't perpetually deprioritized.
- (c) cap=2 makes exit slots scarce → §5 acyclic-progress does most of the real work; exercise it heavily on live stress topologies.

## 4. Section-by-section design

### S1 — Graph model
`LaneletGraph` resource (new, `transport/lanelet/graph.rs`), built once per `GraphVersion`:
- **RoadLane nodes** = drivable lane-tiles (same population as today's `Lane`, `lane_graph.rs:28`) carrying explicit cross-section `lane_idx`.
- **Lanelet nodes** = one per legal `(entry_lane → exit_lane)` maneuver per cluster: `{ internal_path: Vec<TilePos> (strictly 4-adjacent), maneuver: ManeuverKind, entry_lane, exit_lane, turn_cost }`.
- **Edge kinds:** lane-follow; lane-change (+`lane_change_penalty`); **lanelet-ENTER** (exists ONLY from the legal entry lane per `RoadCell.lane_type` + `is_leftmost/rightmost_for_dir`, +`turn_penalty`); lanelet-EXIT (~0).

The lanelet-enter edge being the only admission to a maneuver, *originating at the correct lane*, is what makes pre-positioning correct-by-construction. Replaces the turn-blind `intersection_connections` 4-neighbor wiring (`lane_graph.rs:191`) and the per-vehicle connector rewrite (flag on). `LaneGraph` stays as the road-lane-segment half.

### S2 — Lanelet generation + orthogonal geometry
`build_lanelet_graph` (`transport/lanelet/build.rs`) derives lanelets from `IntersectionCluster.tiles` + neighbor `RoadCell.dir/lane_type` (reuses `turn_lanes.rs:67` approach/exit derivation + `connectors.rs:534 build_connector_path` math as a **build-time pure helper**). The internal-path router emits ONLY 4-adjacent steps, with exit-lane correction applied to the router **GOAL** so a diagonal final step is *structurally impossible* (kills the diagonal-exit/no_zones bug at the source). `LaneType` autogen (`turn_lanes.rs`, currently `#[allow(dead_code)]`) is enabled under the flag and *consumed* for lanelet legality (a `LeftTurnOnly` tile only feeds left lanelets). Must generalize `connectors.rs` exit-side logic beyond TwoLane to FourLane/SixLane.

### S3 — Conflict matrix
`ConflictMatrix` per intersection (`transport/lanelet/conflict.rs`): dense rows, `rows[i]` bit `j` set iff lanelets `i,j` share an internal tile/segment (built from a `cell → lanelets` occupancy map). `BitSet = SmallVec<[u64;2]>` (dynamic, no cluster cap). Replaces `zones.rs` `ConflictMask/StreamKey/reservation_zones_for_maneuver` + the 6 hand-coded `can_reserve` special cases. The atomic all-or-nothing unit. Cached by `GraphVersion`; identical across rebuilds (determinism test).

### S4 — Reservation ledger + admission test
`IntersectionLedger` (per intersection): `active_mask: BitSet` (conflict points currently held by INSIDE crossers) + sorted holders + a **per-exit-lane reserved-slot counter**. Admit lanelet `L` for vehicle `V` iff:
```
(matrix.rows[L] & active_mask) == 0          // atomic, no conflict-point overlap
AND exit_slot_reservable(L.exit_lane, V)     // RESERVED standing slot (held, not observed)
AND downstream_link_has_headroom(...)        // ported drain-aware gate
AND global_progress_order_permits(...)       // §S5
```
On grant: `active_mask |= bit(L)`; reserve exit slot; stamp owners. On any failure: acquire **nothing**, re-bid next tick (voluntary release ⇒ no hold-and-wait). Exposes the SAME `is_reserved_by(id, entity)` truth so `drive.rs:282` is unchanged. The 6s cleanup is kept as a leak-guard only.

### S5 — Global acyclic progress order (the liveness proof) — highest-risk item
Strict total order on intersections by `IntersectionId`. The exit-slot/headroom tie is broken so that within any cyclically-blocked set, the **lowest-id** intersection may always advance one vehicle into the next box at nominal capacity *provided that vehicle's own exit's lead car is itself moving* (drain-aware). Wait-for graph is a DAG by construction. The reserved exit slot (§S4) is acquired under this same order to avoid reintroducing a cycle (residual risk (a)). Replaces `stall_ticks` force-admit + 8s emergency.

### S6 — ПДД priority arbitration (signalized AND uncontrolled)
`arbitrate_lanelet_reservations` (single system): collect candidates (`par_iter` read-only into thread-local Vecs), partition by `IntersectionId`, sort by `(priority_class desc, age asc, entity.to_bits asc)`, atomically grant. `lanelet_readiness()` (pure fn) folds ALL ПДД rules into `is_ready + rank` in ONE place — rules decide *who is ready and at what rank*, never mutate world state separately.

**Signalized cluster** (`traffic_lights.contains(id)`): phase-gated. Extended `LightPhase` with `ProtectedLeftNS/EW` sub-phases (extends `lights.rs:14`); a permissive left is ready only with no conflicting oncoming reservation; RTOR after a stop. An **actuated counter** forces a protected-left phase within a bounded cycle count when lefts queue (§3.7). Reuses `TrafficLight.is_green/is_yellow/is_all_red`.

**Uncontrolled cluster** (no light): priority/yield. Priority road **derived from road width** (SixLane > FourLane > TwoLane); minor-road movements yield; equal-priority uses **yield-to-the-right**, with a deterministic `entity.to_bits()` tiebreak on symmetric simultaneous arrival (documented ПДД deviation). Reuses `pdd_check.rs` priority/right-of-way helpers.

**Pedestrian crossings (first-class).** Each cluster approach has a crosswalk = a set of cells derived from cluster geometry (build-time, like lanelets), registered as a **conflict element in the same `ConflictMatrix`** (§3.4). A pedestrian who wants to cross requests the crosswalk through the **same arbiter** as vehicles (a crosswalk is just another resource with its own conflict row); on grant it is held for the crossing window, and every vehicle lanelet overlapping it is blocked for that window (§3.4) — and conversely a pedestrian is not granted while a conflicting vehicle lanelet is mid-cross. This makes vehicle↔pedestrian interaction the **same deadlock-free mechanism**, not a bolted-on yield. Reuses the existing `PedestrianCrossing` component + `ped_axis_mask` snapshot as the request signal and `PedestrianGraph`/`PedestrianRoutingScratch` for the walk itself.
- *Signalized:* a pedestrian **WALK sub-phase** in the `PhasePlan` (concurrent with the parallel-direction green where crosswalks don't conflict, or an exclusive scramble where they do); permissive-turning vehicles must yield to peds already in the crosswalk (conflict-row level). The actuated counter guarantees a ped WALK window within a bounded cycle count (§3.7) ⇒ no ped starvation.
- *Uncontrolled:* vehicles yield to a pedestrian in/entering the crosswalk (the crosswalk's conflict row blocks the overlapping lanelets); the pedestrian's bounded-fairness comes from the same `age` aging term as vehicles.

**Both modes:** **fairness via the `age` term** (aging promotion guarantees a bounded wait per maneuver *and per crosswalk* — for uncontrolled clusters there is no signal cycle, so fairness comes entirely from aging + the deterministic arbiter). Mode is re-derived on graph/light change; adding/removing a light flips a cluster between phase-gated and priority/yield with no other state.

### S7 — A* pathfinding rework
`find_lanelet_path` (`transport/lanelet/pathfinding.rs`): integer-cost binary-heap A* ported from `lane_pathfinding.rs:31` (keep `HeapState` tiebreak + splitmix64 seeded jitter). **Fixes:** heuristic = Manhattan **scaled by min per-tile base cost** so it stays admissible once turn/lane-change penalties exist (raw `dx+dy` would degrade to Dijkstra under scaling); finally *consume* `lane_change_penalty`/`turn_penalty` (currently dead for lane routing). Output `Option<Vec<LaneletNodeId>>` (`None` = no lane-legal route) → flattened to `Vec<TilePos>` + sidecar `Vec<(IntersectionId, LaneletId)>`. Pre-positioning (§3.9): mandatory-merge zone + reroute-from-actual-lane fallback; never emit a route requiring a zero-headroom lane change. Tiered fallback: lane route → (degenerate) road route → explicit no-route (never a silently-invalid route).

### S8 — Soft reservations, graph-edit safety, band-aid deletion
Approaching reservations are soft (§3.8). Graph-edit safety (§3.10). **Deleted when flag on:** `stall_ticks` 30-tick force-admit valve + 8s emergency ZONE_ALL grant; live tile-swap `lane_change.rs`/`swap_break.rs` (subsumed by upstream lane-change A* edges); diagonal-exit fallback (`state.rs:340-348`). `INTERSECTION_STALL_FORCE_TICKS` is **kept as a tripwire** — if it ever fires under the flag, that's a design bug (panic/log via MCP).

### S9 — Feature flag, wiring, persistence, determinism
Flag = `TrafficConfig.experimental_lanelet_intersections: bool` (`assets/config/traffic.ron`, default false, parse-tested). `run_if`-gates two mutually-exclusive `GameSet::Sim` bundles (old `collect/apply/rewrite` vs new `arbitrate`) AND the `GameSet::GraphUpdate` lanelet build. `move_vehicles` shared (only tweak: make the don't-block-box gate lanelet-exit-aware, no-op when the old producer is active). Persistence unchanged (all derived). Determinism: clusters by `IntersectionId`, lanelets by stable sorted id, candidates in a Vec sorted by `(class, age, entity.to_bits)` — no HashMap iteration in any grant decision.

### S10 — Observability + live verification
New flat reflected mirrors: `DebugLaneletRouteState` (chosen lanelet ids + conflict masks), `DebugLaneletArbitrationState` (ready/granted candidates, cp owners, reserved exit slots, max age, progress-order state) — mirrors `DebugVehicleState` pattern; do NOT reflect-register complex types.

**Verification path (the by-construction claim must survive empirically before removing the fallback):**
1. Unit/property tests: `lanelet_readiness()` per-ПДД-row table; orthogonal-router asserts every consecutive tile pair is 4-adjacent; conflict matrix identical across rebuilds; A* spread/congestion tests ported.
2. Compiled-in invariant assertions under the flag: `INTERSECTION_STALL_FORCE_TICKS` as a tripwire (panic/log if it fires); assert no vehicle holds a conflict point past its reserved window; assert no Approaching reservation holds points.
3. Live stress: the 4×6 monster cluster (intersection 7) that produced all 5 deadlocks + a spillback-ring A↔B layout; thousands of vehicles for N sim-hours; via BRP/MCP confirm (a) tripwire never fires, (b) stopped-count never grows to a frozen plateau, (c) per-intersection max-age stays bounded, (d) per-intersection throughput > 0 over every rolling window.
4. A/B old vs new on the same seed+map; new must dominate stuck-count and never freeze.
5. Only after (1)–(4) green on live runs: flip default to true, keep old path one release as fallback, then delete the band-aids.

## 5. Component breakdown (reuse / replace / delete)

| Component | Purpose | Disposition |
|---|---|---|
| `TrafficConfig.experimental_lanelet_intersections` + traffic.ron knobs | flag + tuning | reuse/extend `TrafficConfig` |
| `transport/lanelet/graph.rs` (`LaneletGraph`) | RoadLane + Lanelet nodes | new; wraps `LaneGraph` |
| `transport/lanelet/build.rs` | orthogonal lanelet gen + enter-rule | new; reuses `turn_lanes`/`connectors` math |
| `transport/lanelet/conflict.rs` (`ConflictMatrix`) | precise geometric conflicts, incl. pedestrian crosswalks as first-class conflict rows | new; replaces `zones.rs` mask |
| Crosswalk derivation (in `build.rs`) + WALK sub-phase in `PhasePlan` | per-approach crosswalk cells + signalized walk window + actuated ped fairness | new; reuses cluster geometry + `lights.rs` phase clock |
| `transport/lanelet/pathfinding.rs` (`find_lanelet_path`) | correct-by-construction routing | new; reuses A* skeleton; replaces `find_lane_path` (flag) |
| `IntersectionLedger` (+ `is_reserved_by` contract) | atomic admission + exit slots | replaces `IntersectionReservations` internals (flag); same `is_reserved_by` |
| `arbitrate_lanelet_reservations` + `lanelet_readiness()` | single deterministic arbiter | replaces `collect/apply` + force-admit valve |
| Extended `LightPhase` + actuated counter | protected-left + bounded fairness | extends `lights.rs` |
| `move_vehicles` (drive.rs) | the shared mover | reused unchanged (one exit-aware tweak) |
| `Debug*State` mirrors | observability | new |
| `IntersectionIndex`, `GraphVersion`, `PathPool`, `Vehicle`, `TrafficSpatialIndex`, splitmix64 jitter, `PedestrianGraph`/`PedestrianCrossing`/`ped_axis_mask` | substrate | reused unchanged |
| `stall_ticks` valve, 8s emergency, `swap_break`, diagonal fallback | recovery band-aids | deleted (flag on); `INTERSECTION_STALL_FORCE_TICKS` kept as tripwire |

## 6. Out of scope (YAGNI)
- Continuous time-space trajectory reservation (approach B) — overkill for a 10 Hz tile sim.
- Sub-tile longitudinal occupancy slots — deferred; cap=2 accepted.
- Player-authored stop signs / protected-left plans / persisted PhasePlan — derived instead; no SaveGameV3 change.
- Multi-lane merging/weaving outside intersections beyond the existing lane-change model.

## 7. Open items to confirm at plan time
- Exact `turn_penalty`/`lane_change_penalty` values + the mandatory-merge zone length (tuning, `pathfinding.ron` parse + spread tests).
- Actuated protected-left counter thresholds (queue length / cycle count).
- The precise drain-aware tie rule in `global_progress_order_permits` (residual risk (a)).
