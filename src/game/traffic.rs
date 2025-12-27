//! M3: Traffic simulation – vehicles moving along roads via A* pathfinding.

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;

use crate::game::camera::MainCamera;
use crate::game::commands::GameCommand;
use crate::game::ids::CitizenId;
use crate::game::intersections::{
    IntersectionId, IntersectionIndex, IntersectionKey, IntersectionPriority,
};
use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::public_transport::{
    BusVehicle, PendingTransitTrips, PendingTrip, PublicTransportConfig, PublicTransportIndex,
};
use crate::game::roads::{RoadDir, RoadKind};
use crate::game::services::ServiceVehicle;
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::transport::{
    PathCache, PathfindingConfig, PathfindingCtx, RegionGraph, RoadGraph, adjacent_road_towards,
    find_road_path_cached,
};
use crate::game::trips::{TripFinished, TripMode, TripRequested};
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
    /// Crossing (or admitted to) a specific logical intersection cluster.
    ///
    /// This state is used both when a vehicle is already inside the intersection tiles (`dir=None`)
    /// and when it has been released from a stop line and is about to enter the cluster.
    CrossingIntersection { intersection: IntersectionKey },
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
/// Numerical epsilon for "at stop line" checks (in tile fractions).
const STOP_LINE_EPS_TILES: f32 = 1e-3;

/// After this many seconds without progressing, try to resolve a traffic jam (reroute).
/// (v2 policy: avoid "cheat" behavior by default; only intervene after a long timeout.)
const STUCK_REROUTE_SECS: f32 = 60.0;
/// After this many seconds without progressing, despawn non-service trip vehicles as an emergency guardrail.
const STUCK_DESPAWN_SECS: f32 = 180.0;
/// Maximum number of unstuck operations per tick (guardrail).
const MAX_UNSTUCK_PER_TICK: usize = 8;
/// Throttle new car spawns when congestion is extreme (keeps sim stable).
const SPAWN_THROTTLE_MAX_CONG: f32 = 0.95;
const SPAWN_THROTTLE_AVG_CONG: f32 = 0.85;

// ---------------------------------------------------------------------------
// Stage C (initial): lane-change heuristics (keep-right + overtake) with guardrails
// ---------------------------------------------------------------------------

/// Minimum time between lane changes for a vehicle (seconds).
const LANE_CHANGE_COOLDOWN_SECS: f32 = 1.5;
/// How long we keep the "overtaking" intent before trying to return right (seconds).
const OVERTAKE_HOLD_SECS: f32 = 3.0;
/// Guardrail: max number of lane-change reroutes per tick.
const MAX_LANE_CHANGES_PER_TICK: usize = 24;
/// Disable lane changes when an intersection is close ahead on the route.
const LANE_CHANGE_INTERSECTION_LOOKAHEAD: usize = 6;
/// Trigger overtake if a slow leader is within this distance (in tiles, along-route approximation).
const OVERTAKE_LOOKAHEAD_TILES: f32 = 2.0;
/// Leader is considered "slow" if below this fraction of our desired speed.
const OVERTAKE_LEADER_SPEED_RATIO: f32 = 0.85;

// ---------------------------------------------------------------------------
// Stage F (initial): oncoming-lane overtakes on TwoLane (1+1) with strict guardrails
// ---------------------------------------------------------------------------

/// How far ahead (in tiles) the oncoming lane must be clear to start an oncoming overtake.
const ONCOMING_OVERTAKE_CLEAR_TILES: usize = 14;
/// Don't start an oncoming overtake if an intersection is close ahead on the route.
const ONCOMING_OVERTAKE_INTERSECTION_LOOKAHEAD: usize = 14;
/// Minimum number of forward tiles to stay in the oncoming lane once we pull out.
const ONCOMING_OVERTAKE_MIN_PASS_TILES: usize = 3;
/// Maximum number of forward tiles to stay in the oncoming lane once we pull out.
const ONCOMING_OVERTAKE_MAX_PASS_TILES: usize = 6;
/// Cooldown after starting an oncoming overtake (seconds).
const ONCOMING_OVERTAKE_COOLDOWN_SECS: f32 = 4.0;
/// Guardrail: max number of oncoming overtakes planned per tick.
const MAX_ONCOMING_OVERTAKES_PER_TICK: usize = 8;

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
}

/// Prevents frequent lane-change oscillations.
#[derive(Component, Debug, Clone, Copy)]
struct LaneChangeCooldown {
    remaining_secs: f32,
}

/// Marker state to prefer staying left briefly while overtaking, then returning right.
#[derive(Component, Debug, Clone, Copy)]
struct Overtaking {
    remaining_secs: f32,
}

/// Marker state for the "overtake oncoming lane" maneuver (TwoLane 1+1).
///
/// This is a **local tactic** (not part of routing). While present, we suppress normal lane-change
/// planning to avoid oscillations.
#[derive(Component, Debug, Clone, Copy)]
struct OvertakeOncoming {
    remaining_secs: f32,
}

// ---------------------------------------------------------------------------
// Stage D (initial): intersection admission via coarse reservations
// ---------------------------------------------------------------------------

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
enum ReservationState {
    /// Reserved but the vehicle is still on the approach tile.
    Approaching,
    /// Vehicle is inside the intersection cluster.
    Inside,
}

#[derive(Debug, Copy, Clone)]
struct IntersectionReservation {
    vehicle: Entity,
    state: ReservationState,
    created_at_sec: f64,
}

