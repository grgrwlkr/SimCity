# Public Transport & Vehicle Unification — Phase A (design)

**Date:** 2026-07-08
**Status:** approved (design), pending implementation plan
**Audit link:** §8 item 9 (public transport rewrite)

## Context & decomposition

The current `public_transport.rs` is a harmful stub: it injects phantom `Vehicle`
entities on fake 2-tile paths (no pathfinding) into the live traffic occupancy /
spatial-index / motion-stats pipeline, renders buses at 1/16 world scale near the
origin (`tile_size = 1.0`), auto-creates a "Route 1" on any map wider than 10 tiles,
and fakes passengers (`passengers + 5`).

The full desired feature (player-placeable routes + real citizen boarding) is **three
independent subsystems**, sequenced by dependency:

- **A — Buses & service vehicles as unified car-like traffic agents** (this spec, the foundation).
- **B — Player-placeable bus routes** (new tool + `GameCommand` + undo/redo + `SaveGameV3`).
- **C — Citizens ride buses** (`TripMode::Bus`, walk-to-stop, board/wait/ride/alight, demand integration).

Each gets its own spec → plan → implementation → commit. This spec covers **A only**.

## Goals (A)

1. Remove the phantom-injection harm: buses become real `Vehicle` traffic agents on
   real lanelet routes, moved by the shared `move_vehicles`.
2. Visual unification: buses and service vehicles render as car-shaped rectangles (like
   regular vehicles) with a geometric roof-symbol overlay; regular cars are unchanged.
   Service vehicles keep their per-kind colors.
3. Preserve determinism (audit §8 item 6) and the existing test/soak suite.
4. Keep the system observable via MCP.

## Non-goals (A) — deferred

- Player-placeable routes, a bus-route UI tool, `GameCommand` variants, undo/redo, and
  `SaveGameV3` persistence of routes → **B**.
- Real citizen boarding, `TripMode::Bus`, walk-to-stop, seat occupancy, demand effects → **C**.
- Passengers are an abstract placeholder in A (no citizen entities are rerouted onto buses).

## Teardown (removed from `public_transport.rs`)

- The fake 2-tile path construction (`vec![start_pos]; path.push(goal_pos)`).
- The custom `move_buses` movement (buses move via `move_vehicles` instead).
- The local `tile_to_world` with `tile_size = 1.0` (use `MapConfig.tile_size`).
- The auto-create "Route 1" on any map > 10 tiles.
- The fake passenger math (`passengers + 5`) and the hardcoded `speed: 50.0`.

## A2 — Bus as a first-class `Vehicle`

**Data model:**
- `BusStop` — a stop location (tile). (In A, stops come from the seeded demo route; in B,
  from player placement.)
- `BusRoute { id, stops: Vec<TilePos> }` — an ordered stop sequence.
- `BusRouteManager { routes: Vec<BusRoute>, next_id }` — resource holding active routes.
- `Bus { route_id, target_stop_idx, state: BusState }` component on the vehicle entity.
- `BusState { Driving, Dwelling { timer } }`.

