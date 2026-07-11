//! Public Transport System — buses drive real routes between stops as first-class
//! `Vehicle` traffic agents (Phase A). Passenger boarding is Phase C; player-placed
//! routes are Phase B. Buses are moved by the shared `move_vehicles`; this module only
//! spawns them, seeds a demo route, and ticks their stop/dwell state machine.

use bevy::prelude::*;

use crate::game::intersections::IntersectionIndex;
use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::state::AppState;
use crate::game::traffic::{
    LaneletReplanRes, PlannedRoute, RouteProducer, TrafficConfig, TrafficOccupancy,
    VEHICLE_VISUAL_LENGTH_TILES, VEHICLE_VISUAL_WIDTH_TILES, Vehicle, VehicleLaneletPlan,
    VehicleTrafficState, apply_route, kmh_to_world_speed, plan_tiles_lanelet_first,
};
use crate::game::transport::{
    PathCache, PathPool, PathfindingConfig, PathfindingCtx, RegionGraph, RoadGraph,
    adjacent_road_towards,
};

/// Seconds a bus dwells at each stop before advancing to the next.
pub const DWELL_SECS: f32 = 3.0;

/// Bus body color (yellow).
const BUS_COLOR: Color = Color::srgb(0.9, 0.7, 0.2);
/// Roof marker color for buses (dark, contrasts with any body).
const BUS_ROOF_COLOR: Color = Color::srgb(0.12, 0.12, 0.12);
/// Cruising speed cap for buses (km/h) — moderate, below fast cars.
const BUS_MAX_SPEED_KMH: f32 = 55.0;

/// Bus-stop map marker color (cyan, distinct from vehicles/roads).
const BUS_STOP_COLOR: Color = Color::srgb(0.15, 0.85, 0.9);

/// Marker on the child roof-symbol sprite of a special vehicle (bus / service).
#[derive(Component)]
pub struct VehicleRoofMarker;

/// A rendered bus-stop marker entity on the map (one per route stop).
#[derive(Component)]
pub struct BusStopMarker;

pub struct PublicTransportPlugin;

impl Plugin for PublicTransportPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<BusRouteManager>()
            .add_systems(
                FixedUpdate,
                // Chained: spawn produces buses that the tick advances; both touch `Bus`/`PathPool`.
                (spawn_buses, tick_buses)
                    .chain()
                    .in_set(crate::game::SimStep::PublicTransport)
                    .run_if(in_state(AppState::InGame)),
            )
            // Visual-only: (re)draw bus-stop markers when routes change (Update, no sim effect).
            .add_systems(
                Update,
                render_bus_stops
                    .in_set(crate::game::sets::GameSet::RenderSync)
                    .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
            );
    }
}

/// (Re)spawn one map marker per route stop whenever the route set changes (route seeded, reset,
/// or replaced — keyed on `BusRouteManager::version`). Markers are plain sprites at the stop tile
/// centres, drawn just under the vehicle layer.
fn render_bus_stops(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    route_mgr: Res<BusRouteManager>,
    q_markers: Query<Entity, With<BusStopMarker>>,
    mut last_version: Local<Option<u64>>,
) {
    if *last_version == Some(route_mgr.version) {
        return;
    }
    *last_version = Some(route_mgr.version);
    for e in q_markers.iter() {
        commands.entity(e).despawn();
    }
    for route in &route_mgr.routes {
        for &stop in &route.stops {
            let world = tile_to_world(&cfg, stop);
            commands.spawn((
                Sprite {
                    color: BUS_STOP_COLOR,
                    custom_size: Some(Vec2::splat(cfg.tile_size * 0.7)),
                    ..default()
                },
                Transform::from_xyz(world.x, world.y, 9.0),
                BusStopMarker,
            ));
        }
    }
}

/// A bus stop location on a route.
#[derive(Component, Debug)]
pub struct BusStop {
    pub pos: TilePos,
    pub route_id: u32,
    pub stop_index: usize,
}