#[derive(Resource, Default)]
struct IntersectionReservations {
    by_intersection: std::collections::HashMap<IntersectionId, IntersectionReservation>,
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
            .init_resource::<IntersectionReservations>()
            .add_systems(
                OnEnter(AppState::MainMenu),
                (
                    cleanup_traffic_entities,
                    reset_traffic_aggregates,
                    reset_intersection_reservations,
                ),
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
                    tick_lane_change_cooldowns,
                    tick_overtaking,
                    tick_overtake_oncoming,
                    plan_lane_changes
                        .after(check_intersection_priority)
                        .after(spawn_trip_vehicles)
                        .before(move_vehicles),
                    plan_oncoming_overtakes
                        .after(plan_lane_changes)
                        .before(plan_intersection_reservations)
                        .before(move_vehicles),
                    plan_intersection_reservations
                        .after(plan_oncoming_overtakes)
                        .before(move_vehicles),
                    move_vehicles.after(plan_intersection_reservations),
                    cleanup_intersection_reservations.after(move_vehicles),
                )
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            )
            // Jam recovery (run in sim; uses last tick's occupancy/graph state).
            .add_systems(
                FixedUpdate,
                (
                    init_stuck_timers,
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

impl TrafficConfig {
    /// Simulation scale: meters per tile (Traffic v2 convention).
    pub fn tile_meters(&self) -> f32 {
        self.tile_meters
    }
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

fn reset_intersection_reservations(mut reservations: ResMut<IntersectionReservations>) {
    reservations.by_intersection.clear();
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
        // Walk trips are handled by `PedestriansPlugin`.
        if msg.mode == TripMode::Walk {
            continue;
        }
        if planned >= p.traffic_cfg.max_route_plans_per_tick {
            break;
        }
        if msg.mode == TripMode::Car && congested {
            break;
        }
        if msg.mode == TripMode::Car && total >= p.traffic_cfg.max_active_vehicles {
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

        // Public transport (MVP): mode is chosen by citizens (tour-based).
        if msg.mode == TripMode::Transit
            && let (Some(pt), Some(pt_cfg), Some(pending)) =
                (p.pt.as_deref(), p.pt_cfg.as_deref(), p.pt_pending.as_mut())
            && pt.stops.contains(&start)
            && pt.stops.contains(&goal)
        {
            let dist_world = (route.len() as f32) * p.cfg.tile_size;
            let travel_secs = (dist_world / pt_cfg.bus_speed.max(1.0)) + pt_cfg.wait_secs.max(0.0);
            pending.trips.push(PendingTrip {
                citizen: msg.citizen,
                purpose: msg.purpose,
                remaining_secs: travel_secs,
            });
            planned += 1;
            continue;
        }
        // If `mode == Transit` but transit isn't possible, fall through and spawn a car so the trip
        // can still complete.

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
    mut reservations: ResMut<IntersectionReservations>,
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
            reservations.by_intersection.clear();
        }
    }
}

#[allow(clippy::type_complexity)]
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
        });
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

#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn resolve_stuck_vehicles(
    time: Res<Time<Fixed>>,
    _cfg: Res<MapConfig>,
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

    for (e, mut v, state, passenger, service_vehicle, bus_vehicle, mut stuck) in q.iter_mut() {
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
        if stuck.secs < STUCK_REROUTE_SECS {
            continue;
        }

        let current = v.route[0];
        let goal = *v.route.last().unwrap_or(&current);

        // 1) Emergency re-route: try to find an alternative path to the same goal.
        let route = find_road_path_cached(&mut ctx, current, goal);
        if !route.is_empty() && route != v.route {
            v.route = route;
            v.progress = 0.0;
            v.speed = v.speed.min(v.max_speed * 0.5);

            stuck.secs = 0.0;
            stuck.last_tile = current;
            stuck.last_progress = 0.0;
            handled += 1;
            continue;
        }

        // 2) Last-resort guardrail: despawn non-service trip vehicles after a very long time stuck.
        if stuck.secs >= STUCK_DESPAWN_SECS
            && service_vehicle.is_none()
            && bus_vehicle.is_none()
            && passenger.is_some()
        {
            if let Some(p) = passenger {
                finished.write(TripFinished {
                    citizen: p.citizen,
                    purpose: p.purpose,
                });
            }
            commands.entity(e).despawn();
            handled += 1;
        }
    }
}

fn tick_lane_change_cooldowns(
    time: Res<Time<Fixed>>,
    mut commands: Commands,
    mut q: Query<(Entity, &mut LaneChangeCooldown)>,
) {
    let dt = time.delta_secs();
    for (e, mut cd) in q.iter_mut() {
        cd.remaining_secs -= dt;
        if cd.remaining_secs <= 0.0 {
            commands.entity(e).remove::<LaneChangeCooldown>();
        }
    }
}

fn tick_overtaking(
    time: Res<Time<Fixed>>,
    mut commands: Commands,
    mut q: Query<(Entity, &mut Overtaking)>,
) {
    let dt = time.delta_secs();
    for (e, mut ov) in q.iter_mut() {
        ov.remaining_secs -= dt;
        if ov.remaining_secs <= 0.0 {
            commands.entity(e).remove::<Overtaking>();
        }
    }
}

fn tick_overtake_oncoming(
    time: Res<Time<Fixed>>,
    mut commands: Commands,
    mut q: Query<(Entity, &mut OvertakeOncoming)>,
) {
    let dt = time.delta_secs();
    for (e, mut ov) in q.iter_mut() {
        ov.remaining_secs -= dt;
        if ov.remaining_secs <= 0.0 {
            commands.entity(e).remove::<OvertakeOncoming>();
        }
    }
}

fn route_has_near_intersection_n(route: &[TilePos], grid: &MapGrid, lookahead: usize) -> bool {
    for t in route.iter().skip(1).take(lookahead) {
        if let Some(c) = grid.get(*t)
            && c.road.is_some()
            && c.road.dir == RoadDir::None
        {
            return true;
        }
    }
    false
}

fn route_has_near_intersection(route: &[TilePos], grid: &MapGrid) -> bool {
    route_has_near_intersection_n(route, grid, LANE_CHANGE_INTERSECTION_LOOKAHEAD)
}

fn lane_change_target(grid: &MapGrid, current: TilePos, move_dir: RoadDir) -> Option<TilePos> {
    let cur_cell = grid.get(current)?;
    if cur_cell.water || !cur_cell.road.is_some() || cur_cell.road.dir == RoadDir::None {
        return None;
    }

    let delta = move_dir.delta();
    let target = TilePos {
        x: current.x + delta.x,
        y: current.y + delta.y,
    };
    let next_cell = grid.get(target)?;
    if next_cell.water || !next_cell.road.is_some() {
        return None;
    }

    let cur = cur_cell.road;
    let next = next_cell.road;

    if next.dir != cur.dir {
        return None;
    }
    if next.kind != cur.kind || next.lanes_total() != cur.lanes_total() {
        return None;
    }
    if next.lane.abs_diff(cur.lane) != 1 {
        return None;
    }

    Some(target)
}

