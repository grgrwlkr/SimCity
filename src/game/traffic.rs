//! M3: Traffic simulation – vehicles moving along roads via A* pathfinding.

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use rand::prelude::*;

use crate::game::camera::MainCamera;
use crate::game::commands::GameCommand;
use crate::game::ids::CitizenId;
use crate::game::intersections::{IntersectionIndex, IntersectionKey, IntersectionPriority};
use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::public_transport::{
    BusVehicle, PendingTransitTrips, PendingTrip, PublicTransportConfig, PublicTransportIndex,
};
use crate::game::roads::RoadDir;
use crate::game::services::ServiceVehicle;
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::transport::{
    PathCache, PathfindingConfig, PathfindingCtx, RegionGraph, RoadGraph, find_road_path_cached,
};
use crate::game::trips::{TripFinished, TripRequested};
use crate::game::ui_state::{OverlayMode, UiState};
use bevy::window::PrimaryWindow;

/// Vehicle entity – stores route and visual offset.
#[derive(Component)]
pub struct Vehicle {
    /// A* route as list of tile positions (from current towards goal).
    pub route: Vec<TilePos>,
    /// 0 = at start, 1 = at route[0]; interpolated smoothly.
    pub progress: f32,
    /// World units per second.
    pub speed: f32,
    /// Maximum speed for this vehicle.
    pub max_speed: f32,
    /// Maximum acceleration (world units per second squared).
    #[allow(dead_code)]
    pub max_accel: f32,
}

impl Default for Vehicle {
    fn default() -> Self {
        Self {
            route: Vec::new(),
            progress: 0.0,
            speed: 0.0,
            max_speed: 60.0, // Default speed
            max_accel: 20.0, // Default acceleration
        }
    }
}

/// State of vehicle relative to traffic lights
#[derive(Component, Debug, Clone, Copy, PartialEq)]
pub enum VehicleTrafficState {
    /// Moving freely (no traffic light ahead)
    FreeFlow,
    /// Approaching a traffic light
    Approaching {
        intersection: IntersectionKey,
        /// The first intersection tile on the route for this approach (used for stop-line distance).
        stop_tile: TilePos,
        distance_to_stop: f32,
    },
    /// Stopped in queue
    Stopped {
        intersection: IntersectionKey,
        stop_tile: TilePos,
        queue_position: u8,
    },
    /// Waiting for green light
    WaitingForGreen {
        intersection: IntersectionKey,
        stop_tile: TilePos,
    },
    /// Accelerating after green
    Accelerating,
    /// Crossing intersection
    CrossingIntersection,
}

/// Marker component for parked vehicles.
/// Parked vehicles are visually offset to the side of the road and do not block traffic.
#[derive(Component, Debug, Clone, Copy)]
pub struct Parked {
    /// Offset direction for visual placement (perpendicular to road, towards edge).
    /// Positive = right side of road (in travel direction).
    pub offset: f32,
}

// NOTE: v2 Stage B uses IDM params stored in `TrafficConfig` instead of a separate braking resource.

/// Distance to detect traffic lights ahead (in tiles)
const TRAFFIC_LIGHT_DETECTION_DISTANCE: f32 = 8.0;

/// Safe distance between vehicles in queue (in tiles)
const QUEUE_GAP: f32 = 0.3;

/// Stop line offset relative to intersection (0.0 = tile boundary)
const STOP_LINE_OFFSET: f32 = 0.15;

/// After this many seconds without progressing, try to resolve a traffic jam.
const STUCK_UTURN_SECS: f32 = 10.0;
/// After this many seconds without progressing, temporarily yield (become non-blocking) to break deadlocks.
const STUCK_YIELD_SECS: f32 = 15.0;
/// How long a yielding vehicle stays non-blocking.
const YIELD_DURATION_SECS: f32 = 4.0;
/// Maximum number of unstuck operations per tick (guardrail).
const MAX_UNSTUCK_PER_TICK: usize = 8;
/// Maximum yields before we despawn trip vehicles (prevents unbounded gridlock/lag).
const MAX_YIELDS_BEFORE_DESPAWN: u8 = 3;
/// Search radius (in tiles) for an opposite-direction lane to perform an in-place U-turn.
const OPPOSITE_LANE_SEARCH_RADIUS: i32 = 2;
/// Throttle new car spawns when congestion is extreme (keeps sim stable).
const SPAWN_THROTTLE_MAX_CONG: f32 = 0.95;
const SPAWN_THROTTLE_AVG_CONG: f32 = 0.85;

// ---------------------------------------------------------------------------
// IDM (Stage B): longitudinal dynamics (car-following)
// ---------------------------------------------------------------------------

#[derive(Debug, Copy, Clone)]
struct IdmParamsWorld {
    /// Max accel (world units / s^2)
    a: f32,
    /// Comfortable decel (world units / s^2)
    b: f32,
    /// Hard decel clamp (world units / s^2)
    b_max: f32,
    /// Desired headway (seconds)
    t_headway: f32,
    /// Min gap (world units)
    s0: f32,
    /// Acceleration exponent delta
    delta: f32,
}

fn world_per_meter(cfg: &MapConfig, traffic_cfg: &TrafficConfig) -> f32 {
    let tile_m = traffic_cfg.tile_meters.max(0.1);
    cfg.tile_size.max(0.1) / tile_m
}

fn kmh_to_world_speed(cfg: &MapConfig, traffic_cfg: &TrafficConfig, kmh: f32) -> f32 {
    let mps = kmh.max(0.0) / 3.6;
    mps * world_per_meter(cfg, traffic_cfg)
}

fn road_speed_limit_world(
    cfg: &MapConfig,
    traffic_cfg: &TrafficConfig,
    tile: TilePos,
    grid: &MapGrid,
) -> f32 {
    let Some(cell) = grid.get(tile) else {
        return 0.0;
    };
    if cell.water || !cell.road.is_some() {
        return 0.0;
    }
    // Treat RoadKind::speed_limit() as km/h (per traffic v2 spec).
    kmh_to_world_speed(cfg, traffic_cfg, cell.road.kind.speed_limit())
}

fn idm_params_world(cfg: &MapConfig, traffic_cfg: &TrafficConfig) -> IdmParamsWorld {
    let wpm = world_per_meter(cfg, traffic_cfg);
    let a = traffic_cfg.idm_max_accel_mps2.max(0.0) * wpm;
    let b = traffic_cfg.idm_comfortable_decel_mps2.max(0.0) * wpm;
    let b_max = traffic_cfg.idm_max_decel_mps2.max(0.0) * wpm;
    let s0 = traffic_cfg.idm_min_gap_m.max(0.0) * wpm;
    let t_headway = traffic_cfg.idm_desired_headway_secs.max(0.0);
    let delta = traffic_cfg.idm_delta.max(1.0);

    IdmParamsWorld {
        a: a.max(0.1),
        b: b.max(0.1),
        b_max: b_max.max(0.1).max(b.max(0.1)),
        t_headway,
        s0,
        delta,
    }
}