/// Bus vehicle component (rides on top of a `Vehicle`). No passenger accounting in Phase A.
#[derive(Component, Debug)]
pub struct Bus {
    pub route_id: u32,
    /// Index into the route's `stops` the bus is currently driving toward.
    pub target_stop_idx: usize,
    pub state: BusState,
    /// Seconds the bus has been Driving without advancing its path cursor (wedge detector).
    pub wedge_secs: f32,
    /// Path cursor at the previous tick, to detect progress for the wedge timer.
    pub last_cursor: usize,
    /// Seconds until the next allowed re-plan attempt after a failed one (backoff, not persisted).
    pub replan_cooldown_secs: f32,
}

/// Seconds a bus may sit wedged (Driving, not advancing) before it re-plans / skips a stop.
/// Buses are despawn-immune persistent agents, so without self-heal a wedged one blocks a road
/// forever. Must exceed the worst-case queue wait at a signalized intersection (max light cycle is
/// ~34 s): a bus queued at a red is NOT wedged, and skipping its stop for ordinary queueing makes
/// it silently miss stops. This margin covers queued-behind-cars positions that read as `FreeFlow`.
const BUS_WEDGE_RECOVER_SECS: f32 = 45.0;

/// Wedge threshold while the bus is in an intersection-control state (approaching / queued /
/// waiting for green / crossing). Longer than the FreeFlow threshold — traffic control is
/// legitimate waiting — but NOT infinite: a total exemption would recreate the
/// WaitingForGreen-wedged blind spot this codebase already fixed once for cars (a bus stuck at a
/// never-granted approach would block a road forever, with no destination-changing recovery).
const BUS_WEDGE_RECOVER_INTERSECTION_SECS: f32 = 120.0;

/// Cooldown between re-plan attempts while a bus has no reachable next stop (Dwelling arm).
/// Without it the bus retried `plan_from_tile` every 10 Hz tick — n uncached A* searches per tick
/// per bus — the replan-storm class this repo already fixed once for cars (47/s -> 1.6/s).
const BUS_REPLAN_BACKOFF_SECS: f32 = 5.0;

/// Cooldown between bus spawn attempts after a failed one (route currently unroutable).
const BUS_SPAWN_RETRY_SECS: f64 = 5.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BusState {
    Driving,
    Dwelling { timer: f32 },
}

/// An ordered stop sequence. Buses loop it: `stops[i] -> stops[i+1] -> ... -> stops[0]`.
#[derive(Debug, Clone)]
pub struct BusRoute {
    pub id: u32,
    pub stops: Vec<TilePos>,
}

/// All active bus routes.
#[derive(Resource, Default)]
pub struct BusRouteManager {
    pub routes: Vec<BusRoute>,
    pub next_route_id: u32,
    /// Bumped on every route set change; change-detection key for the stop-marker renderer.
    /// (A COUNT of stops is not enough: an equal-count route replacement within one frame would
    /// silently skip the marker rebuild and leave markers at stale positions.)
    pub version: u64,
}

impl BusRouteManager {
    pub fn create_route(&mut self, stops: Vec<TilePos>) -> u32 {
        let id = self.next_route_id;
        self.next_route_id = self.next_route_id.wrapping_add(1);
        self.routes.push(BusRoute { id, stops });
        self.version = self.version.wrapping_add(1);
        id
    }

    pub fn get_route(&self, id: u32) -> Option<&BusRoute> {
        self.routes.iter().find(|r| r.id == id)
    }

    /// Clear all routes and rewind the id counter — called on map load/regeneration.
    /// Callers MUST also despawn existing `Bus` entities: buses are despawn-immune persistent
    /// agents, and a stale bus's `route_id` collides with the rewound id counter, permanently
    /// suppressing `spawn_buses` for the new route (see `handle_load_test_city` / `GenerateMap`).
    pub fn reset(&mut self) {
        self.routes.clear();
        self.next_route_id = 0;
        self.version = self.version.wrapping_add(1);
    }
}