fn oncoming_lane_offset(grid: &MapGrid, current: TilePos, travel_dir: RoadDir) -> Option<IVec2> {
    let cur_cell = grid.get(current)?;
    if cur_cell.water || !cur_cell.road.is_some() || cur_cell.road.dir == RoadDir::None {
        return None;
    }
    let cur = cur_cell.road;
    if cur.kind != RoadKind::TwoLane {
        return None;
    }

    // Oncoming lane is one tile to the left or right (perpendicular), same road kind/lane count,
    // adjacent lane index, and opposite `dir`.
    for side in [travel_dir.left(), travel_dir.right()] {
        let d = side.delta();
        let t = TilePos {
            x: current.x + d.x,
            y: current.y + d.y,
        };
        let Some(cell) = grid.get(t) else {
            continue;
        };
        if cell.water || !cell.road.is_some() || cell.road.dir == RoadDir::None {
            continue;
        }
        let next = cell.road;
        if next.kind != cur.kind || next.lanes_total() != cur.lanes_total() {
            continue;
        }
        if next.lane.abs_diff(cur.lane) != 1 {
            continue;
        }
        if next.dir != travel_dir.opposite() {
            continue;
        }
        return Some(d);
    }

    None
}

fn lane_change_safe_progress(
    target: TilePos,
    ego_progress: f32,
    by_tile: &std::collections::HashMap<TilePos, Vec<(Entity, f32, f32)>>,
    reserved: &std::collections::HashMap<TilePos, Vec<f32>>,
    min_gap_progress: f32,
) -> bool {
    if let Some(list) = by_tile.get(&target) {
        for (_, p, _) in list.iter().copied() {
            if (p - ego_progress).abs() < min_gap_progress {
                return false;
            }
        }
    }
    if let Some(list) = reserved.get(&target) {
        for p in list.iter().copied() {
            if (p - ego_progress).abs() < min_gap_progress {
                return false;
            }
        }
    }
    true
}

fn find_leader_ahead(
    ego: (TilePos, f32),
    route: &[TilePos],
    by_tile: &std::collections::HashMap<TilePos, Vec<(Entity, f32, f32)>>,
) -> Option<(f32, f32)> {
    let (tile, progress) = ego;
    let list = by_tile.get(&tile)?;
    // On the same tile: nearest vehicle with higher progress.
    let mut best: Option<(f32, f32)> = None; // (gap_tiles, lead_speed)
    for (_, p, v) in list.iter().copied() {
        if p > progress {
            let g = p - progress;
            if best.is_none() || g < best.unwrap().0 {
                best = Some((g, v));
            }
        }
    }
    // On the next tile: earliest vehicle.
    if route.len() > 1 {
        let next_tile = route[1];
        if let Some(next_list) = by_tile.get(&next_tile)
            && let Some((_, min_p, lead_v)) = next_list.first().copied()
        {
            let g = (1.0 - progress) + min_p;
            if best.is_none() || g < best.unwrap().0 {
                best = Some((g, lead_v));
            }
        }
    }
    best
}

fn find_leader_ahead_entity(
    ego_e: Entity,
    ego: (TilePos, f32),
    route: &[TilePos],
    by_tile: &std::collections::HashMap<TilePos, Vec<(Entity, f32, f32)>>,
) -> Option<(Entity, f32, f32)> {
    let (tile, progress) = ego;
    let list = by_tile.get(&tile)?;

    let mut best: Option<(Entity, f32, f32)> = None; // (entity, gap_tiles, lead_speed)
    for (e, p, v) in list.iter().copied() {
        if e == ego_e {
            continue;
        }
        if p > progress {
            let g = p - progress;
            if best.is_none() || g < best.unwrap().1 {
                best = Some((e, g, v));
            }
        }
    }

    // On the next tile: earliest vehicle (closest to entry).
    if route.len() > 1 {
        let next_tile = route[1];
        if let Some(next_list) = by_tile.get(&next_tile)
            && let Some((e, min_p, lead_v)) = next_list.first().copied()
            && e != ego_e
        {
            let g = (1.0 - progress) + min_p;
            if best.is_none() || g < best.unwrap().1 {
                best = Some((e, g, lead_v));
            }
        }
    }

    best
}