fn idm_accel_world(
    v: f32,
    v0: f32,
    leader: Option<(f32, f32)>, // (gap_world, leader_speed)
    params: &IdmParamsWorld,
) -> f32 {
    let v = v.max(0.0);
    let v0 = v0.max(0.1);

    let free_term = (v / v0).powf(params.delta);

    let interaction_term = if let Some((gap, v_lead)) = leader {
        let s = gap.max(0.1);
        let dv = (v - v_lead).clamp(-v0 * 2.0, v0 * 2.0);
        let sqrt_ab = (params.a * params.b).max(0.1).sqrt();
        let mut s_star = params.s0 + v * params.t_headway;
        s_star += (v * dv) / (2.0 * sqrt_ab);
        s_star = s_star.max(params.s0);
        (s_star / s).powi(2)
    } else {
        0.0
    };

    let a = params.a * (1.0 - free_term - interaction_term);
    a.clamp(-params.b_max, params.a)
}

/// Per-vehicle jam detector (in fixed-time seconds).
#[derive(Component, Debug, Clone, Copy)]
struct StuckTimer {
    secs: f32,
    last_tile: TilePos,
    last_progress: f32,
    yield_count: u8,
}

/// Temporary "yield" state: vehicle pulls aside (non-blocking) to break a deadlock.
#[derive(Component, Debug, Clone, Copy)]
struct Yielding {
    remaining_secs: f32,
}

#[derive(Component, Debug, Copy, Clone)]
struct TripPassenger {
    citizen: CitizenId,
    purpose: crate::game::trips::TripPurpose,
}

/// Traffic read model (derived data; not a source of truth).
///
/// **Semantics (punt C):**
/// - `per_tick_vehicles[idx]`: number of vehicles currently occupying the road tile at the end of
///   the latest fixed sim tick (not "cumulative visits").
/// - `ema_heat[idx]`: exponentially-smoothed view of `per_tick_vehicles` for visualization.
///   This is what the Traffic overlay uses.
#[derive(Resource, Default)]
pub struct TrafficOccupancy {
    pub per_tick_vehicles: Vec<u16>,
    pub ema_heat: Vec<f32>,
}

/// Aggregated traffic metrics for UI/economy.
#[derive(Resource, Debug, Default, Copy, Clone)]
pub struct TrafficIndex {
    pub road_tiles: u32,
    pub vehicles_on_roads: u32,
    /// Average congestion in [0..1] across road tiles.
    pub avg_congestion: f32,
    /// Max congestion in [0..1] across road tiles.
    pub max_congestion: f32,
}

/// Marker for road tile overlays that show traffic heat.
#[derive(Component)]
struct TrafficOverlayTile;

/// Cached entities for the traffic overlay to avoid per-frame spawn/despawn churn.
#[derive(Resource, Default)]
struct TrafficOverlayPool {
    entries: Vec<(Entity, usize)>, // (entity, grid_idx)
    grid_len: usize,
}

pub struct TrafficPlugin;

impl Plugin for TrafficPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<TrafficOccupancy>()
            .init_resource::<TrafficIndex>()
            .init_resource::<TrafficConfig>()
            .init_resource::<TrafficOverlayPool>()
            .add_systems(
                OnEnter(AppState::MainMenu),
                (cleanup_traffic_entities, reset_traffic_aggregates),
            )
            // Commands (should respond even when paused)
            .add_systems(
                Update,
                clear_vehicles
                    .in_set(GameSet::CommandApply)
                    .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
            )
            // Simulation
            .add_systems(
                FixedUpdate,
                (
                    update_vehicle_traffic_state,
                    update_traffic_queues.after(update_vehicle_traffic_state),
                    check_intersection_priority.after(update_traffic_queues),
                    spawn_trip_vehicles,
                    move_vehicles.after(check_intersection_priority),
                )
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            )
            // Jam recovery (run in sim; uses last tick's occupancy/graph state).
            .add_systems(
                FixedUpdate,
                (
                    init_stuck_timers,
                    tick_yielding.before(move_vehicles),
                    update_stuck_timers.after(move_vehicles),
                    resolve_stuck_vehicles.after(update_stuck_timers),
                )
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            )
            .add_systems(
                FixedUpdate,
                update_traffic_occupancy
                    .in_set(GameSet::PostSim)
                    .run_if(in_state(AppState::InGame)),
            )
            // Rendering
            .add_systems(
                Update,
                (
                    render_traffic_overlay,
                    cull_vehicle_lod,
                    update_parked_vehicle_positions,
                )
                    .in_set(GameSet::RenderSync),
            );
    }
}

#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct TrafficConfig {
    /// Hard cap on active vehicles (debug + trip-driven).
    max_active_vehicles: usize,
    /// Guardrail: max number of route plans performed per tick.
    max_route_plans_per_tick: usize,
    /// EMA decay for heatmap in [0..1). Higher = slower to change.
    heat_ema_decay: f32,
    /// If true, traffic drives on the right (US/Russia). If false, drives on the left (UK/Japan).
    #[serde(default = "default_drive_on_right")]
    pub drive_on_right: bool,

    // -----------------------------------------------------------------------
    // Traffic v2 (Stage B): longitudinal dynamics tuning (IDM) + scale
    // -----------------------------------------------------------------------
    /// Meters per tile (simulation scale). See `docs/traffic-rewrite-v2.md` (T = 10m).
    #[serde(default = "default_tile_meters")]
    tile_meters: f32,

    /// IDM desired time headway \(T\) (seconds).
    #[serde(default = "default_idm_desired_headway_secs")]
    idm_desired_headway_secs: f32,
    /// IDM minimum gap \(s_0\) (meters).
    #[serde(default = "default_idm_min_gap_m")]
    idm_min_gap_m: f32,
    /// IDM max acceleration \(a\) (m/s^2).
    #[serde(default = "default_idm_max_accel_mps2")]
    idm_max_accel_mps2: f32,
    /// IDM comfortable deceleration \(b\) (m/s^2).
    #[serde(default = "default_idm_comfortable_decel_mps2")]
    idm_comfortable_decel_mps2: f32,
    /// Hard clamp for braking (m/s^2).
    #[serde(default = "default_idm_max_decel_mps2")]
    idm_max_decel_mps2: f32,
    /// IDM acceleration exponent \(\delta\).
    #[serde(default = "default_idm_delta")]
    idm_delta: f32,
}

fn default_drive_on_right() -> bool {
    true
}

fn default_tile_meters() -> f32 {
    10.0
}

fn default_idm_desired_headway_secs() -> f32 {
    1.4
}

fn default_idm_min_gap_m() -> f32 {
    2.0
}

fn default_idm_max_accel_mps2() -> f32 {
    1.6
}

fn default_idm_comfortable_decel_mps2() -> f32 {
    2.2
}

fn default_idm_max_decel_mps2() -> f32 {
    7.0
}

fn default_idm_delta() -> f32 {
    4.0
}

impl Default for TrafficConfig {
    fn default() -> Self {
        Self {
            max_active_vehicles: 1500,
            max_route_plans_per_tick: 64,
            heat_ema_decay: 0.92,
            drive_on_right: true,
            tile_meters: default_tile_meters(),
            idm_desired_headway_secs: default_idm_desired_headway_secs(),
            idm_min_gap_m: default_idm_min_gap_m(),
            idm_max_accel_mps2: default_idm_max_accel_mps2(),
            idm_comfortable_decel_mps2: default_idm_comfortable_decel_mps2(),
            idm_max_decel_mps2: default_idm_max_decel_mps2(),
            idm_delta: default_idm_delta(),
        }
    }
}

// ---------------------------------------------------------------------------
// Systems
// ---------------------------------------------------------------------------