/// Number of 4-neighbour road tiles (a tile's road "degree"). Degree >= 2 means a through-road
/// (not a dead-end stub), so a bus routed there can leave again toward the next stop.
fn road_degree(grid: &MapGrid, p: TilePos) -> usize {
    let neigh = [
        TilePos { x: p.x - 1, y: p.y },
        TilePos { x: p.x + 1, y: p.y },
        TilePos { x: p.x, y: p.y - 1 },
        TilePos { x: p.x, y: p.y + 1 },
    ];
    neigh
        .iter()
        .filter(|n| grid.get(**n).is_some_and(|c| !c.water && c.road.is_some()))
        .count()
}

/// Nearest through-road tile (degree >= 2) to `around`, by expanding square rings up to `max_r`.
/// Deterministic. Returns `None` if none found — avoids picking a dead-end stub as a stop.
fn nearest_through_road(grid: &MapGrid, around: TilePos, max_r: i32) -> Option<TilePos> {
    for r in 0..=max_r {
        for dy in -r..=r {
            for dx in -r..=r {
                if dx.abs().max(dy.abs()) != r {
                    continue; // ring perimeter only
                }
                let p = TilePos {
                    x: around.x + dx,
                    y: around.y + dy,
                };
                if grid.get(p).is_some_and(|c| !c.water && c.road.is_some())
                    && road_degree(grid, p) >= 2
                {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// Seed one deterministic demo route for the test city: a CIRCULAR tour. Eight anchor points are
/// sampled evenly around the road centroid (at ~0.35 of the roaded bounds) and each snapped to the
/// nearest through-road tile, ordered by angle so the bus loops around the city. Through-road
/// snapping keeps stops off dead-end stubs; unroutable legs are skipped at runtime
/// (`plan_from_tile`). Player-placed routes are Phase B. No-op if the city has too little road.
pub fn seed_demo_bus_route(grid: &MapGrid, mgr: &mut BusRouteManager) {
    if !mgr.routes.is_empty() {
        return;
    }
    // Centroid + bounds of the road network.
    let (mut sx, mut sy, mut cnt) = (0i64, 0i64, 0i64);
    let (mut minx, mut miny, mut maxx, mut maxy) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for y in 0..grid.height {
        for x in 0..grid.width {
            if grid
                .get(TilePos { x, y })
                .is_some_and(|c| !c.water && c.road.is_some())
            {
                sx += x as i64;
                sy += y as i64;
                cnt += 1;
                minx = minx.min(x);
                miny = miny.min(y);
                maxx = maxx.max(x);
                maxy = maxy.max(y);
            }
        }
    }
    if cnt < 8 {
        return;
    }
    let cx = (sx / cnt) as f32;
    let cy = (sy / cnt) as f32;
    let rx = ((maxx - minx) as f32 * 0.35).max(4.0);
    let ry = ((maxy - miny) as f32 * 0.35).max(4.0);

    const STOPS: usize = 8;
    let max_r = grid.width.max(grid.height);
    let mut stops: Vec<TilePos> = Vec::new();
    for i in 0..STOPS {
        let ang = std::f32::consts::TAU * (i as f32) / (STOPS as f32);
        let anchor = TilePos {
            x: (cx + rx * ang.cos()).round() as i32,
            y: (cy + ry * ang.sin()).round() as i32,
        };
        if let Some(p) = nearest_through_road(grid, anchor, max_r)
            && !stops.contains(&p)
        {
            stops.push(p);
        }
    }
    if stops.len() >= 3 {
        mgr.create_route(stops);
    }
}

/// Plan lanelet-first from `from_tile` to the first REACHABLE stop scanning forward from
/// `after_idx` (wrapping). Returns the opaque planned route + reached stop index; the caller
/// MUST consume it via apply_route / into_spawn_parts. Skipping unroutable stops keeps a bus
/// from wedging on a leg it cannot complete.
fn plan_from_tile(
    replan: &mut LaneletReplanRes,
    ctx: &mut PathfindingCtx,
    grid: &MapGrid,
    stops: &[TilePos],
    from_tile: TilePos,
    after_idx: usize,
) -> Option<(PlannedRoute, usize)> {
    let n = stops.len();
    for k in 1..=n {
        let idx = (after_idx + k) % n;
        let Some(goal) = adjacent_road_towards(grid, stops[idx], from_tile) else {
            continue;
        };
        if goal == from_tile {
            continue; // already at this stop's road — try the next stop
        }
        if let Some(planned) = plan_tiles_lanelet_first(replan, ctx, from_tile, goal) {
            return Some((planned, idx));
        }
    }
    None
}

/// World position of a tile center, matching the traffic renderer's `map_origin` convention.
fn tile_to_world(cfg: &MapConfig, pos: TilePos) -> Vec2 {
    let origin = Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    );
    origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size)
}

/// Car-shaped body sprite (same dimensions as regular vehicles). Shared by buses/service vehicles.
pub(crate) fn car_body_sprite(cfg: &MapConfig, body: Color) -> Sprite {
    Sprite {
        color: body,
        custom_size: Some(Vec2::new(
            cfg.tile_size * VEHICLE_VISUAL_LENGTH_TILES,
            cfg.tile_size * VEHICLE_VISUAL_WIDTH_TILES,
        )),
        ..default()
    }
}

/// Roof-symbol child sprite (small contrasting square that reads as "special vehicle").
pub(crate) fn roof_marker_sprite(cfg: &MapConfig, color: Color) -> Sprite {
    Sprite {
        color,
        custom_size: Some(Vec2::splat(cfg.tile_size * 0.35)),
        ..default()
    }
}

/// Spawn one bus per route as a real `Vehicle` on a lanelet-first route (road-A* fallback) to its
/// first stop.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn spawn_buses(
    mut commands: Commands,
    route_mgr: Res<BusRouteManager>,
    grid: Res<MapGrid>,
    cfg: Res<MapConfig>,
    traffic_cfg: Res<TrafficConfig>,
    traffic: Res<TrafficOccupancy>,
    graph: Res<RoadGraph>,
    regions: Res<RegionGraph>,
    path_cfg: Res<PathfindingConfig>,
    intersections: Res<IntersectionIndex>,
    time: Res<Time>,
    mut path_cache: ResMut<PathCache>,
    mut path_pool: ResMut<PathPool>,
    q_existing: Query<&Bus>,
    mut next_retry_by_route: Local<std::collections::HashMap<u32, f64>>,
    mut replan: LaneletReplanRes,
) {
    let now_sec = time.elapsed_secs_f64();
    for route in &route_mgr.routes {
        if route.stops.len() < 2 {
            continue;
        }
        if q_existing.iter().any(|b| b.route_id == route.id) {
            continue; // one bus per route (Phase A)
        }
        // PER-ROUTE backoff after a failed attempt: an unroutable route otherwise retried a full
        // (uncached-on-failure) plan every 10 Hz tick, forever — and a SHARED backoff would let
        // one permanently-unroutable route starve every other route's spawn. Keyed lookups only
        // (never iterated), so the HashMap cannot introduce ordering nondeterminism.
        if now_sec < next_retry_by_route.get(&route.id).copied().unwrap_or(0.0) {
            continue;
        }
        let mut ctx = PathfindingCtx {
            time_now_sec: now_sec,
            cfg: &path_cfg,
            cache: &mut path_cache,
            graph: &graph,
            regions: Some(&regions),
            traffic: &traffic,
            grid: &grid,
            intersections: &intersections,
        };
        // Start at a road near stop 0 and plan to the first reachable stop after it.
        let Some(start) = adjacent_road_towards(&grid, route.stops[0], route.stops[1]) else {
            next_retry_by_route.insert(route.id, now_sec + BUS_SPAWN_RETRY_SECS);
            continue;
        };
        let Some((planned, next_idx)) =
            plan_from_tile(&mut replan, &mut ctx, &grid, &route.stops, start, 0)
        else {
            next_retry_by_route.insert(route.id, now_sec + BUS_SPAWN_RETRY_SECS);
            continue;
        };
        note_bus_producer(&mut replan, &planned);
        let (path_handle, lanelet_plan) = planned.into_spawn_parts(&mut path_pool);

        let world_pos = tile_to_world(&cfg, start);
        commands
            .spawn((
                car_body_sprite(&cfg, BUS_COLOR),
                Transform::from_xyz(world_pos.x, world_pos.y, 10.0),
                Vehicle {
                    path_handle,
                    path_cursor: 0,
                    progress: 0.0,
                    tile_pos: start,
                    speed: 0.0,
                    max_speed: kmh_to_world_speed(&cfg, &traffic_cfg, BUS_MAX_SPEED_KMH),
                    speed_factor: 1.0,
                    max_accel: 20.0,
                    prev_world_pos: world_pos,
                    curr_world_pos: world_pos,
                    is_reversing: false,
                },
                VehicleTrafficState::FreeFlow,
                lanelet_plan,
                Bus {
                    route_id: route.id,
                    target_stop_idx: next_idx,
                    state: BusState::Driving,
                    wedge_secs: 0.0,
                    last_cursor: 0,
                    replan_cooldown_secs: 0.0,
                },
            ))
            .with_children(|parent| {
                parent.spawn((
                    roof_marker_sprite(&cfg, BUS_ROOF_COLOR),
                    Transform::from_xyz(0.0, 0.0, 1.0),
                    VehicleRoofMarker,
                ));
            });
    }
}

/// Advance each bus's stop/dwell state machine: on reaching its target stop the bus dwells for
/// `DWELL_SECS`, then advances to the next stop and re-plans a lanelet-first route to it
/// (road-A* fallback, looping).
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn tick_buses(
    time: Res<Time<Fixed>>,
    route_mgr: Res<BusRouteManager>,
    grid: Res<MapGrid>,
    traffic: Res<TrafficOccupancy>,
    graph: Res<RoadGraph>,
    regions: Res<RegionGraph>,
    path_cfg: Res<PathfindingConfig>,
    intersections: Res<IntersectionIndex>,
    mut path_cache: ResMut<PathCache>,
    mut path_pool: ResMut<PathPool>,
    mut replan: LaneletReplanRes,
    mut q: Query<(
        &mut Bus,
        &mut Vehicle,
        &VehicleTrafficState,
        &mut VehicleLaneletPlan,
    )>,
) {
    let dt = time.delta_secs();
    let now_sec = time.elapsed_secs_f64();
    for (mut bus, mut vehicle, traffic_state, mut lanelet_plan) in q.iter_mut() {
        let path_len = path_pool.len(vehicle.path_handle);
        let path_done = vehicle.path_cursor >= path_len;

        bus.replan_cooldown_secs = (bus.replan_cooldown_secs - dt).max(0.0);

        // Track progress for the wedge detector (Driving only).
        if vehicle.path_cursor != bus.last_cursor {
            bus.last_cursor = vehicle.path_cursor;
            bus.wedge_secs = 0.0;
        }

        match bus.state {
            BusState::Driving => {
                if path_done {
                    // External systems (stuck-recovery reverse-escape, swap_break deferred routes)
                    // may replace or truncate the path, so "path done" does not guarantee we are AT
                    // the target stop. Dwelling mid-road and then advancing past the target would
                    // silently skip it — instead re-plan to the SAME target from where we ended up.
                    let at_stop = route_mgr.get_route(bus.route_id).is_some_and(|route| {
                        route.stops.get(bus.target_stop_idx).is_some_and(|&s| {
                            (vehicle.tile_pos.x - s.x).abs() + (vehicle.tile_pos.y - s.y).abs() <= 2
                        })
                    });
                    if at_stop {
                        bus.state = BusState::Dwelling { timer: DWELL_SECS };
                        bus.wedge_secs = 0.0;
                        vehicle.speed = 0.0;
                        continue;
                    }
                    if bus.replan_cooldown_secs > 0.0 {
                        continue;
                    }
                    let Some(route) = route_mgr.get_route(bus.route_id) else {
                        continue;
                    };
                    if route.stops.len() < 2 {
                        continue;
                    }
                    let n = route.stops.len();
                    let mut ctx = mk_ctx(
                        now_sec,
                        &path_cfg,
                        &mut path_cache,
                        &graph,
                        &regions,
                        &traffic,
                        &grid,
                        &intersections,
                    );
                    // `after_idx = target - 1` so the CURRENT target is the first candidate.
                    if let Some((planned, next_idx)) = plan_from_tile(
                        &mut replan,
                        &mut ctx,
                        &grid,
                        &route.stops,
                        vehicle.tile_pos,
                        (bus.target_stop_idx + n - 1) % n,
                    ) {
                        note_bus_producer(&mut replan, &planned);
                        apply_route(
                            &mut vehicle,
                            Some(&mut *lanelet_plan),
                            &mut path_pool,
                            planned,
                        );
                        bus.target_stop_idx = next_idx;
                        bus.last_cursor = 0;
                        bus.wedge_secs = 0.0;
                    } else {
                        bus.replan_cooldown_secs = BUS_REPLAN_BACKOFF_SECS;
                    }
                    continue;
                }
                // Wedge self-heal: a despawn-immune bus that stops advancing must re-plan or skip a
                // stop, else it blocks a road forever. Accumulate while stalled, but judge against
                // a state-dependent threshold: intersection control (red light, queue, arbiter
                // wait) is legitimate waiting and gets a much LONGER threshold — not an exemption,
                // which would leave a bus wedged at a never-granted approach with no recovery
                // (the WaitingForGreen blind spot, previously seen with cars).
                if vehicle.speed < 0.1 {
                    bus.wedge_secs += dt;
                } else {
                    bus.wedge_secs = 0.0;
                }
                let at_intersection = !matches!(
                    traffic_state,
                    VehicleTrafficState::FreeFlow | VehicleTrafficState::Accelerating
                );
                let threshold = if at_intersection {
                    BUS_WEDGE_RECOVER_INTERSECTION_SECS
                } else {
                    BUS_WEDGE_RECOVER_SECS
                };
                if bus.wedge_secs < threshold {
                    continue;
                }
                let Some(route) = route_mgr.get_route(bus.route_id) else {
                    continue;
                };
                if route.stops.len() < 2 {
                    continue;
                }
                let Some(cur_tile) = path_pool.get_tile(vehicle.path_handle, vehicle.path_cursor)
                else {
                    continue;
                };
                let mut ctx = mk_ctx(
                    now_sec,
                    &path_cfg,
                    &mut path_cache,
                    &graph,
                    &regions,
                    &traffic,
                    &grid,
                    &intersections,
                );
                // Wedged: SKIP the current target and head for the next reachable stop. Re-routing
                // to the same target just replans the same jammed leg (road-A* is topology-based);
                // changing the destination changes direction and escapes the jam.
                if let Some((planned, next_idx)) = plan_from_tile(
                    &mut replan,
                    &mut ctx,
                    &grid,
                    &route.stops,
                    cur_tile,
                    bus.target_stop_idx,
                ) {
                    note_bus_producer(&mut replan, &planned);
                    apply_route(
                        &mut vehicle,
                        Some(&mut *lanelet_plan),
                        &mut path_pool,
                        planned,
                    );
                    bus.target_stop_idx = next_idx;
                    bus.last_cursor = 0;
                }
                bus.wedge_secs = 0.0;
            }
            BusState::Dwelling { timer } => {
                let remaining = timer - dt;
                if remaining > 0.0 {
                    bus.state = BusState::Dwelling { timer: remaining };
                    continue;
                }
                if bus.replan_cooldown_secs > 0.0 {
                    continue; // backoff after a failed plan; keep dwelling until it expires
                }
                let Some(route) = route_mgr.get_route(bus.route_id) else {
                    continue;
                };
                if route.stops.len() < 2 {
                    continue;
                }
                let from_tile = path_pool
                    .get_tile(vehicle.path_handle, path_len.saturating_sub(1))
                    .unwrap_or(vehicle.tile_pos);
                let mut ctx = mk_ctx(
                    now_sec,
                    &path_cfg,
                    &mut path_cache,
                    &graph,
                    &regions,
                    &traffic,
                    &grid,
                    &intersections,
                );
                // Advance from the stop we just arrived at to the next REACHABLE stop.
                let Some((planned, next_idx)) = plan_from_tile(
                    &mut replan,
                    &mut ctx,
                    &grid,
                    &route.stops,
                    from_tile,
                    bus.target_stop_idx,
                ) else {
                    // No reachable next stop right now; keep dwelling and retry after the backoff
                    // (NOT next tick — that was n uncached A* searches per bus per 10 Hz tick).
                    bus.replan_cooldown_secs = BUS_REPLAN_BACKOFF_SECS;
                    continue;
                };
                note_bus_producer(&mut replan, &planned);
                apply_route(
                    &mut vehicle,
                    Some(&mut *lanelet_plan),
                    &mut path_pool,
                    planned,
                );
                bus.target_stop_idx = next_idx;
                bus.last_cursor = 0;
                bus.state = BusState::Driving;
            }
        }
    }
}

/// Attribute a bus plan to producer stats (the adapter itself is vehicle-kind-agnostic).
fn note_bus_producer(replan: &mut LaneletReplanRes, planned: &PlannedRoute) {
    match planned.producer() {
        RouteProducer::Lanelet => {
            replan.producer_stats.bus_lanelet = replan.producer_stats.bus_lanelet.saturating_add(1)
        }
        RouteProducer::RoadFallback => {
            replan.producer_stats.bus_road_fallback =
                replan.producer_stats.bus_road_fallback.saturating_add(1)
        }
    }
}

/// Build a `PathfindingCtx` for bus routing (bundled to keep the call sites short).
#[allow(clippy::too_many_arguments)]
fn mk_ctx<'a>(
    now_sec: f64,
    path_cfg: &'a PathfindingConfig,
    path_cache: &'a mut PathCache,
    graph: &'a RoadGraph,
    regions: &'a RegionGraph,
    traffic: &'a TrafficOccupancy,
    grid: &'a MapGrid,
    intersections: &'a IntersectionIndex,
) -> PathfindingCtx<'a> {
    PathfindingCtx {
        time_now_sec: now_sec,
        cfg: path_cfg,
        cache: path_cache,
        graph,
        regions: Some(regions),
        traffic,
        grid,
        intersections,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_manager_reset_clears_routes_and_id() {
        let mut mgr = BusRouteManager::default();
        let id0 = mgr.create_route(vec![TilePos { x: 1, y: 1 }, TilePos { x: 5, y: 1 }]);
        assert_eq!(id0, 0);
        assert_eq!(mgr.routes.len(), 1);
        assert_eq!(mgr.next_route_id, 1);

        mgr.reset();
        assert!(mgr.routes.is_empty(), "reset must clear routes");
        assert_eq!(mgr.next_route_id, 0, "reset must rewind the id counter");
    }
}