#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn plan_lane_changes(
    time: Res<Time<Fixed>>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    graph: Res<RoadGraph>,
    regions: Res<RegionGraph>,
    traffic: Res<TrafficOccupancy>,
    path_cfg: Res<PathfindingConfig>,
    mut path_cache: ResMut<PathCache>,
    intersections: Res<IntersectionIndex>,
    traffic_cfg: Res<TrafficConfig>,
    mut commands: Commands,
    mut vehicles: ParamSet<(
        Query<
            (
                Entity,
                &Vehicle,
                &VehicleTrafficState,
                Option<&LaneChangeCooldown>,
                Option<&Overtaking>,
                Option<&OvertakeOncoming>,
                Option<&ServiceVehicle>,
                Option<&BusVehicle>,
            ),
            Without<Parked>,
        >,
        Query<(Entity, &mut Vehicle), Without<Parked>>,
    )>,
) {
    // Build a per-tile ordering for leader detection and lane safety checks.
    let mut by_tile: std::collections::HashMap<TilePos, Vec<(Entity, f32, f32)>> =
        std::collections::HashMap::new();
    for (e, v, ..) in vehicles.p0().iter() {
        if let Some(&tile) = v.route.first() {
            by_tile.entry(tile).or_default().push((
                e,
                v.progress.clamp(0.0, 1.0),
                v.speed.max(0.0),
            ));
        }
    }
    for list in by_tile.values_mut() {
        list.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    }

    let idm = idm_params_world(&cfg, &traffic_cfg);
    let min_gap_progress = (idm.s0 / cfg.tile_size.max(0.1)).clamp(0.12, 0.45);

    // A small "reservation" map to avoid multiple vehicles committing into the same
    // target lane position range in a single tick.
    let mut reserved: std::collections::HashMap<TilePos, Vec<f32>> =
        std::collections::HashMap::new();

    // Collect desires first (so we can prioritize), then apply with a guardrail limit.
    #[derive(Debug)]
    struct Desire {
        e: Entity,
        target: TilePos,
        priority: u8,
        ego_tile: TilePos,
        ego_progress: f32,
        goal: TilePos,
    }
    let mut desires = Vec::<Desire>::new();

    for (e, v, state, cooldown, overtaking, oncoming, service_vehicle, bus_vehicle) in
        vehicles.p0().iter()
    {
        if cooldown.is_some() {
            continue;
        }
        if oncoming.is_some() {
            continue;
        }
        if service_vehicle.is_some() || bus_vehicle.is_some() {
            continue;
        }
        if v.route.len() < 2 {
            continue;
        }

        // Don't lane change inside/near intersections.
        let ego_tile = v.route[0];
        if route_has_near_intersection(&v.route, &grid) {
            continue;
        }
        let Some(ego_cell) = grid.get(ego_tile) else {
            continue;
        };
        if ego_cell.water || !ego_cell.road.is_some() || ego_cell.road.dir == RoadDir::None {
            continue;
        }

        // Do not change lanes while stopped/waiting/approaching a stop line.
        if matches!(
            *state,
            VehicleTrafficState::Approaching { .. }
                | VehicleTrafficState::Stopped { .. }
                | VehicleTrafficState::WaitingForGreen { .. }
                | VehicleTrafficState::CrossingIntersection { .. }
        ) {
            continue;
        }

        let dir = ego_cell.road.dir;
        let goal = *v.route.last().unwrap_or(&ego_tile);
        if goal == ego_tile {
            continue;
        }

        let v0 = road_speed_limit_world(&cfg, &traffic_cfg, ego_tile, &grid).min(v.max_speed);
        if v0 <= 0.0 {
            continue;
        }

        // Candidate adjacent lanes.
        let left_target = lane_change_target(&grid, ego_tile, dir.left());
        let right_target = lane_change_target(&grid, ego_tile, dir.right());

        // Leader heuristics (for overtake decision).
        let leader = find_leader_ahead((ego_tile, v.progress), &v.route, &by_tile);

        let mut want_left = false;
        let mut want_right = false;

        // Overtake: move left if a slow leader is close.
        if let (Some(_lt), Some((gap_tiles, lead_speed))) = (left_target, leader)
            && gap_tiles <= OVERTAKE_LOOKAHEAD_TILES
            && lead_speed < v0 * OVERTAKE_LEADER_SPEED_RATIO
            && v.speed < v0 * 0.95
        {
            want_left = true;
        }

        // Return right after overtaking, or keep-right when cruising.
        if right_target.is_some() {
            if let Some(ov) = overtaking {
                // If we're overtaking but not currently blocked, start returning right in the second half.
                if ov.remaining_secs <= (OVERTAKE_HOLD_SECS * 0.5)
                    && leader.is_none_or(|(_, lead_v)| lead_v >= v0 * 0.95)
                {
                    want_right = true;
                }
            } else {
                // Keep-right when not actively overtaking and not slowed.
                if leader.is_none_or(|(_, lead_v)| lead_v >= v0 * 0.95) {
                    want_right = true;
                }
            }
        }

        // Build a desire (priority: overtake-left > return-right > keep-right).
        if want_left {
            if let Some(target) = left_target {
                desires.push(Desire {
                    e,
                    target,
                    priority: 2,
                    ego_tile,
                    ego_progress: v.progress,
                    goal,
                });
            }
        } else if want_right && let Some(target) = right_target {
            desires.push(Desire {
                e,
                target,
                priority: if overtaking.is_some() { 1 } else { 0 },
                ego_tile,
                ego_progress: v.progress,
                goal,
            });
        }
    }

    // Highest priority first (stable tie-breaker by entity id).
    desires.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| a.e.to_bits().cmp(&b.e.to_bits()))
    });

    let mut done = 0usize;
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

    for d in desires {
        if done >= MAX_LANE_CHANGES_PER_TICK {
            break;
        }

        // Capacity check (coarse).
        if let Some(ti) = grid.idx(d.target)
            && let Some(cell) = grid.get(d.target)
            && cell.road.is_some()
            && ti < traffic.per_tick_vehicles.len()
        {
            let cap = cell.road.kind.capacity_per_lane_tile();
            if traffic.per_tick_vehicles[ti] >= cap {
                continue;
            }
        } else {
            continue;
        }

        // Safe gap check (fine-ish, based on progress ranges).
        if !lane_change_safe_progress(
            d.target,
            d.ego_progress,
            &by_tile,
            &reserved,
            min_gap_progress,
        ) {
            continue;
        }

        // Re-route from the target lane to the goal, then prepend current tile as the lane-change step.
        let current = d.ego_tile;
        let goal = d.goal;
        let route_from_target = find_road_path_cached(&mut ctx, d.target, goal);
        if route_from_target.is_empty() {
            continue;
        }
        if route_from_target.get(1).copied() == Some(current) {
            // Avoid immediate ping-pong.
            continue;
        }

        if let Ok((_e, mut v)) = vehicles.p1().get_mut(d.e) {
            // Keep current tile; insert lane-change as the first step.
            let mut new_route = Vec::with_capacity(route_from_target.len() + 1);
            new_route.push(current);
            new_route.extend(route_from_target);
            v.route = new_route;
        } else {
            continue;
        }

        // Reserve this position on the target tile to avoid same-tick overlaps.
        reserved.entry(d.target).or_default().push(d.ego_progress);

        // Apply cooldown + overtake marker if we moved left.
        commands.entity(d.e).insert(LaneChangeCooldown {
            remaining_secs: LANE_CHANGE_COOLDOWN_SECS,
        });
        if d.priority >= 2 {
            commands.entity(d.e).insert(Overtaking {
                remaining_secs: OVERTAKE_HOLD_SECS,
            });
        }

        done += 1;
    }
}

