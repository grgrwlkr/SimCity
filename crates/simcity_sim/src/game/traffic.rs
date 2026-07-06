//! M3: Traffic simulation – vehicles moving along roads via A* pathfinding.

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;

use crate::game::commands::GameCommand;
use crate::game::ids::CitizenId;
use crate::game::intersections::IntersectionIndex;
use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::services::{ServiceVehicle, ServiceVehicleState};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::telemetry::{VehicleAgg, VehicleAggSnapshot};
use crate::game::transport::{
    PathCache, PathfindingConfig, PathfindingCtx, RegionGraph, RoadGraph, adjacent_road_towards,
    find_road_path_cached,
};
use crate::game::trips::{TripFinished, TripMode, TripRequested};

mod components;
pub(crate) use components::clear_lanelet_plan_on_reroute;
pub use components::{
    CarOwner, DebugIntersectionConnectorState, DebugManeuverKind, DebugRoadDir, DebugVehicleState,
    DebugVehicleTrafficState, Parked, RightTurnOnRed, Vehicle, VehicleLaneletPlan,
    VehicleMotionTimer, VehicleTrafficState,
};

mod config;
pub use config::TrafficConfig;

mod occupancy;
pub use occupancy::{TrafficIndex, TrafficOccupancy};
use occupancy::{
    TrafficRoadCache, reset_traffic_aggregates, update_traffic_index, update_traffic_occupancy,
};

mod overlay;
use overlay::{TrafficOverlayPool, TrafficOverlayTile, render_traffic_overlay};

mod movement;
pub(crate) use movement::update_vehicle_traffic_state;
use movement::{cleanup_right_on_red_markers, move_vehicles};

mod parking;
use parking::update_parked_vehicle_positions;

mod indices;
use indices::{
    CarOwnerIndex, init_vehicle_motion_timers, track_car_owner_index, track_vehicle_counts,
    track_vehicle_motion,
};
pub use indices::{TrafficVehicleCounts, VehicleMotionStats};

mod spawn;
use spawn::{clear_vehicles, spawn_trip_vehicles};

mod stuck;
use stuck::{
    init_stuck_timers, recover_stuck_returning_service_vehicles, resolve_stuck_vehicles,
    update_stuck_timers,
};

mod reroute_planner;
pub(crate) use reroute_planner::{
    LaneletReplanRes, invalidate_routes_on_graph_change, replan_route_with_lanelets,
    route_direction_ok,
};

mod swap_break;
use swap_break::break_tile_swaps;

mod lane_change;
use lane_change::{
    build_traffic_spatial_index, build_traffic_spatial_index_pre_lane_changes, plan_lane_changes,
    tick_lane_change_cooldowns, tick_overtaking,
};

mod vehicle_render;

mod debug;
pub use debug::{AUDIT_OFFENDER_SAMPLE_LEN, RouteProducerStats, TrafficViolationAudit};
use debug::{audit_traffic_violations, update_debug_vehicle_state};

mod traffic_spatial_index;
pub use traffic_spatial_index::TrafficSpatialIndex;

mod parked_tile_index;
pub use parked_tile_index::ParkedVehicleTileIndex;

// NOTE: v2 Stage B uses IDM params stored in `TrafficConfig` instead of a separate braking resource.

/// Distance to detect traffic lights ahead (in tiles).
const TRAFFIC_LIGHT_DETECTION_DISTANCE: f32 = 8.0;

/// Vehicle sprite size in tile units (length).
///
/// GDD requirement: vehicles are visually 2 tiles long, but must fit within a lane.
/// IMPORTANT: Our movement uses the vehicle center point, and rendering uses `Transform` at that
/// center. To ensure the *entire* vehicle stays behind the stop line (not visually overlapping the
/// intersection), stop-line math must account for half of this size.
///
/// Vehicles are rendered as rectangles: length (along direction of travel) is 2x width.
/// Width fits within lane (roughly 0.5 tiles for two-lane road), so width = 0.7 tiles, length = 1.4 tiles.
pub(crate) const VEHICLE_VISUAL_LENGTH_TILES: f32 = 1.4; // Length along direction of travel (GDD: 2 tiles visually, scaled down)
pub(crate) const VEHICLE_VISUAL_WIDTH_TILES: f32 = 0.7; // Width perpendicular to direction (fits in lane with margin)
const VEHICLE_HALF_LENGTH_TILES: f32 = VEHICLE_VISUAL_LENGTH_TILES * 0.5;