fn cleanup_traffic_entities(
    mut commands: Commands,
    q_vehicles: Query<Entity, With<Vehicle>>,
    q_overlay: Query<Entity, With<TrafficOverlayTile>>,
    mut overlay_pool: ResMut<TrafficOverlayPool>,
) {
    for e in q_vehicles.iter() {
        commands.entity(e).despawn();
    }
    for e in q_overlay.iter() {
        commands.entity(e).despawn();
    }
    overlay_pool.entries.clear();
    overlay_pool.grid_len = 0;
}

fn reset_traffic_aggregates(mut occ: ResMut<TrafficOccupancy>, mut idx: ResMut<TrafficIndex>) {
    occ.per_tick_vehicles.clear();
    occ.ema_heat.clear();
    *idx = TrafficIndex::default();
}

fn spawn_trip_vehicles(
    mut reader: bevy::ecs::message::MessageReader<TripRequested>,
    mut p: SpawnTripVehiclesParams,
) {
    let mut planned = 0usize;
    let mut total = p.q_vehicles.iter().count();
    let idm = idm_params_world(&p.cfg, &p.traffic_cfg);
    // Driver maximum (km/h). Actual speed is capped by per-road speed limits in `move_vehicles`.
    let driver_max_speed_world = kmh_to_world_speed(&p.cfg, &p.traffic_cfg, 130.0);
    // If the network is already gridlocked, stop spawning new cars until it clears.
    let congested = p.traffic_idx.max_congestion >= SPAWN_THROTTLE_MAX_CONG
        || p.traffic_idx.avg_congestion >= SPAWN_THROTTLE_AVG_CONG;
    for msg in reader.read() {
        if congested {
            break;
        }
        if planned >= p.traffic_cfg.max_route_plans_per_tick {
            break;
        }
        if total >= p.traffic_cfg.max_active_vehicles {
            break;
        }
        let Some(start) = adjacent_road_towards(&p.grid, msg.from, msg.to) else {
            continue;
        };
        let Some(goal) = adjacent_road_towards(&p.grid, msg.to, msg.from) else {
            continue;
        };
        let mut ctx = PathfindingCtx {
            time_now_sec: p.time.elapsed_secs_f64(),
            cfg: &p.path_cfg,
            cache: &mut p.path_cache,
            graph: &p.graph,
            regions: Some(&p.regions),
            traffic: &p.traffic,
            grid: &p.grid,
            intersections: &p.intersections,
        };

        let route = find_road_path_cached(&mut ctx, start, goal);
        // No fallback to astar_path - vehicles must follow lane rules.
        if route.is_empty() {
            continue;
        }

        // Public transport (MVP): if both endpoints are bus stops, optionally satisfy the trip
        // without spawning an individual car.
        if let (Some(pt), Some(pt_cfg), Some(pending)) =
            (p.pt.as_deref(), p.pt_cfg.as_deref(), p.pt_pending.as_mut())
            && pt.stops.contains(&start)
            && pt.stops.contains(&goal)
        {
            let mut rng = rand::rng();
            if rng.random_range(0.0..1.0) <= pt_cfg.adoption_rate.clamp(0.0, 1.0) {
                let dist_world = (route.len() as f32) * p.cfg.tile_size;
                let travel_secs =
                    (dist_world / pt_cfg.bus_speed.max(1.0)) + pt_cfg.wait_secs.max(0.0);
                pending.trips.push(PendingTrip {
                    citizen: msg.citizen,
                    purpose: msg.purpose,
                    remaining_secs: travel_secs,
                });
                planned += 1;
                continue;
            }
        }

        let world_pos = tile_to_world(&p.cfg, start);
        p.commands.spawn((
            Sprite {
                color: Color::linear_rgb(0.95, 0.95, 0.95),
                custom_size: Some(Vec2::splat(p.cfg.tile_size * 0.55)),
                ..default()
            },
            Transform::from_xyz(world_pos.x, world_pos.y, 10.0),
            Vehicle {
                route,
                progress: 0.0,
                speed: 0.0,
                max_speed: driver_max_speed_world,
                max_accel: idm.a,
            },
            VehicleTrafficState::FreeFlow,
            TripPassenger {
                citizen: msg.citizen,
                purpose: msg.purpose,
            },
        ));
        planned += 1;
        total += 1;
    }
}

#[derive(SystemParam)]
struct SpawnTripVehiclesParams<'w, 's> {
    commands: Commands<'w, 's>,
    grid: Res<'w, MapGrid>,
    cfg: Res<'w, MapConfig>,
    time: Res<'w, Time<bevy::time::Fixed>>,
    graph: Res<'w, RoadGraph>,
    regions: Res<'w, RegionGraph>,
    traffic: Res<'w, TrafficOccupancy>,
    traffic_idx: Res<'w, TrafficIndex>,
    path_cfg: Res<'w, PathfindingConfig>,
    path_cache: ResMut<'w, PathCache>,
    intersections: Res<'w, IntersectionIndex>,
    pt_cfg: Option<Res<'w, PublicTransportConfig>>,
    pt: Option<Res<'w, PublicTransportIndex>>,
    pt_pending: Option<ResMut<'w, PendingTransitTrips>>,
    q_vehicles: Query<'w, 's, Entity, With<Vehicle>>,
    traffic_cfg: Res<'w, TrafficConfig>,
}

/// Despawn all vehicles when GameCommand::GenerateMap is received.
fn clear_vehicles(
    mut reader: bevy::ecs::message::MessageReader<GameCommand>,
    mut commands: Commands,
    q_vehicles: Query<Entity, With<Vehicle>>,
    mut occ: ResMut<TrafficOccupancy>,
    mut idx: ResMut<TrafficIndex>,
) {
    for msg in reader.read() {
        if matches!(msg, GameCommand::GenerateMap { .. }) {
            for entity in q_vehicles.iter() {
                commands.entity(entity).despawn();
            }
            // C) Traffic: reset derived aggregates when regenerating map.
            occ.per_tick_vehicles.clear();
            occ.ema_heat.clear();
            *idx = TrafficIndex::default();
        }
    }
}

fn init_stuck_timers(
    mut commands: Commands,
    q: Query<(Entity, &Vehicle), (With<Vehicle>, Without<StuckTimer>)>,
) {
    for (e, v) in q.iter() {
        let Some(tile) = v.route.first().copied() else {
            continue;
        };
        commands.entity(e).insert(StuckTimer {
            secs: 0.0,
            last_tile: tile,
            last_progress: v.progress,
            yield_count: 0,
        });
    }
}

fn tick_yielding(
    time: Res<Time<Fixed>>,
    mut commands: Commands,
    mut q: Query<
        (
            Entity,
            &mut Yielding,
            &mut Vehicle,
            &mut VehicleTrafficState,
            Option<&mut StuckTimer>,
        ),
        With<Parked>,
    >,
) {
    let dt = time.delta_secs();
    for (e, mut yielding, mut v, mut state, stuck) in q.iter_mut() {
        yielding.remaining_secs -= dt;
        v.speed = 0.0;
        if yielding.remaining_secs > 0.0 {
            continue;
        }

        // Return to traffic.
        commands.entity(e).remove::<Yielding>();
        commands.entity(e).remove::<Parked>();
        *state = VehicleTrafficState::FreeFlow;

        if let Some(mut stuck) = stuck {
            stuck.secs = 0.0;
            if let Some(tile) = v.route.first().copied() {
                stuck.last_tile = tile;
                stuck.last_progress = v.progress;
            }
        }
    }
}