#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn plan_oncoming_overtakes(
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    traffic_cfg: Res<TrafficConfig>,
    mut commands: Commands,
    mut vehicles: ParamSet<(
        Query<
            (
                Entity,
                &Vehicle,
                &VehicleTrafficState,
                Option<&LaneChangeCooldown>,
                Option<&Overtaking>,
                Option<&OvertakeOncoming>,
                Option<&ServiceVehicle>,
                Option<&BusVehicle>,
            ),
            Without<Parked>,
        >,
        Query<(Entity, &mut Vehicle), Without<Parked>>,
    )>,
) {
    // Build a per-tile ordering for leader + oncoming-lane occupancy checks.
    let mut by_tile: std::collections::HashMap<TilePos, Vec<(Entity, f32, f32)>> =
        std::collections::HashMap::new();
    for (e, v, ..) in vehicles.p0().iter() {
        if let Some(&tile) = v.route.first() {
            by_tile.entry(tile).or_default().push((
                e,
                v.progress.clamp(0.0, 1.0),
                v.speed.max(0.0),
            ));
        }
    }
    for list in by_tile.values_mut() {
        list.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    }

    #[derive(Copy, Clone)]
    struct Plan {
        e: Entity,
        offset: IVec2,
        pass_tiles: usize,
    }

    let mut plans = Vec::<Plan>::new();

    for (e, v, state, cooldown, overtaking, oncoming, service_vehicle, bus_vehicle) in
        vehicles.p0().iter()
    {
        if plans.len() >= MAX_ONCOMING_OVERTAKES_PER_TICK {
            break;
        }
        if cooldown.is_some() || overtaking.is_some() || oncoming.is_some() {
            continue;
        }
        if service_vehicle.is_some() || bus_vehicle.is_some() {
            continue;
        }
        if v.route.len() < 2 {
            continue;
        }

        // Never start close to intersections (safety).
        if route_has_near_intersection_n(&v.route, &grid, ONCOMING_OVERTAKE_INTERSECTION_LOOKAHEAD)
        {
            continue;
        }

        // Do not start while stopped/waiting/approaching a stop line.
        if matches!(
            *state,
            VehicleTrafficState::Approaching { .. }
                | VehicleTrafficState::Stopped { .. }
                | VehicleTrafficState::WaitingForGreen { .. }
                | VehicleTrafficState::CrossingIntersection { .. }
        ) {
            continue;
        }

        let ego_tile = v.route[0];
        let Some(ego_cell) = grid.get(ego_tile) else {
            continue;
        };
        if ego_cell.water || !ego_cell.road.is_some() || ego_cell.road.dir == RoadDir::None {
            continue;
        }
        let ego_road = ego_cell.road;
        if ego_road.kind != RoadKind::TwoLane {
            continue;
        }
        let dir = ego_road.dir;

        let v0 = road_speed_limit_world(&cfg, &traffic_cfg, ego_tile, &grid).min(v.max_speed);
        if v0 <= 0.0 {
            continue;
        }

        // Only attempt if we have a close, slow leader and we're not already near our desired speed.
        let Some((_lead_e, gap_tiles, lead_speed)) =
            find_leader_ahead_entity(e, (ego_tile, v.progress), &v.route, &by_tile)
        else {
            continue;
        };
        if gap_tiles > OVERTAKE_LOOKAHEAD_TILES {
            continue;
        }
        if lead_speed >= v0 * OVERTAKE_LEADER_SPEED_RATIO {
            continue;
        }
        if v.speed >= v0 * 0.95 {
            continue;
        }

        // Determine the oncoming lane offset (perpendicular) at the current position.
        let Some(offset) = oncoming_lane_offset(&grid, ego_tile, dir) else {
            continue;
        };

        // Pick a short, conservative pass length based on the current gap.
        let pass_tiles = ((gap_tiles + 1.5).ceil() as usize).clamp(
            ONCOMING_OVERTAKE_MIN_PASS_TILES,
            ONCOMING_OVERTAKE_MAX_PASS_TILES,
        );
        if v.route.len() <= pass_tiles + 1 {
            continue;
        }

        // Validate straight TwoLane segment and matching oncoming tiles for the planned range.
        let mut ok = true;
        for i in 0..=pass_tiles {
            let base = v.route[i];
            let Some(c) = grid.get(base) else {
                ok = false;
                break;
            };
            if c.water || !c.road.is_some() || c.road.dir != dir || c.road.kind != RoadKind::TwoLane
            {
                ok = false;
                break;
            }

            let on = TilePos {
                x: base.x + offset.x,
                y: base.y + offset.y,
            };
            let Some(oc) = grid.get(on) else {
                ok = false;
                break;
            };
            if oc.water
                || !oc.road.is_some()
                || oc.road.dir != dir.opposite()
                || oc.road.kind != RoadKind::TwoLane
            {
                ok = false;
                break;
            }
        }
        if !ok {
            continue;
        }

        // Conservative safety: require the oncoming lane to be completely clear for a large distance.
        let fwd = dir.delta();
        for j in 0..ONCOMING_OVERTAKE_CLEAR_TILES {
            let t = TilePos {
                x: ego_tile.x + offset.x + fwd.x * j as i32,
                y: ego_tile.y + offset.y + fwd.y * j as i32,
            };
            let Some(c) = grid.get(t) else {
                ok = false;
                break;
            };
            if c.water || !c.road.is_some() || c.road.dir == RoadDir::None {
                ok = false;
                break;
            }
            if let Some(list) = by_tile.get(&t)
                && !list.is_empty()
            {
                ok = false;
                break;
            }
        }
        if !ok {
            continue;
        }

        plans.push(Plan {
            e,
            offset,
            pass_tiles,
        });
    }

    // Apply route rewrites in a second pass to satisfy the borrow checker.
    let mut q_mut = vehicles.p1();
    for p in plans {
        let Ok((_ent, mut vv)) = q_mut.get_mut(p.e) else {
            continue;
        };

        // Pull out to oncoming lane, move forward for `pass_tiles`, return.
        let current = vv.route[0];
        let mut new_route = Vec::with_capacity(vv.route.len() + p.pass_tiles + 2);
        new_route.push(current);

        // Pull out to oncoming lane at current position.
        new_route.push(TilePos {
            x: current.x + p.offset.x,
            y: current.y + p.offset.y,
        });

        // Advance oncoming lane in parallel to the current route.
        for i in 1..=p.pass_tiles {
            let base = vv.route[i];
            new_route.push(TilePos {
                x: base.x + p.offset.x,
                y: base.y + p.offset.y,
            });
        }

        // Return to our lane at the same longitudinal position.
        new_route.push(vv.route[p.pass_tiles]);

        // Continue with the original route after the return tile.
        new_route.extend(vv.route.iter().copied().skip(p.pass_tiles + 1));
        vv.route = new_route;

        commands.entity(p.e).insert(LaneChangeCooldown {
            remaining_secs: ONCOMING_OVERTAKE_COOLDOWN_SECS,
        });
        commands.entity(p.e).insert(OvertakeOncoming {
            remaining_secs: ONCOMING_OVERTAKE_COOLDOWN_SECS,
        });
    }
}

fn dir_between_adjacent(from: TilePos, to: TilePos) -> RoadDir {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    match (dx, dy) {
        (1, 0) => RoadDir::East,
        (-1, 0) => RoadDir::West,
        (0, 1) => RoadDir::North,
        (0, -1) => RoadDir::South,
        _ => RoadDir::None,
    }
}

