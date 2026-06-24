//! M3: Traffic simulation – vehicles moving along roads via A* pathfinding.

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;

use crate::game::commands::GameCommand;
use crate::game::ids::CitizenId;
use crate::game::intersections::{IntersectionIndex, IntersectionPriority};
use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::roads::{RoadDir, RoadKind};
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
use movement::{check_intersection_priority, cleanup_right_on_red_markers, move_vehicles};

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

mod swap_break;
use swap_break::break_tile_swaps;

mod lane_change;
use lane_change::{
    build_traffic_spatial_index, build_traffic_spatial_index_pre_lane_changes, plan_lane_changes,
    plan_oncoming_overtakes, tick_lane_change_cooldowns, tick_overtake_oncoming, tick_overtaking,
};

mod vehicle_render;
// use vehicle_render::{interpolate_vehicle_position, update_vehicle_positions_for_interpolation}; // TODO: enable when GPU interpolation is needed

mod debug;
use debug::update_debug_vehicle_state;

mod traffic_spatial_index;
pub use traffic_spatial_index::TrafficSpatialIndex;

mod parked_tile_index;
pub use parked_tile_index::ParkedVehicleTileIndex;

// NOTE: v2 Stage B uses IDM params stored in `TrafficConfig` instead of a separate braking resource.

/// Distance to detect traffic lights ahead (in tiles)
#[allow(dead_code)] // Reserved for future use
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
/// Speed threshold (in tile fractions per second) for "snap to stopped" state at the stop line.
/// This avoids abrupt halts when a vehicle reaches the stop line with a non-trivial residual speed
/// due to coarse fixed-timestep integration.
#[allow(dead_code)] // Reserved for future use
const STOP_LOCK_SPEED_TILES_PER_SEC: f32 = 0.05;
/// Numerical epsilon for "at stop line" checks (in tile fractions).
#[allow(dead_code)] // Reserved for future use
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
/// Failsafe: if a vehicle is blocked at a clear intersection for too long, allow entry.
const INTERSECTION_FORCE_ENTRY_SECS: f32 = 8.0;
/// Starvation-free escape valve (cross-intersection deadlock breaker). If an intersection has had at
/// least one approach refused by a capacity/spillback gate (don't-block-the-box exit gate or the
/// downstream-link gate) for this many consecutive sim ticks (FixedUpdate, 10 Hz) without admitting
/// it, force-admit ONE refused approach this tick — bypassing those capacity gates but NOT the
/// `can_reserve` crossing-conflict check. This breaks the cross-intersection circular wait where
/// two adjacent clusters mutually refuse admission across a saturated short link. 30 ticks = 3 s:
/// long enough to ignore transient congestion, far below the 60 s reroute / 180 s despawn fallbacks.
pub(crate) const INTERSECTION_STALL_FORCE_TICKS: u32 = 30;

/// After this many seconds without progressing, try to resolve a traffic jam (reroute).
/// (v2 policy: avoid "cheat" behavior by default; only intervene after a long timeout.)
pub(crate) const STUCK_REROUTE_SECS: f32 = 60.0;
/// After this many seconds without progressing, despawn non-service trip vehicles as an emergency guardrail.
const STUCK_DESPAWN_SECS: f32 = 180.0;
/// A vehicle flagged `SwapDeadlocked` (in an off-intersection tile-swap with no straight escape) is
/// removed after this short grace — the swap breaker re-checks every tick and clears the flag the
/// moment the swap resolves, so a still-flagged car is genuinely wedged and must not pin the road.
const SWAP_DEADLOCK_DESPAWN_SECS: f32 = 3.0;
/// Maximum number of unstuck operations per tick (guardrail).
const MAX_UNSTUCK_PER_TICK: usize = 8;
/// Throttle new car spawns when congestion is extreme (keeps sim stable).
const SPAWN_THROTTLE_MAX_CONG: f32 = 0.95;
const SPAWN_THROTTLE_AVG_CONG: f32 = 0.85;

/// Run-condition: the legacy intersection pipeline — the per-vehicle connector rewrite
/// (`mark_vehicles_needing_connector_rewrite` + `rewrite_marked_intersection_connectors`) AND the
/// reservation producers (`collect_/apply_intersection_reservation_candidates`) — runs only when the
/// experimental lanelet routing is OFF. Under the flag the spawned route is already lanelet-correct
/// (rewriting it would clobber the route + invalidate `VehicleLaneletPlan` cursor offsets) and the
/// `arbitrate_lanelet_reservations` arbiter is the sole reservation producer. Exactly one producer
/// per tick: this predicate and `lanelet_arbiter_enabled` are mutually exclusive.
fn legacy_intersection_pipeline_enabled(cfg: Res<TrafficConfig>) -> bool {
    legacy_intersection_pipeline_enabled_for(&cfg)
}

/// Pure form of [`legacy_intersection_pipeline_enabled`] for tests.
pub(crate) fn legacy_intersection_pipeline_enabled_for(cfg: &TrafficConfig) -> bool {
    !cfg.experimental_lanelet_intersections
}

/// Run condition for the flag-on lanelet intersection arbiter (the inverse of
/// [`legacy_intersection_pipeline_enabled`]): the arbiter is the sole reservation producer when the
/// experimental flag is set.
fn lanelet_arbiter_enabled(cfg: Res<TrafficConfig>) -> bool {
    cfg.experimental_lanelet_intersections
}

#[cfg(test)]
mod tests_connector_gate {
    use super::*;