fn update_stuck_timers(
    time: Res<Time<Fixed>>,
    mut q: Query<(&Vehicle, &VehicleTrafficState, &mut StuckTimer), Without<Parked>>,
) {
    let dt = time.delta_secs();
    for (v, state, mut stuck) in q.iter_mut() {
        let Some(tile) = v.route.first().copied() else {
            stuck.secs = 0.0;
            continue;
        };

        let progressed = tile != stuck.last_tile || (v.progress - stuck.last_progress).abs() > 0.02;

        // Legitimate waiting at lights/stop signs shouldn't trigger jam resolution.
        if progressed
            || matches!(
                *state,
                VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. }
            )
        {
            stuck.secs = 0.0;
        } else {
            stuck.secs += dt;
        }

        stuck.last_tile = tile;
        stuck.last_progress = v.progress;
    }
}

fn find_opposite_lane_tile(grid: &MapGrid, current: TilePos) -> Option<TilePos> {
    let cell = grid.get(current)?;
    let road = cell.road;
    if !road.is_some() || road.dir == RoadDir::None {
        return None;
    }
    let opposite = road.dir.opposite();
    if opposite == RoadDir::None {
        return None;
    }

    let mut best: Option<(i32, TilePos)> = None;
    for dy in -OPPOSITE_LANE_SEARCH_RADIUS..=OPPOSITE_LANE_SEARCH_RADIUS {
        for dx in -OPPOSITE_LANE_SEARCH_RADIUS..=OPPOSITE_LANE_SEARCH_RADIUS {
            if dx == 0 && dy == 0 {
                continue;
            }
            let pos = TilePos {
                x: current.x + dx,
                y: current.y + dy,
            };
            let Some(c) = grid.get(pos) else {
                continue;
            };
            if c.water || !c.road.is_some() {
                continue;
            }
            if c.road.dir != opposite {
                continue;
            }

            let dist = dx.abs() + dy.abs();
            match best {
                Some((best_dist, _)) if dist >= best_dist => {}
                _ => best = Some((dist, pos)),
            }
        }
    }

    best.map(|(_, p)| p)
}

fn resolve_stuck_vehicles(
    time: Res<Time<Fixed>>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    graph: Res<RoadGraph>,
    regions: Res<RegionGraph>,
    traffic: Res<TrafficOccupancy>,
    path_cfg: Res<PathfindingConfig>,
    mut path_cache: ResMut<PathCache>,
    intersections: Res<IntersectionIndex>,
    mut commands: Commands,
    mut finished: bevy::ecs::message::MessageWriter<TripFinished>,
    mut q: Query<
        (
            Entity,
            &mut Vehicle,
            &mut Transform,
            &VehicleTrafficState,
            Option<&TripPassenger>,
            Option<&ServiceVehicle>,
            Option<&BusVehicle>,
            &mut StuckTimer,
        ),
        Without<Parked>,
    >,
) {
    let mut handled = 0usize;

    let mut ctx = PathfindingCtx {
        time_now_sec: time.elapsed_secs_f64(),
        cfg: &path_cfg,
        cache: &mut path_cache,
        graph: &graph,
        regions: Some(&regions),
        traffic: &traffic,
        grid: &grid,
        intersections: &intersections,
    };

    for (e, mut v, mut tf, state, passenger, service_vehicle, bus_vehicle, mut stuck) in
        q.iter_mut()
    {
        if handled >= MAX_UNSTUCK_PER_TICK {
            break;
        }
        if v.route.is_empty() {
            stuck.secs = 0.0;
            continue;
        }
        if matches!(
            *state,
            VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. }
        ) {
            continue;
        }
        if stuck.secs < STUCK_UTURN_SECS {
            continue;
        }

        let current = v.route[0];
        let goal = *v.route.last().unwrap_or(&current);

        // 1) Try an in-place U-turn: hop to the nearest opposite-direction lane tile and re-route.
        if let Some(alt_start) = find_opposite_lane_tile(&grid, current) {
            let route = find_road_path_cached(&mut ctx, alt_start, goal);
            if !route.is_empty() {
                v.route = route;
                v.progress = 0.0;
                v.speed = v.speed.min(v.max_speed * 0.5);
                let wp = tile_to_world(&cfg, alt_start);
                tf.translation.x = wp.x;
                tf.translation.y = wp.y;

                stuck.secs = 0.0;
                stuck.last_tile = alt_start;
                stuck.last_progress = 0.0;
                handled += 1;
                continue;
            }
        }

        // 2) If still stuck for longer, temporarily yield (become non-blocking) to break deadlocks.
        if stuck.secs >= STUCK_YIELD_SECS {
            // After repeated yields, despawn trip vehicles to avoid unbounded gridlock/lag.
            if service_vehicle.is_none()
                && bus_vehicle.is_none()
                && passenger.is_some()
                && stuck.yield_count >= MAX_YIELDS_BEFORE_DESPAWN
            {
                if let Some(p) = passenger {
                    finished.write(TripFinished {
                        citizen: p.citizen,
                        purpose: p.purpose,
                    });
                }
                commands.entity(e).despawn();
                handled += 1;
                continue;
            }

            commands.entity(e).insert(Parked { offset: 1.0 });
            commands.entity(e).insert(Yielding {
                remaining_secs: YIELD_DURATION_SECS,
            });
            v.speed = 0.0;
            stuck.secs = 0.0;
            stuck.yield_count = stuck.yield_count.saturating_add(1);
            handled += 1;
        }
    }
}