fn is_intersection_tile(grid: &MapGrid, pos: TilePos) -> bool {
    if let Some(c) = grid.get(pos)
        && c.road.is_some()
    {
        c.road.dir == RoadDir::None
    } else {
        false
    }
}

fn plan_intersection_reservations(
    time: Res<Time<Fixed>>,
    grid: Res<MapGrid>,
    intersections: Res<IntersectionIndex>,
    mut reservations: ResMut<IntersectionReservations>,
    q_lights: Query<&crate::game::intersections::TrafficLight>,
    q_vehicles: Query<(Entity, &Vehicle, &VehicleTrafficState), Without<Parked>>,
) {
    let now = time.elapsed_secs_f64();

    // Build a small lookup of controllers by intersection id.
    let mut lights_by_id =
        std::collections::HashMap::<IntersectionId, crate::game::intersections::TrafficLight>::new(
        );
    for l in q_lights.iter() {
        lights_by_id.insert(l.intersection_id, l.clone());
    }

    // Ensure any vehicle currently inside an intersection cluster owns a reservation (safety net).
    for (e, v, _) in q_vehicles.iter() {
        let Some(&cur) = v.route.first() else {
            continue;
        };
        if !is_intersection_tile(&grid, cur) {
            continue;
        }
        let Some(id) = intersections.intersection_id_at(cur) else {
            continue;
        };
        reservations
            .by_intersection
            .entry(id)
            .or_insert(IntersectionReservation {
                vehicle: e,
                state: ReservationState::Inside,
                created_at_sec: now,
            });
    }

    // Pick one approaching vehicle per free intersection.
    #[derive(Copy, Clone)]
    struct Best {
        dist_to_entry: f32,
        vehicle: Entity,
    }
    let mut best_by_intersection = std::collections::HashMap::<IntersectionId, Best>::new();

    for (e, v, state) in q_vehicles.iter() {
        if v.route.len() < 2 {
            continue;
        }
        // Don't reserve for vehicles that are explicitly stopped/waiting at red.
        if matches!(
            *state,
            VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. }
        ) {
            continue;
        }

        let cur = v.route[0];
        if is_intersection_tile(&grid, cur) {
            continue;
        }
        let next = v.route[1];
        if !is_intersection_tile(&grid, next) {
            continue;
        }

        let Some(id) = intersections.intersection_id_at(next) else {
            continue;
        };
        if reservations.by_intersection.contains_key(&id) {
            continue;
        }

        // If there is a traffic light controller, only admit on green.
        if intersections.traffic_lights.contains(&id) {
            let Some(light) = lights_by_id.get(&id) else {
                continue;
            };
            let dir = dir_between_adjacent(cur, next);
            if dir == RoadDir::None {
                continue;
            }
            if !light.is_green(dir) {
                continue;
            }
        }

        let dist = (1.0 - v.progress).clamp(0.0, 1.0);
        let cand = Best {
            dist_to_entry: dist,
            vehicle: e,
        };

        best_by_intersection
            .entry(id)
            .and_modify(|b| {
                if cand.dist_to_entry < b.dist_to_entry
                    || (cand.dist_to_entry == b.dist_to_entry
                        && cand.vehicle.to_bits() < b.vehicle.to_bits())
                {
                    *b = cand;
                }
            })
            .or_insert(cand);
    }

    for (id, best) in best_by_intersection {
        reservations.by_intersection.insert(
            id,
            IntersectionReservation {
                vehicle: best.vehicle,
                state: ReservationState::Approaching,
                created_at_sec: now,
            },
        );
    }
}

fn cleanup_intersection_reservations(
    time: Res<Time<Fixed>>,
    intersections: Res<IntersectionIndex>,
    mut reservations: ResMut<IntersectionReservations>,
    q_vehicles: Query<&Vehicle>,
) {
    let now = time.elapsed_secs_f64();
    let timeout_secs = 6.0;

    let mut to_remove = Vec::<IntersectionId>::new();
    for (id, r) in reservations.by_intersection.iter_mut() {
        let Ok(v) = q_vehicles.get(r.vehicle) else {
            to_remove.push(*id);
            continue;
        };
        if v.route.is_empty() {
            to_remove.push(*id);
            continue;
        }

        let cur = v.route[0];
        let cur_id = intersections.intersection_id_at(cur);
        if cur_id == Some(*id) {
            r.state = ReservationState::Inside;
        }

        match r.state {
            ReservationState::Approaching => {
                // Vehicle rerouted away: drop.
                let next_id = v
                    .route
                    .get(1)
                    .and_then(|t| intersections.intersection_id_at(*t));
                if next_id != Some(*id) {
                    to_remove.push(*id);
                    continue;
                }
                // If it doesn't enter within a small time budget, release to avoid deadlocks.
                if now - r.created_at_sec > timeout_secs {
                    to_remove.push(*id);
                }
            }
            ReservationState::Inside => {
                // Release once the vehicle exits the intersection cluster.
                if cur_id != Some(*id) {
                    to_remove.push(*id);
                }
            }
        }
    }

    for id in to_remove {
        reservations.by_intersection.remove(&id);
    }
}