    #[test]
    fn legacy_pipeline_and_arbiter_are_mutually_exclusive() {
        let mut cfg = TrafficConfig::default();
        // Flag off: legacy pipeline runs, arbiter does not.
        assert!(
            legacy_intersection_pipeline_enabled_for(&cfg),
            "legacy intersection pipeline must run when the lanelet flag is off"
        );
        assert!(
            !cfg.experimental_lanelet_intersections,
            "arbiter must not run when the flag is off"
        );
        // Flag on: arbiter runs, legacy pipeline does not.
        cfg.experimental_lanelet_intersections = true;
        assert!(
            !legacy_intersection_pipeline_enabled_for(&cfg),
            "legacy intersection pipeline must be disabled when the lanelet flag is on"
        );
        assert!(
            cfg.experimental_lanelet_intersections,
            "arbiter must be the sole producer when the flag is on"
        );
    }
}

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
#[cfg(test)]
use intersection::plan_intersection_reservations;
#[cfg(test)]
use intersection::rewrite_intersection_connectors;
use intersection::{
    ApproachFairness, ArbiterIndexCache, LaneletStallTracker, RingTopologyStatus,
    apply_intersection_reservation_candidates, arbitrate_lanelet_reservations,
    cache_intersection_light_state, cache_pedestrian_crossing_state, check_ring_free_topology,
    cleanup_intersection_reservations, collect_intersection_reservation_candidates,
    mark_vehicles_needing_connector_rewrite, nudge_lanelet_stall_reroute,
    reset_intersection_reservations, rewrite_marked_intersection_connectors,
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
            .init_resource::<intersection::IntersectionReservationCandidates>()
            .init_resource::<intersection::IntersectionLightStateCache>()
            .init_resource::<intersection::PedestrianCrossingStateCache>()
            .init_resource::<ArbiterIndexCache>()
            .init_resource::<ArbiterTickStats>()
            .init_resource::<ApproachFairness>()
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
                    .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused)))
                    .run_if(lanelet_arbiter_enabled),
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
                    check_intersection_priority.after(update_vehicle_traffic_state),
                    spawn_trip_vehicles,
                    tick_lane_change_cooldowns,
                    tick_overtaking,
                    tick_overtake_oncoming,
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
                        .after(check_intersection_priority)
                        .after(spawn_trip_vehicles)
                        .after(tick_overtake_oncoming)
                        .before(plan_lane_changes),
                    plan_lane_changes
                        .after(check_intersection_priority)
                        .after(spawn_trip_vehicles)
                        .before(move_vehicles),
                    build_traffic_spatial_index
                        .after(plan_lane_changes)
                        .before(plan_oncoming_overtakes)
                        .before(collect_intersection_reservation_candidates)
                        .before(apply_intersection_reservation_candidates)
                        .before(move_vehicles),
                    plan_oncoming_overtakes
                        .after(plan_lane_changes)
                        .before(mark_vehicles_needing_connector_rewrite)
                        .before(rewrite_marked_intersection_connectors)
                        .before(collect_intersection_reservation_candidates)
                        .before(apply_intersection_reservation_candidates)
                        .before(move_vehicles),
                    mark_vehicles_needing_connector_rewrite
                        .after(plan_oncoming_overtakes)
                        .before(rewrite_marked_intersection_connectors)
                        .before(cache_intersection_light_state)
                        .before(cache_pedestrian_crossing_state)
                        .before(collect_intersection_reservation_candidates)
                        .run_if(legacy_intersection_pipeline_enabled),
                    rewrite_marked_intersection_connectors
                        .after(mark_vehicles_needing_connector_rewrite)
                        .before(cache_intersection_light_state)
                        .before(cache_pedestrian_crossing_state)
                        .before(collect_intersection_reservation_candidates)
                        .run_if(legacy_intersection_pipeline_enabled),
                    cache_intersection_light_state
                        .after(rewrite_marked_intersection_connectors)
                        .before(collect_intersection_reservation_candidates),
                    cache_pedestrian_crossing_state
                        .after(rewrite_marked_intersection_connectors)
                        .before(collect_intersection_reservation_candidates),
                    collect_intersection_reservation_candidates
                        .after(rewrite_marked_intersection_connectors)
                        .after(cache_intersection_light_state)
                        .after(cache_pedestrian_crossing_state)
                        .before(apply_intersection_reservation_candidates)
                        .before(move_vehicles)
                        .run_if(legacy_intersection_pipeline_enabled),
                    apply_intersection_reservation_candidates
                        .after(collect_intersection_reservation_candidates)
                        .before(move_vehicles)
                        .run_if(legacy_intersection_pipeline_enabled),
                    // Flag-on sole reservation producer. Ordered after the legacy apply so the two
                    // never race the shared IntersectionReservations; flag-on the legacy
                    // collect/apply are gated off (mutually-exclusive run conditions), making this
                    // `.after` vacuous.
                    arbitrate_lanelet_reservations
                        .after(apply_intersection_reservation_candidates)
                        .after(cache_intersection_light_state)
                        .after(cache_pedestrian_crossing_state)
                        .before(break_tile_swaps)
                        .before(move_vehicles)
                        .run_if(lanelet_arbiter_enabled),
                    break_tile_swaps
                        .after(apply_intersection_reservation_candidates)
                        .before(move_vehicles),
                    move_vehicles.after(apply_intersection_reservation_candidates),
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
                    // Flag-on mandatory-merge: force a reroute for vehicles whose lanelet never
                    // resolves, after update_stuck_timers (so the bump survives) and before reroute.
                    nudge_lanelet_stall_reroute
                        .after(update_stuck_timers)
                        .before(resolve_stuck_vehicles)
                        .run_if(lanelet_arbiter_enabled),
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

fn oncoming_lane_offset(grid: &MapGrid, current: TilePos, travel_dir: RoadDir) -> Option<IVec2> {
    lane_change::oncoming_lane_offset(grid, current, travel_dir)
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