/// Move vehicles along their routes.
#[allow(clippy::type_complexity)]
fn move_vehicles(
    time: Res<Time<Fixed>>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    traffic: Res<TrafficOccupancy>,
    traffic_cfg: Res<TrafficConfig>,
    mut commands: Commands,
    mut finished: bevy::ecs::message::MessageWriter<TripFinished>,
    mut vehicles: ParamSet<(
        Query<
            (
                Entity,
                &mut Vehicle,
                &mut Transform,
                &VehicleTrafficState,
                Option<&TripPassenger>,
                Option<&ServiceVehicle>,
                Option<&BusVehicle>,
            ),
            Without<Parked>,
        >,
        Query<(Entity, &Vehicle), (With<Vehicle>, Without<Parked>)>,
    )>,
) {
    let dt = time.delta_secs();
    let idm = idm_params_world(&cfg, &traffic_cfg);

    // Collect vehicle positions before iterating to avoid query conflicts
    let vehicle_positions: Vec<(Entity, TilePos, f32, f32)> = vehicles
        .p1()
        .iter()
        .filter_map(|(entity, vehicle)| {
            if vehicle.route.is_empty() {
                return None;
            }
            let current_tile = vehicle.route[0];
            Some((entity, current_tile, vehicle.progress, vehicle.speed))
        })
        .collect();

    // Build a per-tile ordering so leader detection is O(N log N) instead of O(N^2).
    let mut by_tile: std::collections::HashMap<TilePos, Vec<(Entity, f32, f32)>> =
        std::collections::HashMap::new();
    for (e, t, p, spd) in vehicle_positions.iter().copied() {
        by_tile.entry(t).or_default().push((e, p, spd));
    }
    for list in by_tile.values_mut() {
        list.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    }

    // For each vehicle, leader on the same tile (gap + leader speed).
    let mut leader_same_tile: std::collections::HashMap<Entity, (f32, f32)> =
        std::collections::HashMap::new();
    // For each tile, the earliest vehicle (closest to the start of the tile): (progress, speed).
    let mut tile_min_progress: std::collections::HashMap<TilePos, (f32, f32)> =
        std::collections::HashMap::new();
    for (tile, list) in by_tile.iter() {
        if let Some((_, min_p, min_spd)) = list.first() {
            tile_min_progress.insert(*tile, (*min_p, *min_spd));
        }
        for w in list.windows(2) {
            let (ego_e, ego_p, _ego_v) = w[0];
            let (_lead_e, lead_p, lead_v) = w[1];
            let gap_world = ((lead_p - ego_p).max(0.0)) * cfg.tile_size.max(0.1);
            leader_same_tile.insert(ego_e, (gap_world, lead_v));
        }
    }

    for (entity, mut v, mut tf, state, passenger, service_vehicle, bus_vehicle) in
        vehicles.p0().iter_mut()
    {
        if v.route.is_empty() {
            // Arrived – despawn trip vehicles, keep service vehicles (idle).
            if service_vehicle.is_none() && bus_vehicle.is_none() {
                if let Some(p) = passenger {
                    finished.write(TripFinished {
                        citizen: p.citizen,
                        purpose: p.purpose,
                    });
                }
                commands.entity(entity).despawn();
            }
            continue;
        }

        // --- Desired speed from speed limits (RoadKind.speed_limit() is treated as km/h).
        let current_tile = v.route[0];
        let speed_limit_world = road_speed_limit_world(&cfg, &traffic_cfg, current_tile, &grid);
        let v0 = speed_limit_world.min(v.max_speed).max(0.0);

        // --- Leader detection (tile-local) + virtual leaders (stop lines / blocked next tile).
        let mut leader: Option<(f32, f32)> = leader_same_tile.get(&entity).copied();
        if v.route.len() > 1 {
            let next_tile = v.route[1];
            if let Some((min_p, lead_v)) = tile_min_progress.get(&next_tile).copied() {
                let gap_tiles = (1.0 - v.progress) + min_p;
                let gap_world = gap_tiles.max(0.0) * cfg.tile_size.max(0.1);
                leader = Some(match leader {
                    Some((g, gv)) if g <= gap_world => (g, gv),
                    _ => (gap_world, lead_v),
                });
            }
        }

        // Virtual leader: stop line (traffic lights/stop signs).
        if let VehicleTrafficState::Approaching {
            distance_to_stop, ..
        } = state
        {
            let gap_world = distance_to_stop.max(0.0) * cfg.tile_size.max(0.1);
            let stop_leader = (gap_world, 0.0);
            leader = Some(match leader {
                Some((g, gv)) if g <= stop_leader.0 => (g, gv),
                _ => stop_leader,
            });
        }

        // If we are explicitly stopped / waiting, pin speed to zero and don't advance.
        let can_advance = !matches!(
            state,
            VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. }
        );
        if !can_advance {
            v.speed = 0.0;
        } else {
            // Virtual leader: next tile blocked by capacity or "don't block the box".
            let mut blocked_next = false;
            if v.route.len() > 1 {
                let next_tile = v.route[1];

                if let Some(next_idx) = grid.idx(next_tile)
                    && let Some(next_cell) = grid.get(next_tile)
                    && next_cell.road.is_some()
                    && next_idx < traffic.per_tick_vehicles.len()
                {
                    let cap = next_cell.road.kind.capacity_per_lane_tile();
                    let occ = traffic.per_tick_vehicles[next_idx];
                    if occ >= cap {
                        blocked_next = true;
                    }
                }

                // "Don't block the box": entering intersection requires free space to exit.
                if !blocked_next
                    && matches!(grid.get(next_tile).map(|c| c.road.dir), Some(RoadDir::None))
                {
                    let exit_tile = v.route.iter().copied().skip(2).take(6).find(|t| {
                        if let Some(c) = grid.get(*t)
                            && c.road.is_some()
                        {
                            c.road.dir != RoadDir::None
                        } else {
                            false
                        }
                    });

                    if let Some(exit_tile) = exit_tile
                        && let Some(exit_idx) = grid.idx(exit_tile)
                        && let Some(exit_cell) = grid.get(exit_tile)
                        && exit_cell.road.is_some()
                        && exit_idx < traffic.per_tick_vehicles.len()
                    {
                        let cap = exit_cell.road.kind.capacity_per_lane_tile();
                        let occ = traffic.per_tick_vehicles[exit_idx];
                        if occ >= cap {
                            blocked_next = true;
                        }
                    }
                }
            }

            if blocked_next {
                let gap_world = (1.0 - v.progress).max(0.0) * cfg.tile_size.max(0.1);
                let block_leader = (gap_world, 0.0);
                leader = Some(match leader {
                    Some((g, gv)) if g <= block_leader.0 => (g, gv),
                    _ => block_leader,
                });
            }

            // IDM speed update.
            if v0 > 0.0 {
                let accel = idm_accel_world(v.speed, v0, leader, &idm);
                v.speed = (v.speed + accel * dt).clamp(0.0, v0);
            } else {
                v.speed = 0.0;
            }

            // Advance along the current tile.
            let dprog = (v.speed * dt) / cfg.tile_size.max(0.1);

            // If the next tile is blocked, clamp progress just before the boundary.
            // This keeps the vehicle from "teleporting" into a full tile in a single tick.
            if v.route.len() > 1 && blocked_next {
                let stop_before = 0.001;
                let max_p = 1.0 - stop_before;
                let next_p = (v.progress + dprog).min(max_p);
                v.progress = next_p;
                if (max_p - v.progress).abs() < 1e-6 {
                    v.speed = 0.0;
                }
            } else {
                v.progress += dprog;
            }
        }

        while v.progress >= 1.0 && !v.route.is_empty() {
            v.progress -= 1.0;
            v.route.remove(0);
        }

        if v.route.is_empty() {
            if service_vehicle.is_none() && bus_vehicle.is_none() {
                if let Some(p) = passenger {
                    finished.write(TripFinished {
                        citizen: p.citizen,
                        purpose: p.purpose,
                    });
                }
                commands.entity(entity).despawn();
            }
            continue;
        }

        // Lerp between current tile and next.
        let curr = v.route[0];
        let next = if v.route.len() > 1 {
            v.route[1]
        } else {
            v.route[0]
        };

        let curr_world = tile_to_world(&cfg, curr);
        let next_world = tile_to_world(&cfg, next);
        let lerped = curr_world.lerp(next_world, v.progress.clamp(0.0, 1.0));
        tf.translation.x = lerped.x;
        tf.translation.y = lerped.y;
    }
}