/// Move vehicles along their routes.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn move_vehicles(
    time: Res<Time<Fixed>>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    traffic: Res<TrafficOccupancy>,
    traffic_cfg: Res<TrafficConfig>,
    intersections: Res<IntersectionIndex>,
    reservations: Res<IntersectionReservations>,
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
            // IDM keeps a standstill gap of `s0` to a leader. For a virtual stop-line leader we want
            // the vehicle to come to rest *at* the stop line, not `s0` behind it. Achieve that by
            // shifting the virtual leader forward by `s0`.
            let gap_world = distance_to_stop.max(0.0) * cfg.tile_size.max(0.1) + idm.s0;
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
            let mut blocked_next_is_intersection = false;
            if v.route.len() > 1 {
                let next_tile = v.route[1];
                let current_is_intersection = is_intersection_tile(&grid, current_tile);
                let next_is_intersection = is_intersection_tile(&grid, next_tile);

                // Intersection admission (Stage D): require a reservation to enter an intersection tile.
                if next_is_intersection && !current_is_intersection {
                    blocked_next_is_intersection = true;
                    let ok = if let Some(id) = intersections.intersection_id_at(next_tile)
                        && let Some(r) = reservations.by_intersection.get(&id)
                    {
                        r.vehicle == entity
                    } else {
                        false
                    };
                    if !ok {
                        blocked_next = true;
                    }
                }

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
                if !blocked_next && next_is_intersection {
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
                let gap_tiles = if blocked_next_is_intersection {
                    // Stop line is slightly before the intersection boundary.
                    (1.0 - v.progress - STOP_LINE_OFFSET).max(0.0)
                } else {
                    (1.0 - v.progress).max(0.0)
                };
                // Same logic as stop-line leader above: for an intersection admission block, shift
                // the virtual leader forward by `s0` so the vehicle can reach the stop line.
                let mut gap_world = gap_tiles * cfg.tile_size.max(0.1);
                if blocked_next_is_intersection {
                    gap_world += idm.s0;
                }
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
                let max_p = if blocked_next_is_intersection {
                    // For intersections, clamp to the stop line exactly (not "just before"),
                    // otherwise stop-sign / light logic can get stuck in Approaching with a tiny
                    // positive `distance_to_stop` and never transition to Stopped/Crossing.
                    (1.0 - STOP_LINE_OFFSET).max(0.0)
                } else {
                    1.0 - stop_before
                };
                let next_p = (v.progress + dprog).min(max_p);
                v.progress = next_p;
                if v.progress >= max_p - 1e-6 {
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
    q_priorities: Query<&crate::game::intersections::IntersectionPriorityMarker>,
    mut q_vehicles: Query<(&Vehicle, &mut VehicleTrafficState)>,
) {
    // We only need to distinguish StopSign-driven stops from light-driven stops.
    // If a light gets removed while vehicles are stopped at it, we must release them.
    let mut stop_sign_tiles = std::collections::HashSet::<TilePos>::new();
    for m in q_priorities.iter() {
        if m.priority == IntersectionPriority::StopSign {
            stop_sign_tiles.insert(m.pos);
        }
    }

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
            // We clear *light-driven* states here, but keep stop-sign stops.
            //
            // Important: if a traffic light is removed while a vehicle is in Stopped/WaitingForGreen,
            // `has_traffic_light_at(stop_tile)` becomes false. Without this guard, vehicles would
            // remain stuck indefinitely.
            match *state {
                VehicleTrafficState::WaitingForGreen { .. } => {
                    // Stop signs never use WaitingForGreen.
                    *state = VehicleTrafficState::FreeFlow;
                }
                VehicleTrafficState::Stopped { stop_tile, .. }
                | VehicleTrafficState::Approaching { stop_tile, .. } => {
                    if !stop_sign_tiles.contains(&stop_tile) {
                        *state = VehicleTrafficState::FreeFlow;
                    }
                }
                _ => {}
            };
            continue;
        };

        // If we're already on the light tile (intersection), don't try to "stop" here – just clear it.
        // This prevents slow creeping/stopping inside the intersection.
        if current_tile == Some(stop_tile) {
            *state = VehicleTrafficState::CrossingIntersection {
                intersection: intersection_key,
            };
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
            if stop_distance <= STOP_LINE_EPS_TILES {
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
                *state = VehicleTrafficState::CrossingIntersection {
                    intersection: intersection_key,
                };
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
        let Some(current_tile) = vehicle.route.first().copied() else {
            continue;
        };

        let next_tile = vehicle.route.get(1).copied();

        // Clear transient state once we're no longer in (or immediately before) the *same* intersection.
        //
        // Important: stop signs release vehicles on the approach tile (still not `dir=None`), so we
        // must not clear CrossingIntersection until the vehicle actually enters the cluster.
        if let VehicleTrafficState::CrossingIntersection { intersection } = *state {
            let still_related = if is_intersection_tile(&grid, current_tile) {
                intersections.cluster_key_at(current_tile) == Some(intersection)
            } else if let Some(nt) = next_tile
                && is_intersection_tile(&grid, nt)
            {
                intersections.cluster_key_at(nt) == Some(intersection)
            } else {
                false
            };

            if !still_related {
                *state = VehicleTrafficState::FreeFlow;
            }
        }

        // Check the NEXT tile (route[1]) so rules apply *before* entering the intersection.
        let Some(next_tile) = next_tile else {
            continue;
        };

        // Skip if has traffic light (lights handle priority).
        let has_traffic_light = intersections.has_traffic_light_at(next_tile);
        if has_traffic_light {
            continue;
        }

        // Only apply stop/yield rules on the approach tile (not once we're already inside).
        if is_intersection_tile(&grid, current_tile) {
            continue;
        }

        // Check if this is an intersection (dir == None)
        if is_intersection_tile(&grid, next_tile) {
            // This is an intersection - check for priority rules
            // Try to find IntersectionPriority marker at this position
            let mut found_priority = None;
            for marker in q_intersections.iter() {
                // Match by position
                if marker.pos == next_tile {
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
                    let Some(intersection_key) = intersections.cluster_key_at(next_tile) else {
                        continue;
                    };
                    // If we've already been released for this intersection, don't re-apply stop sign
                    // logic while still on the approach tile. Otherwise we'd oscillate between
                    // Stopped <-> CrossingIntersection and move at half speed.
                    if matches!(
                        *state,
                        VehicleTrafficState::CrossingIntersection { intersection }
                            if intersection == intersection_key
                    ) {
                        continue;
                    }

                    // Stop sign - must come to complete stop BEFORE intersection.
                    // Distance to stop line is remaining distance to end of current tile minus STOP_LINE_OFFSET.
                    let dist_to_intersection = 1.0 - vehicle.progress;
                    let dist_to_stop = (dist_to_intersection - STOP_LINE_OFFSET).max(0.0);
                    if dist_to_stop <= STOP_LINE_EPS_TILES {
                        // First tick at the stop line: lock to a full stop (no creeping).
                        // Next tick, we'll release to Cross/FreeFlow so the vehicle can enter (subject to admission).
                        if matches!(
                            *state,
                            VehicleTrafficState::Stopped { stop_tile, .. }
                                if stop_tile == next_tile
                        ) {
                            *state = VehicleTrafficState::CrossingIntersection {
                                intersection: intersection_key,
                            };
                        } else {
                            *state = VehicleTrafficState::Stopped {
                                intersection: intersection_key,
                                stop_tile: next_tile,
                                queue_position: 0,
                            };
                        }
                    } else {
                        // Update distance every tick so IDM braking sees a decreasing gap.
                        *state = VehicleTrafficState::Approaching {
                            intersection: intersection_key,
                            stop_tile: next_tile,
                            distance_to_stop: dist_to_stop,
                        };
                    }
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
    use crate::game::intersections::IntersectionPriorityMarker;
    use crate::game::roads::{LaneType, RoadCell, RoadFlow, RoadKind};
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
            .insert_resource(IntersectionIndex::default())
            .insert_resource(IntersectionReservations::default())
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

    #[test]
    fn stop_sign_release_does_not_oscillate_crossing_state() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .insert_resource(MapConfig {
                width: 3,
                height: 1,
                tile_size: 16.0,
            })
            .insert_resource({
                let mut grid = MapGrid::new(3, 1);

                let approach = TilePos { x: 0, y: 0 };
                let intersection_tile = TilePos { x: 1, y: 0 };
                let exit = TilePos { x: 2, y: 0 };

                for (pos, dir) in [
                    (approach, RoadDir::East),
                    (intersection_tile, RoadDir::None),
                    (exit, RoadDir::East),
                ] {
                    let Some(mut cell) = grid.get(pos) else {
                        continue;
                    };
                    cell.road = RoadCell {
                        kind: RoadKind::TwoLane,
                        dir,
                        lane: 0,
                        flow: RoadFlow::TwoWay,
                        lane_type: LaneType::Regular,
                    };
                    grid.set(pos, cell);
                }

                grid
            })
            .insert_resource({
                let intersection_tile = TilePos { x: 1, y: 0 };
                let id = IntersectionId(0);
                let key = IntersectionKey {
                    aabb_min: intersection_tile,
                    aabb_max: intersection_tile,
                    tile_count: 1,
                    tiles_hash: 1,
                };

                let mut idx = IntersectionIndex::default();
                idx.clusters
                    .push(crate::game::intersections::IntersectionCluster {
                        id,
                        key,
                        tiles: vec![intersection_tile],
                        aabb_min: intersection_tile,
                        aabb_max: intersection_tile,
                        centroid_tile: intersection_tile,
                    });
                idx.tile_to_intersection.insert(intersection_tile, id);
                idx
            })
            .add_systems(Update, check_intersection_priority);

        let approach = TilePos { x: 0, y: 0 };
        let intersection_tile = TilePos { x: 1, y: 0 };
        let exit = TilePos { x: 2, y: 0 };
        let key = app
            .world()
            .resource::<IntersectionIndex>()
            .cluster_key_at(intersection_tile)
            .unwrap();

        // Place a stop sign marker on the intersection tile.
        app.world_mut().spawn(IntersectionPriorityMarker {
            pos: intersection_tile,
            priority: IntersectionPriority::StopSign,
        });

        // Vehicle is sitting right at the stop line (dist_to_stop == 0) and has already stopped.
        let vehicle = app
            .world_mut()
            .spawn((
                Vehicle {
                    route: vec![approach, intersection_tile, exit],
                    progress: 1.0,
                    speed: 0.0,
                    max_speed: 60.0,
                    max_accel: 20.0,
                },
                VehicleTrafficState::Stopped {
                    intersection: key,
                    stop_tile: intersection_tile,
                    queue_position: 0,
                },
            ))
            .id();

        // Tick 1: released to CrossingIntersection.
        app.update();
        assert_eq!(
            app.world().get::<VehicleTrafficState>(vehicle).copied(),
            Some(VehicleTrafficState::CrossingIntersection { intersection: key })
        );

        // Tick 2: must stay in CrossingIntersection while still on the approach tile (no oscillation).
        app.update();
        assert_eq!(
            app.world().get::<VehicleTrafficState>(vehicle).copied(),
            Some(VehicleTrafficState::CrossingIntersection { intersection: key })
        );
    }

    #[test]
    fn oncoming_overtake_rewrites_route_on_two_lane() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .insert_resource(MapConfig {
                width: 20,
                height: 2,
                tile_size: 16.0,
            })
            .insert_resource({
                let mut grid = MapGrid::new(20, 2);
                for x in 0..20 {
                    // Our lane (eastbound)
                    let p0 = TilePos { x, y: 0 };
                    let Some(mut c0) = grid.get(p0) else {
                        continue;
                    };
                    c0.road = RoadCell {
                        kind: RoadKind::TwoLane,
                        dir: RoadDir::East,
                        lane: 0,
                        flow: RoadFlow::TwoWay,
                        lane_type: LaneType::Regular,
                    };
                    grid.set(p0, c0);

                    // Oncoming lane (westbound)
                    let p1 = TilePos { x, y: 1 };
                    let Some(mut c1) = grid.get(p1) else {
                        continue;
                    };
                    c1.road = RoadCell {
                        kind: RoadKind::TwoLane,
                        dir: RoadDir::West,
                        lane: 1,
                        flow: RoadFlow::TwoWay,
                        lane_type: LaneType::Regular,
                    };
                    grid.set(p1, c1);
                }
                grid
            })
            .insert_resource(TrafficConfig::default())
            .add_systems(Update, plan_oncoming_overtakes);

        // Leader occupies the next tile, moving slowly.
        app.world_mut().spawn((
            Vehicle {
                route: (1..20).map(|x| TilePos { x, y: 0 }).collect(),
                progress: 0.0,
                speed: 2.0,
                max_speed: 60.0,
                max_accel: 20.0,
            },
            VehicleTrafficState::FreeFlow,
        ));

        // Ego vehicle behind, wants to pass.
        let ego = app
            .world_mut()
            .spawn((
                Vehicle {
                    route: (0..20).map(|x| TilePos { x, y: 0 }).collect(),
                    progress: 0.0,
                    speed: 5.0,
                    max_speed: 60.0,
                    max_accel: 20.0,
                },
                VehicleTrafficState::FreeFlow,
            ))
            .id();

        app.update();

        let v = app.world().get::<Vehicle>(ego).unwrap();
        assert_eq!(v.route[0], TilePos { x: 0, y: 0 });
        assert_eq!(v.route[1], TilePos { x: 0, y: 1 }); // pull out
        assert_eq!(v.route[2], TilePos { x: 1, y: 1 }); // oncoming forward
        assert_eq!(v.route[5], TilePos { x: 3, y: 0 }); // return to our lane (pass_tiles=3)

        assert!(app.world().get::<LaneChangeCooldown>(ego).is_some());
        assert!(app.world().get::<OvertakeOncoming>(ego).is_some());
    }
}