A carries **no passenger accounting** — the `Bus` component has no passenger field (the
stub's fake `passengers + 5` is removed outright). Real boarding/seat occupancy is C.

**Bus entity** = `Vehicle` + `Bus` + car-rectangle `Sprite` + roof-symbol child (see A3).
It is NOT a trip vehicle (no `TripPassenger`) and must not despawn on route completion.

**Routing** reuses the service-dispatch pattern: `replan_route_with_lanelets` (lanelet
planner) with a road-A* fallback, both under the `route_direction_ok` intern guard, using
a jitter seed drawn from `SimRng`. A bus's active route is the lanelet path from its current
tile to its `target_stop_idx` stop.

**Movement** is the shared `move_vehicles`. Buses require the same arrival-despawn immunity
service vehicles have: the despawn gate in `move_vehicles`
(`if service_vehicle.is_none() { … despawn }`) becomes
`if service_vehicle.is_none() && bus.is_none() { … despawn }`. When a bus's path is exhausted
(reached its target stop), it does not despawn.

**Bus tick system** (small, FixedUpdate, `SimStep::PublicTransport`): when a bus's path is
exhausted, enter `Dwelling { timer = DWELL_SECS }`; when the dwell timer elapses, advance
`target_stop_idx = (idx + 1) % stops.len()`, re-plan the route to the next stop, and return
to `Driving`. Deterministic: route replan uses the `SimRng` jitter seed; the system joins the
existing `SimStep::PublicTransport` sub-set (chained), so the zero-ambiguity pins
(`fixed_update_has_no_ambiguous_system_pairs`, `composed_fixed_update_has_no_ambiguous_system_pairs`)
stay green.

**Occupancy/spatial/motion:** buses now carry real multi-tile routes (`path_len > 1`), so they
legitimately participate in occupancy / spatial index / motion stats — unlike the stub's
`path_len == 2` fake. This is intended.

## A3 — Visual unification

Unifying principle: **special vehicles = a colored car rectangle + a geometric roof-symbol
child sprite (higher Z); regular cars have no symbol (unchanged).**

- **Regular cars:** unchanged — plain rectangle (`VEHICLE_VISUAL_LENGTH_TILES ×
  VEHICLE_VISUAL_WIDTH_TILES`), no overlay.
- **Buses:** yellow car rectangle (same dimensions as regular cars) + a contrasting
  (dark) roof marker child = the "symbol on top" that distinguishes a bus from a plain car.
- **Service vehicles:** car rectangle colored by `ServiceKind::vehicle_color()`
  (Fire red / Police blue / Medical green) instead of the current white square +
  colored dot; a white roof marker child reads as "official vehicle". Colors preserved.

The roof symbol is a child `Sprite` (small contrasting rectangle) at local `(0,0)` with a
higher local Z. Children inherit the parent's rotation, so the marker rides "on the roof"
aligned with travel direction — for free via the existing `interpolate_vehicle_position`.

Symbols are geometric (not text) because the project renders no world-space text and loads
no font asset; a lettered glyph would require adding a font and is out of scope for A.

## A4 — Route seeding in A + load/reset

- Player placement is **B**. So buses are visible in A via **one deterministic demo route**
  seeded at test-city generation (analogous to how service buildings are prebuilt in
  `test_city.rs`), routed along existing roads. Real, lanelet-routable.
- `BusRouteManager` is **reset on `GenerateMap` / `LoadGame` / `LoadTestCity`** (item 5 noted
  it currently survives loads) and re-seeded by generation.
- **`SaveGameV3` is unchanged** in A — the demo route is regenerated deterministically on load.
  Persistence of player-created routes arrives with B.

## A5 — Testing & observability

- The determinism fingerprint test and the soak harness stay green. `buses` is already a
  measured quantity in `soak.rs::measure()`.
- New pins:
  - A bus drives a real multi-tile lanelet route (route length > 2), not a 2-tile stub.
  - On reaching its target stop the bus enters `Dwelling`, then advances `target_stop_idx`
    and re-plans — and does NOT despawn on path exhaustion.
  - A bus spawns at the correct world scale (position derived from `MapConfig.tile_size`,
    not clustered near the origin).
- MCP: a bus is observable via `DebugTrafficSnapshot` (or a dedicated debug snapshot) —
  count and state — per the CLAUDE.md "must be observable via MCP" convention.

## Acceptance criteria (A)

1. `public_transport.rs` no longer injects fake-path buses; buses are `Vehicle` entities on
   real lanelet routes moved by `move_vehicles`.
2. Buses and service vehicles render as colored car rectangles with a roof-symbol overlay;
   regular cars unchanged; service colors preserved.
3. Buses loop their route's stops (drive → dwell → advance → re-plan) and never despawn on
   arrival.
4. `cargo clippy -D warnings` clean (both feature configs), `cargo test --workspace` green
   including the determinism and soak pins and the new bus pins, `cargo fmt` clean.
5. Live `--features dev` smoke: buses visible driving the demo route at correct scale;
   `route_oncoming_ticks_total = 0` (no traffic-invariant regression).