/// Update vehicle traffic state relative to traffic lights
fn update_vehicle_traffic_state(
    _time: Res<Time<Fixed>>,
    _cfg: Res<MapConfig>,
    _grid: Res<MapGrid>,
    intersections: Res<IntersectionIndex>,
    q_lights: Query<&crate::game::intersections::TrafficLight>,
    mut q_vehicles: Query<(&Vehicle, &mut VehicleTrafficState)>,
) {
    for (vehicle, mut state) in q_vehicles.iter_mut() {
        let current_tile = vehicle.route.first().copied();

        // Find nearest traffic light on route (by index).
        let Some((intersection_key, stop_tile, distance_to_light_tile)) = find_traffic_light_ahead(
            &vehicle.route,
            vehicle.progress,
            TRAFFIC_LIGHT_DETECTION_DISTANCE,
            &intersections,
        ) else {
            // No traffic light ahead – leave non-light logic (e.g. stop signs) to other systems.
            // We only clear *light-driven* waiting states here.
            if matches!(
                *state,
                VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. }
            ) {
                *state = VehicleTrafficState::FreeFlow;
            }
            continue;
        };

        // If we're already on the light tile (intersection), don't try to "stop" here – just clear it.
        // This prevents slow creeping/stopping inside the intersection.
        if current_tile == Some(stop_tile) {
            *state = VehicleTrafficState::CrossingIntersection;
            continue;
        }

        // We only enforce "red/green" behavior if there is a TrafficLight entity.
        let Some(light) = q_lights
            .iter()
            .find(|l| l.intersection_key == intersection_key)
        else {
            *state = VehicleTrafficState::FreeFlow;
            continue;
        };

        let entry_dir = compute_entry_direction(&vehicle.route, stop_tile);
        if entry_dir == RoadDir::None {
            // Can't determine approach direction reliably – don't block.
            *state = VehicleTrafficState::FreeFlow;
            continue;
        }

        // Distance to the stop line (not to the intersection tile itself).
        let stop_distance = (distance_to_light_tile - STOP_LINE_OFFSET).max(0.0);

        let can_go = light.is_green(entry_dir)
            || (light.is_yellow(entry_dir) && distance_to_light_tile <= 2.0);
        let must_stop =
            light.is_red(entry_dir) || (light.is_yellow(entry_dir) && distance_to_light_tile > 2.0);

        // If we were stopped/waiting, only release on green.
        if matches!(
            *state,
            VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. }
        ) {
            if can_go {
                *state = VehicleTrafficState::Accelerating;
            } else {
                *state = VehicleTrafficState::WaitingForGreen {
                    intersection: intersection_key,
                    stop_tile,
                };
            }
            continue;
        }

        if must_stop {
            // Once we reached the stop line, lock into a full stop (no creeping).
            if stop_distance <= 0.0 {
                *state = VehicleTrafficState::Stopped {
                    intersection: intersection_key,
                    stop_tile,
                    queue_position: 0,
                };
            } else {
                // Approach at normal speed; braking is computed from stop_distance.
                *state = VehicleTrafficState::Approaching {
                    intersection: intersection_key,
                    stop_tile,
                    distance_to_stop: stop_distance,
                };
            }
        } else if can_go {
            // Green (or close yellow) – proceed through intersection.
            // If we were previously braking/approaching, clear it to avoid slow crawling.
            if matches!(*state, VehicleTrafficState::Approaching { .. }) {
                *state = VehicleTrafficState::CrossingIntersection;
            }
        }
    }
}

/// Find traffic light ahead on route
fn find_traffic_light_ahead(
    route: &[TilePos],
    progress: f32,
    max_distance: f32,
    intersections: &IntersectionIndex,
) -> Option<(IntersectionKey, TilePos, f32)> {
    // If we're already on a light tile, treat it as "at the light" so state machines can resolve.
    // Without this, we can get stuck in Approaching after entering the light tile.
    if let Some(first) = route.first()
        && intersections.has_traffic_light_at(*first)
        && let Some(key) = intersections.cluster_key_at(*first)
    {
        return Some((key, *first, 0.0));
    }

    let mut distance = 1.0 - progress; // Remaining distance to end of current tile

    for (_i, tile) in route.iter().enumerate().skip(1) {
        if distance > max_distance {
            return None;
        }

        if intersections.has_traffic_light_at(*tile)
            && let Some(key) = intersections.cluster_key_at(*tile)
        {
            return Some((key, *tile, distance));
        }

        distance += 1.0;
    }

    None
}

/// Compute entry direction to intersection
fn compute_entry_direction(route: &[TilePos], intersection_pos: TilePos) -> RoadDir {
    if route.len() < 2 {
        return RoadDir::None;
    }

    // Find the tile before intersection
    for i in 0..route.len().saturating_sub(1) {
        if route[i + 1] == intersection_pos {
            let from = route[i];
            let dx = intersection_pos.x - from.x;
            let dy = intersection_pos.y - from.y;

            if dx > 0 {
                return RoadDir::East;
            } else if dx < 0 {
                return RoadDir::West;
            } else if dy > 0 {
                return RoadDir::North;
            } else if dy < 0 {
                return RoadDir::South;
            }
        }
    }

    RoadDir::None
}

/// Update traffic queues before traffic lights
fn update_traffic_queues(mut q_vehicles: Query<(Entity, &Vehicle, &mut VehicleTrafficState)>) {
    use std::collections::HashMap;

    // Group vehicles by traffic light
    let mut queues: HashMap<TilePos, Vec<(Entity, f32)>> = HashMap::new();

    for (entity, vehicle, state) in q_vehicles.iter() {
        let stop_tile = match state {
            VehicleTrafficState::Stopped { stop_tile, .. }
            | VehicleTrafficState::WaitingForGreen { stop_tile, .. }
            | VehicleTrafficState::Approaching { stop_tile, .. } => *stop_tile,
            _ => continue,
        };

        // Calculate distance to light
        let dist = compute_distance_to_light(&vehicle.route, vehicle.progress, stop_tile);
        queues.entry(stop_tile).or_default().push((entity, dist));
    }

    // Sort by distance and assign queue positions
    // Use QUEUE_GAP to ensure vehicles maintain safe distance
    for (_light_pos, mut queue) in queues {
        queue.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());

        for (i, (entity, dist)) in queue.iter().enumerate() {
            if let Ok((_, _, mut state)) = q_vehicles.get_mut(*entity)
                && let VehicleTrafficState::Stopped {
                    intersection,
                    stop_tile,
                    ..
                } = &mut *state
            {
                // Update queue position
                // QUEUE_GAP is used conceptually to space vehicles in the queue
                // Vehicles are sorted by distance, and QUEUE_GAP represents the ideal spacing between vehicles
                // Check if vehicle needs position update based on QUEUE_GAP spacing
                let expected_distance = i as f32 * QUEUE_GAP;
                let distance_error = (dist - expected_distance).abs();

                // Only update if significantly out of position
                if distance_error > QUEUE_GAP * 0.5 {
                    *state = VehicleTrafficState::Stopped {
                        intersection: *intersection,
                        stop_tile: *stop_tile,
                        queue_position: i as u8,
                    };
                }
            }
        }
    }
}

/// Compute distance to traffic light along route
fn compute_distance_to_light(route: &[TilePos], progress: f32, light_pos: TilePos) -> f32 {
    if let Some(first) = route.first()
        && *first == light_pos
    {
        return 0.0;
    }
    let mut distance = 1.0 - progress;

    for tile in route.iter().skip(1) {
        if *tile == light_pos {
            return distance;
        }
        distance += 1.0;
    }

    distance
}