/// Extra margin before the intersection boundary for the vehicle bumper (tile units).
const STOP_LINE_MARGIN_TILES: f32 = 0.05;

/// In our kinematic model `progress` is the fraction between tile centers (0.0 = current center,
/// 1.0 = next center). Therefore the tile boundary is at `progress == 0.5`.
const TILE_CENTER_TO_EDGE_TILES: f32 = 0.5;

/// Stop line offset relative to the intersection boundary (in tile fractions).
///
/// Important invariant for gameplay correctness: the stop line is always located on the
/// **approach tile** (a normal road tile), i.e. vehicles must stop before they enter the
/// intersection cluster tiles (`dir=None`).
const STOP_LINE_OFFSET: f32 = VEHICLE_HALF_LENGTH_TILES + STOP_LINE_MARGIN_TILES;
/// Numerical epsilon for "at stop line" checks (in tile fractions).
const STOP_LINE_EPS_TILES: f32 = 1e-3;
/// Target speed cap while performing a right turn on red (doc: <= 15 km/h).
const RIGHT_ON_RED_TURN_MAX_KMH: f32 = 15.0;
/// Share of drivers that keep a standard speed profile (40%).
/// Lower than before (70%) so per-car speed variation is more visible in-game.
const DRIVER_PROFILE_MEDIUM_SHARE: f32 = 0.40;
/// Standard speed profile multiplier applied to per-road speed limits.
const DRIVER_PROFILE_MEDIUM_FACTOR: f32 = 1.0;
/// Minimum driver profile multiplier (cautious drivers).
const DRIVER_PROFILE_SLOW_MIN_FACTOR: f32 = 0.70;
/// Maximum driver profile multiplier (aggressive drivers).
const DRIVER_PROFILE_FAST_MAX_FACTOR: f32 = 1.35;
/// Safety clamp for externally loaded/invalid speed profiles.
const DRIVER_PROFILE_FACTOR_MIN: f32 = DRIVER_PROFILE_SLOW_MIN_FACTOR;
const DRIVER_PROFILE_FACTOR_MAX: f32 = DRIVER_PROFILE_FAST_MAX_FACTOR;
/// Per-driver max speed range (km/h). Variation ensures visible speed differences even on highways.
pub(crate) const DRIVER_MAX_SPEED_KMH_MIN: f32 = 90.0;
pub(crate) const DRIVER_MAX_SPEED_KMH_MAX: f32 = 130.0;
/// Service vehicles may exceed posted road limits by this factor.
const SERVICE_VEHICLE_SPEED_LIMIT_FACTOR: f32 = 1.50;

/// After this many seconds without progressing, try to resolve a traffic jam (reroute).
/// (v2 policy: avoid "cheat" behavior by default; only intervene after a long timeout.)
pub(crate) const STUCK_REROUTE_SECS: f32 = 60.0;
/// After this many seconds without progressing, despawn non-service trip vehicles as an emergency guardrail.
const STUCK_DESPAWN_SECS: f32 = 180.0;
/// Minimum spacing between reroute ATTEMPTS for a wedged vehicle (continuously stopped past
/// `STUCK_REROUTE_SECS`). Un-throttled, a wedged car replans every tick — the churn itself pins it.
pub(crate) const WEDGED_REROUTE_RETRY_SECS: f32 = 10.0;
/// A vehicle flagged `SwapDeadlocked` (in an off-intersection tile-swap with no straight escape) is
/// removed after this short grace — the swap breaker re-checks every tick and clears the flag the
/// moment the swap resolves, so a still-flagged car is genuinely wedged and must not pin the road.
const SWAP_DEADLOCK_DESPAWN_SECS: f32 = 3.0;
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
/// Speed profile threshold for lane preference: vehicles with speed_factor above this prefer left
/// lanes; those at or below keep right (DRIVER_PROFILE_MEDIUM_FACTOR = 1.0).
pub(crate) const KEEP_RIGHT_SPEED_THRESHOLD: f32 = 0.98;

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