/// Check intersection priority rules (yield/stop signs)
fn check_intersection_priority(
    grid: Res<MapGrid>,
    intersections: Res<IntersectionIndex>,
    mut q_vehicles: Query<(Entity, &Vehicle, &mut VehicleTrafficState)>,
    q_intersections: Query<&crate::game::intersections::IntersectionPriorityMarker>,
) {
    // For intersections without traffic lights, apply priority rules
    for (_entity, vehicle, mut state) in q_vehicles.iter_mut() {
        // Only check for vehicles in FreeFlow state approaching intersections
        if !matches!(*state, VehicleTrafficState::FreeFlow) {
            continue;
        }

        // Check the NEXT tile (route[1]) so rules apply *before* entering the intersection.
        let Some(next_tile) = vehicle.route.get(1) else {
            continue;
        };

        // Skip if has traffic light (lights handle priority).
        let has_traffic_light = intersections.has_traffic_light_at(*next_tile);
        if has_traffic_light {
            continue;
        }

        // Check if this is an intersection (dir == None)
        if let Some(cell) = grid.get(*next_tile)
            && cell.road.dir == crate::game::roads::RoadDir::None
        {
            // This is an intersection - check for priority rules
            // Try to find IntersectionPriority marker at this position
            let mut found_priority = None;
            for marker in q_intersections.iter() {
                // Match by position
                if marker.pos == *next_tile {
                    found_priority = Some(marker.priority);
                    break;
                }
            }

            // Check surrounding tiles to determine if this is a main road intersection
            let mut is_main_road = false;
            for neighbor_pos in [
                TilePos {
                    x: next_tile.x - 1,
                    y: next_tile.y,
                },
                TilePos {
                    x: next_tile.x + 1,
                    y: next_tile.y,
                },
                TilePos {
                    x: next_tile.x,
                    y: next_tile.y - 1,
                },
                TilePos {
                    x: next_tile.x,
                    y: next_tile.y + 1,
                },
            ] {
                if let Some(neighbor_cell) = grid.get(neighbor_pos)
                    && neighbor_cell.road.kind.lanes() >= 4
                {
                    is_main_road = true;
                    break;
                }
            }

            // Apply priority rules based on intersection type
            match found_priority.unwrap_or(if is_main_road {
                IntersectionPriority::MainRoad
            } else {
                IntersectionPriority::None
            }) {
                IntersectionPriority::StopSign => {
                    let Some(intersection_key) = intersections.cluster_key_at(*next_tile) else {
                        continue;
                    };
                    // Stop sign - must come to complete stop BEFORE intersection.
                    // Distance to stop line is remaining distance to end of current tile minus STOP_LINE_OFFSET.
                    let dist_to_intersection = 1.0 - vehicle.progress;
                    let dist_to_stop = (dist_to_intersection - STOP_LINE_OFFSET).max(0.0);
                    *state = VehicleTrafficState::Approaching {
                        intersection: intersection_key,
                        stop_tile: *next_tile,
                        distance_to_stop: dist_to_stop,
                    };
                }
                IntersectionPriority::YieldSign => {
                    // Yield sign - MVP: keep FreeFlow (could slow slightly later).
                }
                IntersectionPriority::MainRoad => {
                    // Main road - has priority, continue normally
                }
                IntersectionPriority::None => {
                    // Default right-of-way rules apply (not implemented yet)
                }
            }
        }
    }
}

/// Update the occupancy map based on current vehicle positions.
fn update_traffic_occupancy(
    grid: Res<MapGrid>,
    mut occ: ResMut<TrafficOccupancy>,
    mut idx: ResMut<TrafficIndex>,
    q: Query<&Vehicle, Without<Parked>>,
    cfg: Res<TrafficConfig>,
) {
    // Ensure vectors match grid size.
    let len = grid.len();
    if occ.per_tick_vehicles.len() != len {
        occ.per_tick_vehicles.clear();
        occ.per_tick_vehicles.resize(len, 0);
    } else {
        occ.per_tick_vehicles.fill(0);
    }
    if occ.ema_heat.len() != len {
        occ.ema_heat.clear();
        occ.ema_heat.resize(len, 0.0);
    }

    // Count occupancy at end-of-tick. Skip parked vehicles - they don't block traffic.
    for vehicle in q.iter() {
        if let Some(pos) = vehicle.route.first()
            && let Some(idx) = grid.idx(*pos)
        {
            // saturate at u16::MAX; capacity is small in MVP anyway.
            occ.per_tick_vehicles[idx] = occ.per_tick_vehicles[idx].saturating_add(1);
        }
    }

    // Update EMA heatmap (for overlay) and compute TrafficIndex.
    let mut road_tiles = 0u32;
    let mut vehicles_on_roads = 0u32;
    let mut sum_cong = 0.0f32;
    let mut max_cong = 0.0f32;

    let decay = cfg.heat_ema_decay.clamp(0.0, 0.999);

    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(ti) = grid.idx(pos) else { continue };
            let Some(cell) = grid.get(pos) else { continue };
            if cell.water || !cell.road.is_some() {
                continue;
            }
            road_tiles += 1;

            let c = occ.per_tick_vehicles[ti] as f32;
            vehicles_on_roads = vehicles_on_roads.saturating_add(occ.per_tick_vehicles[ti] as u32);

            let cap = (cell.road.kind.capacity_per_lane_tile() as f32).max(1.0);
            let cong = (c / cap).clamp(0.0, 1.0);
            sum_cong += cong;
            if cong > max_cong {
                max_cong = cong;
            }

            // EMA: keep a smooth overlay.
            occ.ema_heat[ti] = occ.ema_heat[ti] * decay + c * (1.0 - decay);
        }
    }

    idx.road_tiles = road_tiles;
    idx.vehicles_on_roads = vehicles_on_roads;
    if road_tiles > 0 {
        idx.avg_congestion = sum_cong / (road_tiles as f32);
        idx.max_congestion = max_cong;
    } else {
        idx.avg_congestion = 0.0;
        idx.max_congestion = 0.0;
    }
}

/// Render traffic overlay on road tiles.
fn render_traffic_overlay(
    ui: Res<UiState>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    occ: Res<TrafficOccupancy>,
    mut commands: Commands,
    mut pool: ResMut<TrafficOverlayPool>,
    mut q_sprites: Query<&mut Sprite, With<TrafficOverlayTile>>,
) {
    if ui.overlay != OverlayMode::Traffic {
        // Overlay disabled: despawn cached overlay entities once.
        if !pool.entries.is_empty() {
            for (e, _) in pool.entries.drain(..) {
                commands.entity(e).despawn();
            }
            pool.grid_len = 0;
        }
        return;
    }

    if occ.ema_heat.len() != grid.len() {
        return;
    }

    let max_heat = occ
        .ema_heat
        .iter()
        .copied()
        .fold(0.0f32, |a, b| a.max(b))
        .max(0.001);

    let origin = map_origin(&cfg);

    // (Re)build cached overlay entities if needed.
    if pool.entries.is_empty() || pool.grid_len != grid.len() {
        // Clear any stale entities.
        for (e, _) in pool.entries.drain(..) {
            commands.entity(e).despawn();
        }
        pool.grid_len = grid.len();

        for y in 0..grid.height {
            for x in 0..grid.width {
                let pos = TilePos { x, y };
                let Some(idx) = grid.idx(pos) else { continue };
                let Some(cell) = grid.get(pos) else { continue };
                if !cell.road.is_some() {
                    continue;
                }

                let world = origin + Vec2::new(x as f32 * cfg.tile_size, y as f32 * cfg.tile_size);

                let e = commands
                    .spawn((
                        TrafficOverlayTile,
                        Sprite {
                            color: Color::linear_rgb(0.0, 1.0, 0.0),
                            custom_size: Some(Vec2::splat(cfg.tile_size * 0.85)),
                            ..default()
                        },
                        Transform::from_xyz(world.x, world.y, 5.0),
                    ))
                    .id();
                pool.entries.push((e, idx));
            }
        }
    }

    // Update overlay colors without respawning entities (prevents flicker and reduces CPU churn).
    for (e, idx) in pool.entries.iter().copied() {
        let Ok(mut sprite) = q_sprites.get_mut(e) else {
            continue;
        };
        let heat = (occ.ema_heat[idx] / max_heat).clamp(0.0, 1.0);
        sprite.color = Color::linear_rgb(heat, 1.0 - heat, 0.0);
    }
}

/// Simple vehicle LOD: hide vehicles outside the camera viewport.
fn cull_vehicle_lod(
    cfg: Res<MapConfig>,
    q_window: Query<&Window, With<PrimaryWindow>>,
    q_camera: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut q_vehicles: Query<(&Transform, &mut Visibility), With<Vehicle>>,
) {
    let Ok(window) = q_window.single() else {
        return;
    };
    let Ok((camera, cam_gt)) = q_camera.single() else {
        return;
    };

    let viewport = camera
        .logical_viewport_size()
        .unwrap_or(Vec2::new(window.width(), window.height()))
        .max(Vec2::ONE);
    let corners = [
        Vec2::new(0.0, 0.0),
        Vec2::new(viewport.x, 0.0),
        Vec2::new(0.0, viewport.y),
        Vec2::new(viewport.x, viewport.y),
    ];

    let mut min = Vec2::splat(f32::INFINITY);
    let mut max = Vec2::splat(f32::NEG_INFINITY);
    for c in corners {
        let Ok(w) = camera.viewport_to_world_2d(cam_gt, c) else {
            // If we can't compute bounds, keep everything visible.
            for (_, mut vis) in q_vehicles.iter_mut() {
                *vis = Visibility::Visible;
            }
            return;
        };
        min = min.min(w);
        max = max.max(w);
    }

    let margin = cfg.tile_size * 4.0;
    let min = min - Vec2::splat(margin);
    let max = max + Vec2::splat(margin);

    for (tf, mut vis) in q_vehicles.iter_mut() {
        let p = tf.translation.truncate();
        let inside = p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y;
        *vis = if inside {
            Visibility::Visible
        } else {
            Visibility::Hidden
        };
    }
}

/// Update visual positions of parked vehicles.
/// Parked vehicles are offset to the side of the road so they don't visually block traffic.
fn update_parked_vehicle_positions(
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    mut q_parked: Query<(&Vehicle, &Parked, &mut Transform, &mut Sprite)>,
) {
    for (vehicle, parked, mut tf, mut sprite) in q_parked.iter_mut() {
        let Some(tile) = vehicle.route.first().copied() else {
            continue;
        };
        let Some(cell) = grid.get(tile) else {
            continue;
        };
        if !cell.road.is_some() {
            continue;
        }

        // Make parked vehicles visually smaller and semi-transparent
        let parked_size = cfg.tile_size * 0.35;
        sprite.custom_size = Some(Vec2::splat(parked_size));
        sprite.color = Color::srgba(0.7, 0.7, 0.7, 0.7);

        // Get road direction to compute perpendicular offset
        let road_dir = cell.road.dir;

        // Offset perpendicular to road direction, towards the right edge of the lane
        let perp = match road_dir {
            RoadDir::East => Vec2::new(0.0, -1.0), // South (right side when going East)
            RoadDir::West => Vec2::new(0.0, 1.0),  // North (right side when going West)
            RoadDir::North => Vec2::new(1.0, 0.0), // East (right side when going North)
            RoadDir::South => Vec2::new(-1.0, 0.0), // West (right side when going South)
            RoadDir::None => Vec2::new(0.5, 0.5),  // Intersection - diagonal
        };

        // Calculate base tile position
        let origin = map_origin(&cfg);
        let base_world =
            origin + Vec2::new(tile.x as f32 * cfg.tile_size, tile.y as f32 * cfg.tile_size);

        // Offset by half tile to the edge (parked on the shoulder)
        let offset_amount = cfg.tile_size * 0.35 * parked.offset;
        let offset = perp * offset_amount;

        tf.translation.x = base_world.x + offset.x;
        tf.translation.y = base_world.y + offset.y;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn desired_dir(from: TilePos, to: TilePos) -> RoadDir {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    if dx.abs() >= dy.abs() {
        if dx >= 0 {
            RoadDir::East
        } else {
            RoadDir::West
        }
    } else if dy >= 0 {
        RoadDir::North
    } else {
        RoadDir::South
    }
}

fn adjacent_road_towards(grid: &MapGrid, pos: TilePos, target: TilePos) -> Option<TilePos> {
    let want = desired_dir(pos, target);
    let mut best_any = None;

    // Check pos itself first, then 4-neighbors.
    let candidates = [
        pos,
        TilePos {
            x: pos.x - 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x + 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x,
            y: pos.y - 1,
        },
        TilePos {
            x: pos.x,
            y: pos.y + 1,
        },
    ];

    for cpos in candidates {
        if let Some(cell) = grid.get(cpos)
            && !cell.water
            && cell.road.is_some()
        {
            best_any = best_any.or(Some(cpos));
            if cell.road.dir == want {
                return Some(cpos);
            }
        }
    }

    best_any
}

fn tile_to_world(cfg: &MapConfig, pos: TilePos) -> Vec2 {
    let origin = map_origin(cfg);
    origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size)
}

fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::ids::CitizenId;
    use crate::game::trips::TripPurpose;
    use bevy::app::App;
    use bevy::ecs::message::MessageReader;

    #[derive(Resource, Default)]
    struct FinishCount(u32);

    fn count_trip_finished(mut reader: MessageReader<TripFinished>, mut cnt: ResMut<FinishCount>) {
        for _ in reader.read() {
            cnt.0 += 1;
        }
    }

    #[test]
    fn vehicle_arrival_emits_trip_finished() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .add_message::<TripFinished>()
            .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
                1.0 / 10.0,
            ))
            .insert_resource(MapConfig {
                width: 8,
                height: 8,
                tile_size: 16.0,
            })
            .insert_resource(MapGrid::new(8, 8))
            .insert_resource(TrafficOccupancy::default())
            .insert_resource(TrafficConfig::default())
            .insert_resource(FinishCount::default())
            .add_systems(Update, (move_vehicles, count_trip_finished).chain());

        let citizen = CitizenId(42);
        let vehicle = app
            .world_mut()
            .spawn((
                Vehicle {
                    route: Vec::new(),
                    progress: 0.0,
                    speed: 0.0,
                    max_speed: 60.0,
                    max_accel: 20.0,
                },
                Transform::default(),
                VehicleTrafficState::FreeFlow,
                TripPassenger {
                    citizen,
                    purpose: TripPurpose::Work,
                },
            ))
            .id();

        app.update();

        assert_eq!(app.world().resource::<FinishCount>().0, 1);
        assert!(app.world().get_entity(vehicle).is_err());
    }
}