pub(crate) fn kmh_to_world_speed(cfg: &MapConfig, traffic_cfg: &TrafficConfig, kmh: f32) -> f32 {
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

// (moved to `traffic/stuck.rs`)

// (moved to `traffic/lane_change.rs`)

mod intersection;
pub(crate) use intersection::maneuver_kind;
use intersection::{
    ApproachFairness, ArbiterIndexCache, LaneletStallTracker, RingTopologyStatus,
    arbitrate_lanelet_reservations, check_ring_free_topology, cleanup_intersection_reservations,
    nudge_lanelet_stall_reroute, reset_intersection_reservations,
};
pub use intersection::{ArbiterTickStats, IntersectionReservations};
pub use intersection::{ManeuverKind, ReservationState};

#[derive(Component, Debug, Copy, Clone)]
struct TripPassenger {
    citizen: CitizenId,
    purpose: crate::game::trips::TripPurpose,
}

pub struct TrafficPlugin;

impl Plugin for TrafficPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<TrafficOccupancy>()
            .init_resource::<TrafficIndex>()
            .init_resource::<TrafficConfig>()
            .init_resource::<TrafficOverlayPool>()
            .init_resource::<IntersectionReservations>()
            .init_resource::<ArbiterIndexCache>()
            .init_resource::<ArbiterTickStats>()
            .init_resource::<ApproachFairness>()
            .init_resource::<TrafficViolationAudit>()
            .init_resource::<RouteProducerStats>()
            .init_resource::<LaneletStallTracker>()
            .init_resource::<RingTopologyStatus>()
            .init_resource::<TrafficSpatialIndex>()
            .init_resource::<VehicleAggSnapshot>()
            .init_resource::<ParkedVehicleTileIndex>()
            .init_resource::<TrafficRoadCache>()
            .init_resource::<CarOwnerIndex>()
            .init_resource::<TrafficVehicleCounts>()
            .init_resource::<VehicleMotionStats>()
            .register_type::<DebugIntersectionConnectorState>()
            .register_type::<DebugManeuverKind>()
            .register_type::<DebugRoadDir>()
            .register_type::<DebugVehicleState>()
            .register_type::<DebugVehicleTrafficState>()
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
                    .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
            )
            // Flag-on advisory: warn (never block) when a cluster has no open-road exit (ring).
            .add_systems(
                Update,
                check_ring_free_topology
                    .in_set(GameSet::GraphUpdate)
                    .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
            )
            // R3: re-validate every active route after a structural map edit (GraphVersion bump) —
            // stale routes must not drive against flipped lanes / across deleted roads. Runs after
            // the transport graphs rebuilt this tick (on FixedUpdate the GraphUpdate set is chained
            // before Sim; the explicit .after below orders it within the set, behind the lanelet
            // rebuild). Replans are budgeted per tick and carry over — see the system's doc.
            .add_systems(
                FixedUpdate,
                invalidate_routes_on_graph_change
                    .in_set(GameSet::GraphUpdate)
                    .after(crate::game::transport::build_lanelet_graph)
                    .run_if(in_state(AppState::InGame)),
            )
            // Simulation - Part 1: occupancy, state updates, spawning
            .add_systems(
                FixedUpdate,
                (
                    // Update occupancy FIRST so pathfinding uses fresh data from previous tick
                    update_traffic_occupancy,
                    update_parked_vehicle_positions,
                    track_car_owner_index,
                    update_vehicle_traffic_state,
                    spawn_trip_vehicles,
                    tick_lane_change_cooldowns,
                    tick_overtaking,
                )
                    .chain()
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            )
            // Simulation - Part 2: lane changes, intersections, movement
            .add_systems(
                FixedUpdate,
                (
                    build_traffic_spatial_index_pre_lane_changes
                        .after(spawn_trip_vehicles)
                        .before(plan_lane_changes),
                    plan_lane_changes
                        .after(spawn_trip_vehicles)
                        .before(move_vehicles),
                    build_traffic_spatial_index
                        .after(plan_lane_changes)
                        .before(move_vehicles),
                    // Sole reservation producer.
                    arbitrate_lanelet_reservations
                        .after(build_traffic_spatial_index)
                        .before(break_tile_swaps)
                        .before(move_vehicles),
                    break_tile_swaps
                        .after(arbitrate_lanelet_reservations)
                        .before(move_vehicles),
                    move_vehicles.after(arbitrate_lanelet_reservations),
                    cleanup_right_on_red_markers.after(move_vehicles),
                    cleanup_intersection_reservations.after(move_vehicles),
                )
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            )
            // Keep derived counts in sync (including while paused) without any full-world queries.
            .add_systems(
                Update,
                track_vehicle_counts
                    .in_set(GameSet::CommandApply)
                    .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
            )
            // MCP debug snapshot for vehicles (reflected component).
            .add_systems(
                Update,
                update_debug_vehicle_state
                    .in_set(GameSet::Ui)
                    .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
            )
            // GPU interpolation systems for smooth 60fps rendering
            // Note: update_vehicle_positions_for_interpolation is disabled because move_vehicles
            // already properly updates vehicle positions for interpolation
            // .add_systems(
            //     FixedUpdate,
            //     vehicle_render::update_vehicle_positions_for_interpolation
            //         .in_set(GameSet::Sim)
            //         .run_if(in_state(AppState::InGame)),
            // )
            .add_systems(
                Update,
                vehicle_render::interpolate_vehicle_position.run_if(in_state(AppState::InGame)),
            )
            // Jam recovery (run in sim; uses last tick's occupancy/graph state).
            .add_systems(
                FixedUpdate,
                (
                    init_stuck_timers,
                    init_vehicle_motion_timers,
                    // Per-vehicle moving/stopped time tracking + gridlock detection (debug).
                    track_vehicle_motion.after(move_vehicles),
                    update_stuck_timers.after(move_vehicles),
                    // Mandatory-merge: force a reroute for vehicles whose lanelet never
                    // resolves, after update_stuck_timers (so the bump survives) and before reroute.
                    nudge_lanelet_stall_reroute
                        .after(update_stuck_timers)
                        .before(resolve_stuck_vehicles),
                    resolve_stuck_vehicles.after(update_stuck_timers),
                    recover_stuck_returning_service_vehicles.after(update_stuck_timers),
                )
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            )
            // Update traffic index at end of Sim for accurate UI metrics
            .add_systems(
                FixedUpdate,
                update_traffic_index
                    .in_set(GameSet::PostSim)
                    .run_if(in_state(AppState::InGame)),
            )
            // Wrong-way / route-provenance audit (observable via DebugTrafficSnapshot over BRP).
            // Read-only — also runs while Paused so a frozen frame can be inspected over MCP.
            .add_systems(
                FixedUpdate,
                audit_traffic_violations
                    .in_set(GameSet::PostSim)
                    .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
            )
            // Rendering
            .add_systems(Update, render_traffic_overlay.in_set(GameSet::RenderSync))
            // Keep parked visuals consistent when editing roads while paused.
            .add_systems(
                Update,
                update_parked_vehicle_positions
                    .in_set(GameSet::RenderSync)
                    .run_if(
                        in_state(AppState::Paused)
                            .and_then(resource_changed::<crate::game::map::MapEditVersion>),
                    ),
            );
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
    mut car_owner_index: ResMut<CarOwnerIndex>,
    mut counts: ResMut<TrafficVehicleCounts>,
) {
    for e in q_vehicles.iter() {
        commands.entity(e).despawn();
    }
    for e in q_overlay.iter() {
        commands.entity(e).despawn();
    }
    overlay_pool.entries.clear();
    overlay_pool.grid_len = 0;
    car_owner_index.clear();
    *counts = TrafficVehicleCounts::default();
}

// (moved to `traffic/spawn.rs`)
// (moved to `traffic/stuck.rs`)

// (moved to `traffic/lane_change.rs`)

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

fn compute_exit_direction(
    route: &[TilePos],
    grid: &MapGrid,
    first_intersection_tile: TilePos,
) -> RoadDir {
    movement::compute_exit_direction(route, grid, first_intersection_tile)
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
pub mod tests;
