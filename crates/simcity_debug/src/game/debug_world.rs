use bevy::diagnostic::{DiagnosticsStore, FrameTimeDiagnosticsPlugin};
use bevy::ecs::message::MessageReader;
use bevy::ecs::system::{EntityCommands, SystemParam};
use bevy::prelude::*;
use bevy::time::Real;
use std::collections::VecDeque;

use crate::game::buildings::{Building, BuildingPhase, BuildingTuning};
use crate::game::camera::MainCamera;
use crate::game::citizens::{Citizen, CitizenState, CommuteStats, ShoppingDemandStats};
use crate::game::demand::RciDemand;
use crate::game::economy::EconomyConfig;
use crate::game::emergencies::{Emergency, EmergencyKind, EmergencyManager, EmergencyMarker};
use crate::game::employment::{EmploymentConfig, EmploymentStats};
use crate::game::intersections::IntersectionIndex;
use crate::game::land_value::LandValueIndex;
use crate::game::map::{
    BuildingKind, HoveredTile, MapConfig, MapEditVersion, MapGrid, TilePos, ZoneKind,
};
use crate::game::mcp_status::{MCP_ACTIVE_WINDOW_S, MCP_IDLE_WINDOW_S, McpConnectionStatus};
use crate::game::pedestrians::{
    BlockedAtUncontrolled, Pedestrian, PedestrianConfig, PedestrianCrossing,
};
use crate::game::pollution::PollutionIndex;
use crate::game::services::{ServiceCoverageIndex, ServiceKind, ServiceStation, ServiceVehicle};
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;
use crate::game::traffic::{
    ArbiterTickStats, IntersectionReservations, ManeuverKind, ReservationState, TrafficConfig,
    TrafficIndex, TrafficOccupancy, TrafficVehicleCounts,
};
use crate::game::transport::{
    GraphVersion, LaneGraph, LaneletConflictMatrices, LaneletGraph, PathCache, PathPool,
    PathfindingConfig, RegionGraph, RoadGraph,
};
use crate::game::trips::{TripFinished, TripMode, TripPurpose, TripRequested};
use crate::game::ui_state::{OverlayMode, SimSpeed, UiState};

/// ECS-visible snapshot for MCP debugging (small, flattened, reflection-friendly).
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component)]
pub struct DebugWorldSnapshot {
    pub app_state: String,
    pub sim_speed: String,
    pub overlay: String,
    pub day: u32,
    pub hour: u8,
    pub money: i64,
    pub population: u32,
    pub happiness: f32,
    pub last_income: i64,
    pub last_expense: i64,
    pub map_width: i32,
    pub map_height: i32,
    pub tile_size: f32,
    pub camera_pos: Vec2,
    pub camera_zoom: f32,
    pub hovered_tile_valid: bool,
    pub hovered_tile_x: i32,
    pub hovered_tile_y: i32,
    pub traffic_road_tiles: u32,
    pub traffic_vehicles_on_roads: u32,
    pub traffic_avg_congestion: f32,
    pub traffic_max_congestion: f32,
    pub fps: f32,
    pub fps_smoothed: f32,
    pub frame_time_ms: f32,
    pub frame_time_smoothed_ms: f32,
    pub frame_count: u64,
    pub perf_low_fps_threshold: f32,
    pub perf_critical_fps_threshold: f32,
    pub perf_frame_spike_threshold_ms: f32,
    pub perf_flag_low_fps: bool,
    pub perf_flag_critical_fps: bool,
    pub perf_flag_frame_spike: bool,
    pub perf_flag_drop_active: bool,
    pub perf_drops_total: u32,
    pub perf_drops_last_60s: u32,
    pub perf_window_1s_samples: u32,
    pub perf_window_1s_fps_min: f32,
    pub perf_window_1s_fps_max: f32,
    pub perf_window_1s_fps_avg: f32,
    pub perf_window_1s_frame_ms_min: f32,
    pub perf_window_1s_frame_ms_max: f32,
    pub perf_window_1s_frame_ms_avg: f32,
    pub perf_window_5s_samples: u32,
    pub perf_window_5s_fps_min: f32,
    pub perf_window_5s_fps_max: f32,
    pub perf_window_5s_fps_avg: f32,
    pub perf_window_5s_frame_ms_min: f32,
    pub perf_window_5s_frame_ms_max: f32,
    pub perf_window_5s_frame_ms_avg: f32,
    pub perf_active_drop_start_s: f32,
    pub perf_active_drop_duration_s: f32,
    pub perf_active_drop_samples: u32,
    pub perf_active_drop_fps_min: f32,
    pub perf_active_drop_fps_max: f32,
    pub perf_active_drop_fps_avg: f32,
    pub perf_active_drop_frame_ms_min: f32,
    pub perf_active_drop_frame_ms_max: f32,
    pub perf_active_drop_frame_ms_avg: f32,
    pub perf_last_drop_valid: bool,
    pub perf_last_drop_start_s: f32,
    pub perf_last_drop_end_s: f32,
    pub perf_last_drop_duration_s: f32,
    pub perf_last_drop_samples: u32,
    pub perf_last_drop_fps_min: f32,
    pub perf_last_drop_fps_max: f32,
    pub perf_last_drop_fps_avg: f32,
    pub perf_last_drop_frame_ms_min: f32,
    pub perf_last_drop_frame_ms_max: f32,
    pub perf_last_drop_frame_ms_avg: f32,
    pub mcp_remote_enabled: bool,
    pub mcp_pending_requests: usize,
    pub mcp_last_request_age_s: Option<f32>,
    pub mcp_is_active: bool,
    pub mcp_is_idle: bool,
}

/// Traffic subsystem snapshot for MCP inspection.
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugTrafficSnapshot {
    /// Vehicles currently active (not parked).
    pub active_vehicles: u32,
    /// Vehicles currently parked.
    pub parked_vehicles: u32,
    /// Total vehicles tracked.
    pub total_vehicles: u32,
    /// Vehicles currently occupying road tiles.
    pub vehicles_on_roads: u32,
    /// Total road tiles in the map.
    pub road_tiles: u32,
    /// Average congestion in [0..1].
    pub avg_congestion: f32,
    /// Maximum congestion in [0..1].
    pub max_congestion: f32,
    /// Whether a max congestion tile is known.
    pub max_congestion_tile_valid: bool,
    /// Max congestion tile x.
    pub max_congestion_tile_x: i32,
    /// Max congestion tile y.
    pub max_congestion_tile_y: i32,
    /// Vehicles on the max congestion tile.
    pub max_congestion_tile_vehicles: u16,
    /// Capacity on the max congestion tile.
    pub max_congestion_tile_capacity: u16,
    /// Max smoothed heat value across tiles.
    pub occupancy_max_heat: f32,
    /// Tiles with at least one vehicle in the latest tick.
    pub occupancy_nonzero_tiles: u32,
    /// Maximum vehicles on a single tile in the latest tick.
    pub occupancy_max_vehicles: u16,
}

/// Intersection subsystem snapshot for MCP inspection.
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugIntersectionSnapshot {
    /// Total intersection clusters.
    pub intersection_count: u32,
    /// Total tiles belonging to intersection clusters.
    pub intersection_tiles: u32,
    /// Intersections with traffic lights.
    pub traffic_light_count: u32,
    /// Intersections with at least one reservation.
    pub reservation_intersection_count: u32,
    /// Total active reservations.
    pub reservation_total: u32,
    /// Reservations in Approaching state.
    pub reservation_approaching: u32,
    /// Reservations in Inside state.
    pub reservation_inside: u32,
    /// Reservations for straight maneuvers.
    pub reservation_straight: u32,
    /// Reservations for right turns.
    pub reservation_right: u32,
    /// Reservations for left turns.
    pub reservation_left: u32,
    /// Reservations for other maneuvers.
    pub reservation_other: u32,
}

/// Transport/pathfinding snapshot for MCP inspection.
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugTransportSnapshot {
    /// Current graph version.
    pub graph_version: u64,
    /// Road graph version.
    pub road_graph_version: u64,
    /// Road graph edge count.
    pub road_graph_edges: u32,
    /// Road graph road node count.
    pub road_graph_road_tiles: u32,
    /// Lane graph version.
    pub lane_graph_version: u64,
    /// Lane count.
    pub lane_count: u32,
    /// Lane connection count.
    pub lane_connections: u32,
    /// Region graph version.
    pub region_graph_version: u64,
    /// Region size in tiles.
    pub region_size: u32,
    /// Region count.
    pub region_count: u32,
    /// Region graph edge count.
    pub region_edges: u32,
    /// Path pool total entries.
    pub path_pool_entries_total: u32,
    /// Path pool used entries.
    pub path_pool_entries_used: u32,
    /// Path pool free entries.
    pub path_pool_entries_free: u32,
    /// Path pool dedup handle count.
    pub path_pool_dedup_entries: u32,
    /// Path pool memory usage estimate (bytes).
    pub path_pool_memory_bytes: u64,
    /// Path pool current version.
    pub path_pool_version: u64,
    /// Path cache entries.
    pub path_cache_entries: u32,
    /// Path cache LRU queue length.
    pub path_cache_lru_len: u32,
    /// Path cache version.
    pub path_cache_version: u64,
}

/// Citizen subsystem snapshot for MCP inspection.
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugCitizensSnapshot {
    /// Total citizens.
    pub citizens_total: u32,
    /// Citizens at home.
    pub citizens_at_home: u32,
    /// Citizens traveling to work.
    pub citizens_to_work: u32,
    /// Citizens at work.
    pub citizens_at_work: u32,
    /// Citizens traveling to shop.
    pub citizens_to_shop: u32,
    /// Citizens at shop.
    pub citizens_at_shop: u32,
    /// Citizens returning home.
    pub citizens_to_home: u32,
    /// Average commute duration in seconds.
    pub commute_avg_secs: f32,
    /// Commute sample count.
    pub commute_samples: u32,
    /// Shopping demand events (current tick).
    pub shopping_demand_events: u32,
    /// Shopping unmet events (current tick).
    pub shopping_unmet_events: u32,
    /// Shopping unmet ratio in [0..1].
    pub shopping_unmet_ratio: f32,
}

/// Employment subsystem snapshot for MCP inspection.
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugEmploymentSnapshot {
    /// Total employed citizens.
    pub employed: u32,
    /// Total unemployed citizens.
    pub unemployed: u32,
    /// Employed at commercial buildings.
    pub employed_commercial: u32,
    /// Employed at industrial buildings.
    pub employed_industrial: u32,
    /// Employment rate in [0..1].
    pub employment_rate: f32,
    /// Job-assignment road-path attempts in the latest tick.
    pub pathfind_attempts_last_tick: u32,
    /// Failed job-assignment road-path attempts in the latest tick.
    pub pathfind_failures_last_tick: u32,
    /// Candidate pairs skipped by per-tick failed-pair memoization.
    pub skipped_failed_pairs_last_tick: u32,
    /// Candidate pairs checked against cross-tick unreachable cache.
    pub unreachable_cache_lookups_last_tick: u32,
    /// Candidate pairs skipped by cross-tick unreachable cache.
    pub skipped_unreachable_cache_last_tick: u32,
    /// New entries inserted into cross-tick unreachable cache.
    pub unreachable_cache_inserts_last_tick: u32,
    /// Current entry count in cross-tick unreachable cache.
    pub unreachable_cache_entries: u32,
    /// Entries evicted by TTL from cross-tick unreachable cache.
    pub unreachable_cache_ttl_evictions_last_tick: u32,
    /// Entries evicted by capacity from cross-tick unreachable cache.
    pub unreachable_cache_capacity_evictions_last_tick: u32,
    /// True when cross-tick unreachable cache was cleared by graph version change.
    pub unreachable_cache_graph_cleared_last_tick: bool,
    /// Unemployed citizens scanned by assign_jobs in the latest tick.
    pub unassigned_scanned_last_tick: u32,
    /// True when assign_jobs hit at least one per-tick budget.
    pub budget_hit_last_tick: bool,
}

/// Buildings subsystem snapshot for MCP inspection.
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugBuildingsSnapshot {
    /// Total buildings.
    pub buildings_total: u32,
    /// Residential buildings.
    pub buildings_residential: u32,
    /// Commercial buildings.
    pub buildings_commercial: u32,
    /// Industrial buildings.
    pub buildings_industrial: u32,
    /// Service buildings (fire/police/medical).
    pub buildings_service: u32,
    /// Operational buildings.
    pub buildings_operational: u32,
    /// Under construction buildings.
    pub buildings_under_construction: u32,
    /// Total residential capacity.
    pub residents_capacity: u32,
    /// Total residential occupancy.
    pub residents_occupancy: u32,
    /// Total job capacity.
    pub jobs_capacity: u32,
    /// Total job occupancy.
    pub jobs_occupancy: u32,
    /// Total residential target occupancy.
    pub residents_target: u32,
    /// Total job target occupancy.
    pub jobs_target: u32,
}

/// Pedestrian subsystem snapshot for MCP inspection.
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugPedestriansSnapshot {
    /// Total pedestrians.
    pub pedestrians_total: u32,
    /// Pedestrians blocked at uncontrolled crossings.
    pub pedestrians_blocked: u32,
    /// Pedestrians currently crossing intersections.
    pub pedestrians_crossing: u32,
    /// Average blocked wait time in game hours.
    pub blocked_wait_avg_hours: f32,
    /// Maximum blocked wait time in game hours.
    pub blocked_wait_max_hours: f32,
}

/// Services subsystem snapshot for MCP inspection.
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugServicesSnapshot {
    /// Fire stations.
    pub stations_fire: u32,
    /// Police stations.
    pub stations_police: u32,
    /// Medical stations.
    pub stations_medical: u32,
    /// Total service vehicles.
    pub vehicles_total: u32,
    /// Fire service vehicles.
    pub vehicles_fire: u32,
    /// Police service vehicles.
    pub vehicles_police: u32,
    /// Medical service vehicles.
    pub vehicles_medical: u32,
    /// Fire coverage ratio.
    pub coverage_fire: f32,
    /// Police coverage ratio.
    pub coverage_police: f32,
    /// Medical coverage ratio.
    pub coverage_medical: f32,
    /// Overall coverage ratio.
    pub coverage_overall: f32,
    /// Total zoned buildings counted for coverage.
    pub coverage_buildings_total: u32,
}

/// Emergency subsystem snapshot for MCP inspection.
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugEmergenciesSnapshot {
    /// Active emergencies.
    pub emergencies_active: u32,
    /// Active fire emergencies.
    pub emergencies_fire: u32,
    /// Active crime emergencies.
    pub emergencies_crime: u32,
    /// Active medical emergencies.
    pub emergencies_medical: u32,
    /// Active emergencies awaiting response.
    pub emergencies_unresponded: u32,
    /// Active visual emergency markers.
    pub emergency_markers_active: u32,
    /// Hours since last spawn attempt.
    pub hours_since_last_spawn: u32,
    /// Max allowed active emergencies.
    pub max_active_emergencies: u32,
    /// Total fires spawned.
    pub stats_total_fires: u32,
    /// Total crimes spawned.
    pub stats_total_crimes: u32,
    /// Total medical emergencies spawned.
    pub stats_total_medical: u32,
    /// Unresponded fires.
    pub stats_unresponded_fires: u32,
    /// Unresponded crimes.
    pub stats_unresponded_crime: u32,
    /// Unresponded medical.
    pub stats_unresponded_medical: u32,
    /// Total resolved emergencies.
    pub stats_total_resolved: u32,
    /// Resolved within deadline.
    pub stats_resolved_in_time: u32,
    /// Failed responses.
    pub stats_failed_responses: u32,
}

/// Trip events snapshot for MCP inspection.
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugTripsSnapshot {
    /// TripRequested events this tick.
    pub requested_total: u32,
    /// Requested walk trips.
    pub requested_walk: u32,
    /// Requested car trips.
    pub requested_car: u32,
    /// TripFinished events this tick.
    pub finished_total: u32,
    /// Finished work trips.
    pub finished_work: u32,
    /// Finished shop trips.
    pub finished_shop: u32,
    /// Finished return-home trips.
    pub finished_return_home: u32,
}

/// Map grid snapshot for MCP inspection.
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugMapSnapshot {
    /// Map edit version.
    pub map_edit_version: u64,
    /// Total tiles.
    pub tiles_total: u32,
    /// Water tiles.
    pub tiles_water: u32,
    /// Road tiles.
    pub tiles_road: u32,
    /// Residential zone tiles.
    pub tiles_zone_residential: u32,
    /// Commercial zone tiles.
    pub tiles_zone_commercial: u32,
    /// Industrial zone tiles.
    pub tiles_zone_industrial: u32,
    /// Tiles occupied by buildings.
    pub tiles_building: u32,
    /// Tiles occupied by service buildings.
    pub tiles_building_service: u32,
}

/// Environment snapshot for land value and pollution.
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugEnvironmentSnapshot {
    /// Minimum land value in [0..1].
    pub land_value_min: f32,
    /// Maximum land value in [0..1].
    pub land_value_max: f32,
    /// Average land value in [0..1].
    pub land_value_avg: f32,
    /// Minimum pollution in [0..1].
    pub pollution_min: f32,
    /// Maximum pollution in [0..1].
    pub pollution_max: f32,
    /// Average pollution in [0..1].
    pub pollution_avg: f32,
}

/// RCI demand snapshot for MCP inspection.
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugDemandSnapshot {
    /// Residential demand in [-1..1].
    pub demand_residential: f32,
    /// Commercial demand in [-1..1].
    pub demand_commercial: f32,
    /// Industrial demand in [-1..1].
    pub demand_industrial: f32,
}

/// Config snapshot for MCP inspection.
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugConfigSnapshot {
    /// Traffic: max active vehicles.
    pub traffic_max_active_vehicles: u32,
    /// Traffic: max route plans per tick.
    pub traffic_max_route_plans_per_tick: u32,
    /// Traffic: heat EMA decay.
    pub traffic_heat_ema_decay: f32,
    /// Traffic: drive on right flag.
    pub traffic_drive_on_right: bool,
    /// Traffic: meters per tile.
    pub traffic_tile_meters: f32,
    /// Traffic: IDM desired headway (sec).
    pub traffic_idm_desired_headway_secs: f32,
    /// Traffic: IDM min gap (m).
    pub traffic_idm_min_gap_m: f32,
    /// Traffic: IDM max accel (m/s^2).
    pub traffic_idm_max_accel_mps2: f32,
    /// Traffic: IDM comfortable decel (m/s^2).
    pub traffic_idm_comfortable_decel_mps2: f32,
    /// Traffic: IDM max decel (m/s^2).
    pub traffic_idm_max_decel_mps2: f32,
    /// Traffic: IDM delta.
    pub traffic_idm_delta: f32,
    /// Pathfinding: cache capacity.
    pub path_cache_capacity: u32,
    /// Pathfinding: cache TTL seconds.
    pub path_cache_ttl_secs: f64,
    /// Pathfinding: congestion weight.
    pub path_congestion_k: f32,
    /// Pathfinding: congestion max.
    pub path_congestion_max: f32,
    /// Pathfinding: lane change penalty.
    pub path_lane_change_penalty: f32,
    /// Pathfinding: turn penalty.
    pub path_turn_penalty: f32,
    /// Pathfinding: cost scale.
    pub path_cost_scale: f32,
    /// Pathfinding: hierarchical enabled.
    pub path_enable_hierarchical: bool,
    /// Pathfinding: region size.
    pub path_region_size: u32,
    /// Pathfinding: region pad.
    pub path_region_pad: i32,
    /// Economy: tax per citizen.
    pub economy_tax_per_citizen: i64,
    /// Economy: income per commercial.
    pub economy_income_per_commercial: i64,
    /// Economy: income per industrial.
    pub economy_income_per_industrial: i64,
    /// Economy: road maintenance.
    pub economy_road_maintenance: i64,
    /// Economy: building maintenance.
    pub economy_building_maintenance: i64,
    /// Economy: happiness target.
    pub economy_happiness_target: f32,
    /// Employment: max assignments per tick.
    pub employment_max_assignments_per_tick: u32,
    /// Employment: max candidates per citizen.
    pub employment_max_candidates_per_citizen: u32,
    /// Employment: max road-path attempts per tick.
    pub employment_max_pathfind_attempts_per_tick: u32,
    /// Employment: max unemployed scans per tick.
    pub employment_max_unassigned_scans_per_tick: u32,
    /// Employment: enable cross-tick unreachable pair cache.
    pub employment_unreachable_pair_cache_enabled: bool,
    /// Employment: max entries in cross-tick unreachable pair cache.
    pub employment_unreachable_pair_cache_capacity: u32,
    /// Employment: cross-tick unreachable pair cache TTL in assign_jobs ticks.
    pub employment_unreachable_pair_cache_ttl_ticks: u32,
    /// Pedestrians: walk speed (km/h).
    pub pedestrian_walk_speed_kmh: f32,
    /// Pedestrians: max walk tour (m).
    pub pedestrian_walk_tour_max_m: f32,
    /// Pedestrians: hard cap for active walker entities.
    pub pedestrian_max_active_walkers: u32,
    /// Pedestrians: per-tick cap for new walker spawns.
    pub pedestrian_max_walkers_spawn_per_tick: u32,
    /// Pedestrians: wait reroute hours.
    pub pedestrian_wait_reroute_hours: f32,
    /// Pedestrians: wait reroute max attempts.
    pub pedestrian_wait_reroute_max_attempts: u8,
    /// Pedestrians: uncontrolled safety margin (sec).
    pub pedestrian_uncontrolled_safety_margin_secs: f32,
    /// Pedestrians: uncontrolled min gap (tiles).
    pub pedestrian_uncontrolled_min_gap_tiles: f32,
    /// Buildings: growth period (sec).
    pub building_growth_period_secs: f32,
}

/// Resource tracking the current debug snapshot entity.
#[derive(Resource, Default)]
struct DebugSnapshotEntity {
    entity: Option<Entity>,
}

/// Bundle that groups all MCP debug snapshot components.
#[derive(Bundle)]
struct DebugSnapshotBundle {
    /// ECS name for the debug entity.
    name: Name,
    /// World snapshot.
    world: DebugWorldSnapshot,
    /// Traffic snapshot.
    traffic: DebugTrafficSnapshot,
    /// Intersection snapshot.
    intersections: DebugIntersectionSnapshot,
    /// Transport snapshot.
    transport: DebugTransportSnapshot,
    /// Citizens snapshot.
    citizens: DebugCitizensSnapshot,
    /// Employment snapshot.
    employment: DebugEmploymentSnapshot,
    /// Buildings snapshot.
    buildings: DebugBuildingsSnapshot,
    /// Pedestrians snapshot.
    pedestrians: DebugPedestriansSnapshot,
    /// Services snapshot.
    services: DebugServicesSnapshot,
    /// Emergencies snapshot.
    emergencies: DebugEmergenciesSnapshot,
    /// Trips snapshot.
    trips: DebugTripsSnapshot,
    /// Map snapshot.
    map: DebugMapSnapshot,
    /// Environment snapshot.
    environment: DebugEnvironmentSnapshot,
    /// Demand snapshot.
    demand: DebugDemandSnapshot,
    /// Config snapshot.
    config: DebugConfigSnapshot,
    /// Lanelet graph mirror.
    lanelet: DebugLaneletState,
    /// Lanelet arbiter ledger mirror.
    arbiter_ledger: DebugArbiterLedgerState,
}

impl DebugSnapshotBundle {
    /// Build a fully populated debug snapshot bundle.
    fn new() -> Self {
        Self {
            name: Name::new("DebugWorldSnapshot"),
            world: DebugWorldSnapshot::default(),
            traffic: DebugTrafficSnapshot::default(),
            intersections: DebugIntersectionSnapshot::default(),
            transport: DebugTransportSnapshot::default(),
            citizens: DebugCitizensSnapshot::default(),
            employment: DebugEmploymentSnapshot::default(),
            buildings: DebugBuildingsSnapshot::default(),
            pedestrians: DebugPedestriansSnapshot::default(),
            services: DebugServicesSnapshot::default(),
            emergencies: DebugEmergenciesSnapshot::default(),
            trips: DebugTripsSnapshot::default(),
            map: DebugMapSnapshot::default(),
            environment: DebugEnvironmentSnapshot::default(),
            demand: DebugDemandSnapshot::default(),
            config: DebugConfigSnapshot::default(),
            lanelet: DebugLaneletState::default(),
            arbiter_ledger: DebugArbiterLedgerState::default(),
        }
    }
}

#[derive(SystemParam)]
struct DebugSnapshotEnsureQueries<'w, 's> {
    q_snapshot: Query<'w, 's, Entity, With<DebugWorldSnapshot>>,
    q_traffic: Query<'w, 's, (), With<DebugTrafficSnapshot>>,
    q_intersections: Query<'w, 's, (), With<DebugIntersectionSnapshot>>,
    q_transport: Query<'w, 's, (), With<DebugTransportSnapshot>>,
    q_citizens: Query<'w, 's, (), With<DebugCitizensSnapshot>>,
    q_employment: Query<'w, 's, (), With<DebugEmploymentSnapshot>>,
    q_buildings: Query<'w, 's, (), With<DebugBuildingsSnapshot>>,
    q_pedestrians: Query<'w, 's, (), With<DebugPedestriansSnapshot>>,
    q_services: Query<'w, 's, (), With<DebugServicesSnapshot>>,
    q_emergencies: Query<'w, 's, (), With<DebugEmergenciesSnapshot>>,
    q_trips: Query<'w, 's, (), With<DebugTripsSnapshot>>,
    q_map: Query<'w, 's, (), With<DebugMapSnapshot>>,
    q_environment: Query<'w, 's, (), With<DebugEnvironmentSnapshot>>,
    q_demand: Query<'w, 's, (), With<DebugDemandSnapshot>>,
    q_config: Query<'w, 's, (), With<DebugConfigSnapshot>>,
    q_lanelet: Query<'w, 's, (), With<DebugLaneletState>>,
    q_arbiter_ledger: Query<'w, 's, (), With<DebugArbiterLedgerState>>,
}

/// Plugin that exposes a small debug snapshot component for MCP inspection.
pub struct DebugWorldPlugin;

impl Plugin for DebugWorldPlugin {
    fn build(&self, app: &mut App) {
        app.register_type::<DebugWorldSnapshot>()
            .register_type::<DebugTrafficSnapshot>()
            .register_type::<DebugIntersectionSnapshot>()
            .register_type::<DebugTransportSnapshot>()
            .register_type::<DebugCitizensSnapshot>()
            .register_type::<DebugEmploymentSnapshot>()
            .register_type::<DebugBuildingsSnapshot>()
            .register_type::<DebugPedestriansSnapshot>()
            .register_type::<DebugServicesSnapshot>()
            .register_type::<DebugEmergenciesSnapshot>()
            .register_type::<DebugTripsSnapshot>()
            .register_type::<DebugMapSnapshot>()
            .register_type::<DebugEnvironmentSnapshot>()
            .register_type::<DebugDemandSnapshot>()
            .register_type::<DebugConfigSnapshot>()
            .register_type::<DebugLaneletState>()
            .register_type::<DebugArbiterLedgerState>()
            .init_resource::<DebugSnapshotEntity>()
            .add_systems(Startup, spawn_debug_snapshot)
            .add_systems(Update, ensure_debug_snapshot_entity.in_set(GameSet::Ui))
            .add_systems(Update, update_debug_snapshot.in_set(GameSet::Ui))
            .add_systems(Update, update_debug_traffic_snapshot.in_set(GameSet::Ui))
            .add_systems(
                Update,
                update_debug_intersection_snapshot.in_set(GameSet::Ui),
            )
            .add_systems(Update, update_debug_transport_snapshot.in_set(GameSet::Ui))
            .add_systems(Update, update_debug_citizens_snapshot.in_set(GameSet::Ui))
            .add_systems(Update, update_debug_employment_snapshot.in_set(GameSet::Ui))
            .add_systems(Update, update_debug_buildings_snapshot.in_set(GameSet::Ui))
            .add_systems(
                Update,
                update_debug_pedestrians_snapshot.in_set(GameSet::Ui),
            )
            .add_systems(Update, update_debug_services_snapshot.in_set(GameSet::Ui))
            .add_systems(
                Update,
                update_debug_emergencies_snapshot.in_set(GameSet::Ui),
            )
            .add_systems(Update, update_debug_trips_snapshot.in_set(GameSet::Ui))
            .add_systems(Update, update_debug_map_snapshot.in_set(GameSet::Ui))
            .add_systems(
                Update,
                update_debug_environment_snapshot.in_set(GameSet::Ui),
            )
            .add_systems(Update, update_debug_demand_snapshot.in_set(GameSet::Ui))
            .add_systems(Update, update_debug_config_snapshot.in_set(GameSet::Ui))
            .add_systems(Update, update_debug_lanelet_state.in_set(GameSet::Ui))
            .add_systems(
                Update,
                update_debug_arbiter_ledger_state.in_set(GameSet::Ui),
            );
    }
}

/// Spawn the MCP debug snapshot entity once at startup.
fn spawn_debug_snapshot(mut commands: Commands, mut holder: ResMut<DebugSnapshotEntity>) {
    let entity = commands.spawn(DebugSnapshotBundle::new()).id();
    holder.entity = Some(entity);
}

/// Ensure we always have a valid snapshot entity (handles despawns/reloads).
fn ensure_debug_snapshot_entity(
    mut commands: Commands,
    mut holder: ResMut<DebugSnapshotEntity>,
    queries: DebugSnapshotEnsureQueries,
) {
    if let Some(entity) = holder.entity
        && queries.q_snapshot.get(entity).is_ok()
    {
        return;
    }

    let entity = queries
        .q_snapshot
        .iter()
        .next()
        .unwrap_or_else(|| commands.spawn(DebugSnapshotBundle::new()).id());
    let mut entity_cmd = commands.entity(entity);
    ensure_component::<DebugTrafficSnapshot>(&mut entity_cmd, entity, &queries.q_traffic);
    ensure_component::<DebugIntersectionSnapshot>(
        &mut entity_cmd,
        entity,
        &queries.q_intersections,
    );
    ensure_component::<DebugTransportSnapshot>(&mut entity_cmd, entity, &queries.q_transport);
    ensure_component::<DebugCitizensSnapshot>(&mut entity_cmd, entity, &queries.q_citizens);
    ensure_component::<DebugEmploymentSnapshot>(&mut entity_cmd, entity, &queries.q_employment);
    ensure_component::<DebugBuildingsSnapshot>(&mut entity_cmd, entity, &queries.q_buildings);
    ensure_component::<DebugPedestriansSnapshot>(&mut entity_cmd, entity, &queries.q_pedestrians);
    ensure_component::<DebugServicesSnapshot>(&mut entity_cmd, entity, &queries.q_services);
    ensure_component::<DebugEmergenciesSnapshot>(&mut entity_cmd, entity, &queries.q_emergencies);
    ensure_component::<DebugTripsSnapshot>(&mut entity_cmd, entity, &queries.q_trips);
    ensure_component::<DebugMapSnapshot>(&mut entity_cmd, entity, &queries.q_map);
    ensure_component::<DebugEnvironmentSnapshot>(&mut entity_cmd, entity, &queries.q_environment);
    ensure_component::<DebugDemandSnapshot>(&mut entity_cmd, entity, &queries.q_demand);
    ensure_component::<DebugConfigSnapshot>(&mut entity_cmd, entity, &queries.q_config);
    ensure_component::<DebugLaneletState>(&mut entity_cmd, entity, &queries.q_lanelet);
    ensure_component::<DebugArbiterLedgerState>(&mut entity_cmd, entity, &queries.q_arbiter_ledger);

    holder.entity = Some(entity);
}

/// Ensure the debug snapshot entity contains a component.
fn ensure_component<T: Component + Default>(
    entity_cmd: &mut EntityCommands,
    entity: Entity,
    q: &Query<(), With<T>>,
) {
    if q.get(entity).is_err() {
        entity_cmd.insert(T::default());
    }
}

const PERF_LOW_FPS_THRESHOLD: f32 = 45.0;
const PERF_CRITICAL_FPS_THRESHOLD: f32 = 30.0;
const PERF_FRAME_SPIKE_THRESHOLD_MS: f32 = 25.0;
const PERF_HISTORY_WINDOW_S: f32 = 60.0;
const PERF_WINDOW_SHORT_S: f32 = 1.0;
const PERF_WINDOW_MEDIUM_S: f32 = 5.0;
const PERF_DROP_RECOVER_FRAMES: u8 = 6;

#[derive(Copy, Clone)]
struct PerfSample {
    t_s: f32,
    fps: f32,
    frame_ms: f32,
}

#[derive(Copy, Clone, Default)]
struct PerfWindowStats {
    samples: u32,
    fps_min: f32,
    fps_max: f32,
    fps_avg: f32,
    frame_ms_min: f32,
    frame_ms_max: f32,
    frame_ms_avg: f32,
}

#[derive(Copy, Clone, Default)]
struct PerfDropSnapshot {
    start_s: f32,
    end_s: f32,
    duration_s: f32,
    samples: u32,
    fps_min: f32,
    fps_max: f32,
    fps_avg: f32,
    frame_ms_min: f32,
    frame_ms_max: f32,
    frame_ms_avg: f32,
}

#[derive(Copy, Clone)]
struct ActivePerfDrop {
    start_s: f32,
    samples: u32,
    fps_sum: f32,
    fps_min: f32,
    fps_max: f32,
    frame_ms_sum: f32,
    frame_ms_min: f32,
    frame_ms_max: f32,
}

impl ActivePerfDrop {
    fn new(start_s: f32, fps: f32, frame_ms: f32) -> Self {
        Self {
            start_s,
            samples: 1,
            fps_sum: fps,
            fps_min: fps,
            fps_max: fps,
            frame_ms_sum: frame_ms,
            frame_ms_min: frame_ms,
            frame_ms_max: frame_ms,
        }
    }

    fn push(&mut self, fps: f32, frame_ms: f32) {
        self.samples = self.samples.saturating_add(1);
        self.fps_sum += fps;
        self.fps_min = self.fps_min.min(fps);
        self.fps_max = self.fps_max.max(fps);
        self.frame_ms_sum += frame_ms;
        self.frame_ms_min = self.frame_ms_min.min(frame_ms);
        self.frame_ms_max = self.frame_ms_max.max(frame_ms);
    }

    fn snapshot(&self, end_s: f32) -> PerfDropSnapshot {
        let samples_f = (self.samples as f32).max(1.0);
        PerfDropSnapshot {
            start_s: self.start_s,
            end_s,
            duration_s: (end_s - self.start_s).max(0.0),
            samples: self.samples,
            fps_min: self.fps_min,
            fps_max: self.fps_max,
            fps_avg: self.fps_sum / samples_f,
            frame_ms_min: self.frame_ms_min,
            frame_ms_max: self.frame_ms_max,
            frame_ms_avg: self.frame_ms_sum / samples_f,
        }
    }
}

#[derive(Default)]
struct PerfSnapshotState {
    samples: VecDeque<PerfSample>,
    active_drop: Option<ActivePerfDrop>,
    last_drop: Option<PerfDropSnapshot>,
    drop_end_times: VecDeque<f32>,
    recover_frames: u8,
    last_frame_count: u64,
    drops_total: u32,
}

fn compute_window_stats(
    samples: &VecDeque<PerfSample>,
    now_s: f32,
    window_s: f32,
) -> PerfWindowStats {
    let mut count = 0u32;
    let mut fps_sum = 0.0f32;
    let mut frame_sum = 0.0f32;
    let mut fps_min = f32::MAX;
    let mut fps_max = f32::MIN;
    let mut frame_min = f32::MAX;
    let mut frame_max = f32::MIN;

    for sample in samples.iter().rev() {
        if now_s - sample.t_s > window_s {
            break;
        }
        count = count.saturating_add(1);
        fps_sum += sample.fps;
        frame_sum += sample.frame_ms;
        fps_min = fps_min.min(sample.fps);
        fps_max = fps_max.max(sample.fps);
        frame_min = frame_min.min(sample.frame_ms);
        frame_max = frame_max.max(sample.frame_ms);
    }

    if count == 0 {
        return PerfWindowStats::default();
    }
    let n = count as f32;
    PerfWindowStats {
        samples: count,
        fps_min,
        fps_max,
        fps_avg: fps_sum / n,
        frame_ms_min: frame_min,
        frame_ms_max: frame_max,
        frame_ms_avg: frame_sum / n,
    }
}

/// Update the debug snapshot from live resources for MCP inspection.
#[allow(clippy::too_many_arguments)]
fn update_debug_snapshot(
    time: Res<Time<Real>>,
    state: Res<State<AppState>>,
    ui_state: Res<UiState>,
    city: Res<City>,
    map_cfg: Res<MapConfig>,
    hovered: Res<HoveredTile>,
    mcp: Res<McpConnectionStatus>,
    diagnostics: Option<Res<DiagnosticsStore>>,
    traffic: Option<Res<TrafficIndex>>,
    q_cam: Query<(&Transform, &Projection), With<MainCamera>>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugWorldSnapshot>,
    mut perf_state: Local<PerfSnapshotState>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };
    let now_s = time.elapsed_secs();

    set_string(&mut snapshot.app_state, app_state_label(state.get()));
    set_string(&mut snapshot.sim_speed, sim_speed_label(ui_state.sim_speed));
    set_string(&mut snapshot.overlay, overlay_label(ui_state.overlay));

    snapshot.day = city.day;
    snapshot.hour = city.hour;
    snapshot.money = city.money;
    snapshot.population = city.population;
    snapshot.happiness = city.happiness;
    snapshot.last_income = city.last_income;
    snapshot.last_expense = city.last_expense;

    snapshot.map_width = map_cfg.width;
    snapshot.map_height = map_cfg.height;
    snapshot.tile_size = map_cfg.tile_size;

    if let Ok((tf, proj)) = q_cam.single() {
        snapshot.camera_pos = tf.translation.truncate();
        snapshot.camera_zoom = match proj {
            Projection::Orthographic(o) => o.scale,
            _ => 1.0,
        };
    } else {
        snapshot.camera_pos = Vec2::ZERO;
        snapshot.camera_zoom = 1.0;
    }

    if let Some(tile) = hovered.tile {
        snapshot.hovered_tile_valid = true;
        snapshot.hovered_tile_x = tile.x;
        snapshot.hovered_tile_y = tile.y;
    } else {
        snapshot.hovered_tile_valid = false;
        snapshot.hovered_tile_x = 0;
        snapshot.hovered_tile_y = 0;
    }

    if let Some(idx) = traffic.as_deref() {
        snapshot.traffic_road_tiles = idx.road_tiles;
        snapshot.traffic_vehicles_on_roads = idx.vehicles_on_roads;
        snapshot.traffic_avg_congestion = idx.avg_congestion;
        snapshot.traffic_max_congestion = idx.max_congestion;
    } else {
        snapshot.traffic_road_tiles = 0;
        snapshot.traffic_vehicles_on_roads = 0;
        snapshot.traffic_avg_congestion = 0.0;
        snapshot.traffic_max_congestion = 0.0;
    }

    let mut fps = 0.0f32;
    let mut fps_smoothed = 0.0f32;
    let mut frame_time_ms = 0.0f32;
    let mut frame_time_smoothed_ms = 0.0f32;
    let mut frame_count = 0u64;
    if let Some(diags) = diagnostics.as_deref() {
        if let Some(d) = diags.get(&FrameTimeDiagnosticsPlugin::FPS) {
            fps = d.value().unwrap_or(0.0) as f32;
            fps_smoothed = d.smoothed().unwrap_or(fps as f64) as f32;
        }
        if let Some(d) = diags.get(&FrameTimeDiagnosticsPlugin::FRAME_TIME) {
            frame_time_ms = d.value().unwrap_or(0.0) as f32;
            frame_time_smoothed_ms = d.smoothed().unwrap_or(frame_time_ms as f64) as f32;
        }
        if let Some(d) = diags.get(&FrameTimeDiagnosticsPlugin::FRAME_COUNT) {
            frame_count = d.value().unwrap_or(0.0).max(0.0).round() as u64;
        }
    }

    let fps_effective = if fps_smoothed > 0.0 {
        fps_smoothed
    } else {
        fps
    };
    let frame_ms_effective = if frame_time_smoothed_ms > 0.0 {
        frame_time_smoothed_ms
    } else {
        frame_time_ms
    };

    if frame_count > 0
        && frame_count != perf_state.last_frame_count
        && (fps_effective > 0.0 || frame_ms_effective > 0.0)
    {
        perf_state.last_frame_count = frame_count;
        perf_state.samples.push_back(PerfSample {
            t_s: now_s,
            fps: fps_effective,
            frame_ms: frame_ms_effective,
        });

        let is_drop_sample = (fps_effective > 0.0 && fps_effective < PERF_LOW_FPS_THRESHOLD)
            || frame_ms_effective >= PERF_FRAME_SPIKE_THRESHOLD_MS;

        if is_drop_sample {
            perf_state.recover_frames = 0;
            if let Some(active) = perf_state.active_drop.as_mut() {
                active.push(fps_effective, frame_ms_effective);
            } else {
                perf_state.active_drop = Some(ActivePerfDrop::new(
                    now_s,
                    fps_effective,
                    frame_ms_effective,
                ));
                perf_state.drops_total = perf_state.drops_total.saturating_add(1);
            }
        } else if perf_state.active_drop.is_some() {
            perf_state.recover_frames = perf_state.recover_frames.saturating_add(1);
            if perf_state.recover_frames >= PERF_DROP_RECOVER_FRAMES {
                if let Some(active) = perf_state.active_drop.take() {
                    let finished = active.snapshot(now_s);
                    perf_state.last_drop = Some(finished);
                    perf_state.drop_end_times.push_back(now_s);
                }
                perf_state.recover_frames = 0;
            }
        }
    }

    while perf_state
        .samples
        .front()
        .is_some_and(|s| now_s - s.t_s > PERF_HISTORY_WINDOW_S)
    {
        perf_state.samples.pop_front();
    }
    while perf_state
        .drop_end_times
        .front()
        .is_some_and(|t| now_s - *t > PERF_HISTORY_WINDOW_S)
    {
        perf_state.drop_end_times.pop_front();
    }

    let window_1s = compute_window_stats(&perf_state.samples, now_s, PERF_WINDOW_SHORT_S);
    let window_5s = compute_window_stats(&perf_state.samples, now_s, PERF_WINDOW_MEDIUM_S);

    let perf_flag_low_fps = fps_effective > 0.0 && fps_effective < PERF_LOW_FPS_THRESHOLD;
    let perf_flag_critical_fps = fps_effective > 0.0 && fps_effective < PERF_CRITICAL_FPS_THRESHOLD;
    let perf_flag_frame_spike = frame_ms_effective >= PERF_FRAME_SPIKE_THRESHOLD_MS;
    let perf_flag_drop_active = perf_state.active_drop.is_some();

    let active_drop = perf_state
        .active_drop
        .map(|d| d.snapshot(now_s))
        .unwrap_or_default();
    let last_drop = perf_state.last_drop.unwrap_or_default();
    let has_last_drop = perf_state.last_drop.is_some();

    snapshot.fps = fps;
    snapshot.fps_smoothed = fps_smoothed;
    snapshot.frame_time_ms = frame_time_ms;
    snapshot.frame_time_smoothed_ms = frame_time_smoothed_ms;
    snapshot.frame_count = frame_count;
    snapshot.perf_low_fps_threshold = PERF_LOW_FPS_THRESHOLD;
    snapshot.perf_critical_fps_threshold = PERF_CRITICAL_FPS_THRESHOLD;
    snapshot.perf_frame_spike_threshold_ms = PERF_FRAME_SPIKE_THRESHOLD_MS;
    snapshot.perf_flag_low_fps = perf_flag_low_fps;
    snapshot.perf_flag_critical_fps = perf_flag_critical_fps;
    snapshot.perf_flag_frame_spike = perf_flag_frame_spike;
    snapshot.perf_flag_drop_active = perf_flag_drop_active;
    snapshot.perf_drops_total = perf_state.drops_total;
    snapshot.perf_drops_last_60s = perf_state.drop_end_times.len() as u32;
    snapshot.perf_window_1s_samples = window_1s.samples;
    snapshot.perf_window_1s_fps_min = window_1s.fps_min;
    snapshot.perf_window_1s_fps_max = window_1s.fps_max;
    snapshot.perf_window_1s_fps_avg = window_1s.fps_avg;
    snapshot.perf_window_1s_frame_ms_min = window_1s.frame_ms_min;
    snapshot.perf_window_1s_frame_ms_max = window_1s.frame_ms_max;
    snapshot.perf_window_1s_frame_ms_avg = window_1s.frame_ms_avg;
    snapshot.perf_window_5s_samples = window_5s.samples;
    snapshot.perf_window_5s_fps_min = window_5s.fps_min;
    snapshot.perf_window_5s_fps_max = window_5s.fps_max;
    snapshot.perf_window_5s_fps_avg = window_5s.fps_avg;
    snapshot.perf_window_5s_frame_ms_min = window_5s.frame_ms_min;
    snapshot.perf_window_5s_frame_ms_max = window_5s.frame_ms_max;
    snapshot.perf_window_5s_frame_ms_avg = window_5s.frame_ms_avg;
    snapshot.perf_active_drop_start_s = active_drop.start_s;
    snapshot.perf_active_drop_duration_s = active_drop.duration_s;
    snapshot.perf_active_drop_samples = active_drop.samples;
    snapshot.perf_active_drop_fps_min = active_drop.fps_min;
    snapshot.perf_active_drop_fps_max = active_drop.fps_max;
    snapshot.perf_active_drop_fps_avg = active_drop.fps_avg;
    snapshot.perf_active_drop_frame_ms_min = active_drop.frame_ms_min;
    snapshot.perf_active_drop_frame_ms_max = active_drop.frame_ms_max;
    snapshot.perf_active_drop_frame_ms_avg = active_drop.frame_ms_avg;
    snapshot.perf_last_drop_valid = has_last_drop;
    snapshot.perf_last_drop_start_s = last_drop.start_s;
    snapshot.perf_last_drop_end_s = last_drop.end_s;
    snapshot.perf_last_drop_duration_s = last_drop.duration_s;
    snapshot.perf_last_drop_samples = last_drop.samples;
    snapshot.perf_last_drop_fps_min = last_drop.fps_min;
    snapshot.perf_last_drop_fps_max = last_drop.fps_max;
    snapshot.perf_last_drop_fps_avg = last_drop.fps_avg;
    snapshot.perf_last_drop_frame_ms_min = last_drop.frame_ms_min;
    snapshot.perf_last_drop_frame_ms_max = last_drop.frame_ms_max;
    snapshot.perf_last_drop_frame_ms_avg = last_drop.frame_ms_avg;

    snapshot.mcp_remote_enabled = mcp.remote_enabled;
    snapshot.mcp_pending_requests = mcp.pending_requests;
    snapshot.mcp_last_request_age_s = mcp.last_request_at_s.map(|t| (now_s - t).max(0.0));

    snapshot.mcp_is_active = snapshot
        .mcp_last_request_age_s
        .is_some_and(|age| age <= MCP_ACTIVE_WINDOW_S);
    snapshot.mcp_is_idle = snapshot
        .mcp_last_request_age_s
        .is_some_and(|age| age >= MCP_IDLE_WINDOW_S);
}

/// Update traffic metrics debug snapshot.
fn update_debug_traffic_snapshot(
    traffic: Option<Res<TrafficIndex>>,
    occupancy: Option<Res<TrafficOccupancy>>,
    counts: Option<Res<TrafficVehicleCounts>>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugTrafficSnapshot>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    if let Some(c) = counts.as_deref() {
        snapshot.active_vehicles = c.active;
        snapshot.total_vehicles = c.total();
        snapshot.parked_vehicles = c.parked();
    } else {
        snapshot.active_vehicles = 0;
        snapshot.total_vehicles = 0;
        snapshot.parked_vehicles = 0;
    }

    if let Some(idx) = traffic.as_deref() {
        snapshot.road_tiles = idx.road_tiles;
        snapshot.vehicles_on_roads = idx.vehicles_on_roads;
        snapshot.avg_congestion = idx.avg_congestion;
        snapshot.max_congestion = idx.max_congestion;
        if let Some(tile) = idx.max_congestion_tile {
            snapshot.max_congestion_tile_valid = true;
            snapshot.max_congestion_tile_x = tile.x;
            snapshot.max_congestion_tile_y = tile.y;
        } else {
            snapshot.max_congestion_tile_valid = false;
            snapshot.max_congestion_tile_x = 0;
            snapshot.max_congestion_tile_y = 0;
        }
        snapshot.max_congestion_tile_vehicles = idx.max_congestion_tile_vehicles;
        snapshot.max_congestion_tile_capacity = idx.max_congestion_tile_capacity;
    } else {
        snapshot.road_tiles = 0;
        snapshot.vehicles_on_roads = 0;
        snapshot.avg_congestion = 0.0;
        snapshot.max_congestion = 0.0;
        snapshot.max_congestion_tile_valid = false;
        snapshot.max_congestion_tile_x = 0;
        snapshot.max_congestion_tile_y = 0;
        snapshot.max_congestion_tile_vehicles = 0;
        snapshot.max_congestion_tile_capacity = 0;
    }

    if let Some(occ) = occupancy.as_deref() {
        snapshot.occupancy_max_heat = occ.max_heat();
        let mut nonzero = 0u32;
        let mut max_vehicles = 0u16;
        for &v in occ.per_tick_vehicles.iter() {
            if v > 0 {
                nonzero += 1;
                if v > max_vehicles {
                    max_vehicles = v;
                }
            }
        }
        snapshot.occupancy_nonzero_tiles = nonzero;
        snapshot.occupancy_max_vehicles = max_vehicles;
    } else {
        snapshot.occupancy_max_heat = 0.0;
        snapshot.occupancy_nonzero_tiles = 0;
        snapshot.occupancy_max_vehicles = 0;
    }
}

/// Update intersection metrics debug snapshot.
fn update_debug_intersection_snapshot(
    intersections: Option<Res<IntersectionIndex>>,
    reservations: Option<Res<IntersectionReservations>>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugIntersectionSnapshot>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    if let Some(idx) = intersections.as_deref() {
        snapshot.intersection_count = idx.clusters.len() as u32;
        snapshot.intersection_tiles = idx.clusters.iter().map(|c| c.tiles.len() as u32).sum();
        snapshot.traffic_light_count = idx.traffic_lights.len() as u32;
    } else {
        snapshot.intersection_count = 0;
        snapshot.intersection_tiles = 0;
        snapshot.traffic_light_count = 0;
    }

    snapshot.reservation_intersection_count = 0;
    snapshot.reservation_total = 0;
    snapshot.reservation_approaching = 0;
    snapshot.reservation_inside = 0;
    snapshot.reservation_straight = 0;
    snapshot.reservation_right = 0;
    snapshot.reservation_left = 0;
    snapshot.reservation_other = 0;

    if let Some(res) = reservations.as_deref() {
        for rs in res.by_intersection.values() {
            if rs.is_empty() {
                continue;
            }
            snapshot.reservation_intersection_count += 1;
            for r in rs.iter() {
                snapshot.reservation_total += 1;
                match r.state {
                    ReservationState::Approaching => snapshot.reservation_approaching += 1,
                    ReservationState::Inside => snapshot.reservation_inside += 1,
                }
                match r.maneuver {
                    ManeuverKind::Straight => snapshot.reservation_straight += 1,
                    ManeuverKind::RightTurn => snapshot.reservation_right += 1,
                    ManeuverKind::LeftTurn => snapshot.reservation_left += 1,
                    ManeuverKind::Other => snapshot.reservation_other += 1,
                }
            }
        }
    }
}

/// Update transport/pathfinding metrics debug snapshot.
#[allow(clippy::too_many_arguments)]
fn update_debug_transport_snapshot(
    graph_version: Res<GraphVersion>,
    road_graph: Option<Res<RoadGraph>>,
    lane_graph: Option<Res<LaneGraph>>,
    regions: Option<Res<RegionGraph>>,
    path_pool: Option<Res<PathPool>>,
    path_cache: Option<Res<PathCache>>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugTransportSnapshot>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    snapshot.graph_version = graph_version.0;

    if let Some(graph) = road_graph.as_deref() {
        snapshot.road_graph_version = graph.version;
        snapshot.road_graph_edges = graph.edges.len() as u32;
        snapshot.road_graph_road_tiles = graph.road_indices.len() as u32;
    } else {
        snapshot.road_graph_version = 0;
        snapshot.road_graph_edges = 0;
        snapshot.road_graph_road_tiles = 0;
    }

    if let Some(graph) = lane_graph.as_deref() {
        snapshot.lane_graph_version = graph.version;
        snapshot.lane_count = graph.lanes.len() as u32;
        snapshot.lane_connections = graph.connections.len() as u32;
    } else {
        snapshot.lane_graph_version = 0;
        snapshot.lane_count = 0;
        snapshot.lane_connections = 0;
    }

    if let Some(graph) = regions.as_deref() {
        snapshot.region_graph_version = graph.version;
        snapshot.region_size = graph.region_size as u32;
        snapshot.region_count = (graph.regions_w * graph.regions_h) as u32;
        snapshot.region_edges = graph.edges.len() as u32;
    } else {
        snapshot.region_graph_version = 0;
        snapshot.region_size = 0;
        snapshot.region_count = 0;
        snapshot.region_edges = 0;
    }

    if let Some(pool) = path_pool.as_deref() {
        let stats = pool.stats();
        snapshot.path_pool_entries_total = stats.total_entries as u32;
        snapshot.path_pool_entries_used = stats.used_entries as u32;
        snapshot.path_pool_entries_free = stats.free_entries as u32;
        snapshot.path_pool_dedup_entries = stats.dedup_entries as u32;
        snapshot.path_pool_memory_bytes = stats.total_memory_bytes as u64;
        snapshot.path_pool_version = stats.current_version;
    } else {
        snapshot.path_pool_entries_total = 0;
        snapshot.path_pool_entries_used = 0;
        snapshot.path_pool_entries_free = 0;
        snapshot.path_pool_dedup_entries = 0;
        snapshot.path_pool_memory_bytes = 0;
        snapshot.path_pool_version = 0;
    }

    if let Some(cache) = path_cache.as_deref() {
        let stats = cache.stats();
        snapshot.path_cache_entries = stats.entries as u32;
        snapshot.path_cache_lru_len = stats.lru_len as u32;
        snapshot.path_cache_version = stats.version;
    } else {
        snapshot.path_cache_entries = 0;
        snapshot.path_cache_lru_len = 0;
        snapshot.path_cache_version = 0;
    }
}

/// Update citizen metrics debug snapshot.
fn update_debug_citizens_snapshot(
    commute: Res<CommuteStats>,
    shopping: Res<ShoppingDemandStats>,
    q_citizens: Query<&Citizen>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugCitizensSnapshot>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    let mut total = 0u32;
    let mut at_home = 0u32;
    let mut to_work = 0u32;
    let mut at_work = 0u32;
    let mut to_shop = 0u32;
    let mut at_shop = 0u32;
    let mut to_home = 0u32;

    for c in q_citizens.iter() {
        total += 1;
        match c.state {
            CitizenState::AtHome => at_home += 1,
            CitizenState::ToWork => to_work += 1,
            CitizenState::AtWork => at_work += 1,
            CitizenState::ToShop => to_shop += 1,
            CitizenState::AtShop => at_shop += 1,
            CitizenState::ToHome => to_home += 1,
        }
    }

    snapshot.citizens_total = total;
    snapshot.citizens_at_home = at_home;
    snapshot.citizens_to_work = to_work;
    snapshot.citizens_at_work = at_work;
    snapshot.citizens_to_shop = to_shop;
    snapshot.citizens_at_shop = at_shop;
    snapshot.citizens_to_home = to_home;
    snapshot.commute_avg_secs = commute.avg_commute_secs;
    snapshot.commute_samples = commute.samples;
    snapshot.shopping_demand_events = shopping.demand_events;
    snapshot.shopping_unmet_events = shopping.unmet_events;
    snapshot.shopping_unmet_ratio = shopping.unmet_ratio;
}

/// Update employment metrics debug snapshot.
fn update_debug_employment_snapshot(
    stats: Res<EmploymentStats>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugEmploymentSnapshot>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    snapshot.employed = stats.employed as u32;
    snapshot.unemployed = stats.unemployed as u32;
    snapshot.employed_commercial = stats.employed_commercial as u32;
    snapshot.employed_industrial = stats.employed_industrial as u32;
    snapshot.employment_rate = stats.employment_rate;
    snapshot.pathfind_attempts_last_tick = stats.pathfind_attempts_last_tick;
    snapshot.pathfind_failures_last_tick = stats.pathfind_failures_last_tick;
    snapshot.skipped_failed_pairs_last_tick = stats.skipped_failed_pairs_last_tick;
    snapshot.unreachable_cache_lookups_last_tick = stats.unreachable_cache_lookups_last_tick;
    snapshot.skipped_unreachable_cache_last_tick = stats.skipped_unreachable_cache_last_tick;
    snapshot.unreachable_cache_inserts_last_tick = stats.unreachable_cache_inserts_last_tick;
    snapshot.unreachable_cache_entries = stats.unreachable_cache_entries;
    snapshot.unreachable_cache_ttl_evictions_last_tick =
        stats.unreachable_cache_ttl_evictions_last_tick;
    snapshot.unreachable_cache_capacity_evictions_last_tick =
        stats.unreachable_cache_capacity_evictions_last_tick;
    snapshot.unreachable_cache_graph_cleared_last_tick =
        stats.unreachable_cache_graph_cleared_last_tick;
    snapshot.unassigned_scanned_last_tick = stats.unassigned_scanned_last_tick;
    snapshot.budget_hit_last_tick = stats.budget_hit_last_tick;
}

/// Update building metrics debug snapshot.
fn update_debug_buildings_snapshot(
    q_buildings: Query<&Building>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugBuildingsSnapshot>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    let mut total = 0u32;
    let mut residential = 0u32;
    let mut commercial = 0u32;
    let mut industrial = 0u32;
    let mut service = 0u32;
    let mut operational = 0u32;
    let mut under_construction = 0u32;
    let mut residents_capacity = 0u32;
    let mut residents_occupancy = 0u32;
    let mut jobs_capacity = 0u32;
    let mut jobs_occupancy = 0u32;
    let mut residents_target = 0u32;
    let mut jobs_target = 0u32;

    for b in q_buildings.iter() {
        total += 1;
        match b.kind {
            BuildingKind::Residential => residential += 1,
            BuildingKind::Commercial => commercial += 1,
            BuildingKind::Industrial => industrial += 1,
            BuildingKind::FireStation | BuildingKind::PoliceStation | BuildingKind::Hospital => {
                service += 1
            }
        }

        match b.phase {
            BuildingPhase::Operational => operational += 1,
            BuildingPhase::UnderConstruction { .. } => under_construction += 1,
        }

        residents_capacity = residents_capacity.saturating_add(b.capacity_residents as u32);
        residents_occupancy = residents_occupancy.saturating_add(b.occupancy_residents as u32);
        jobs_capacity = jobs_capacity.saturating_add(b.capacity_jobs as u32);
        jobs_occupancy = jobs_occupancy.saturating_add(b.occupancy_jobs as u32);
        residents_target = residents_target.saturating_add(b.target_occupancy_residents as u32);
        jobs_target = jobs_target.saturating_add(b.target_occupancy_jobs as u32);
    }

    snapshot.buildings_total = total;
    snapshot.buildings_residential = residential;
    snapshot.buildings_commercial = commercial;
    snapshot.buildings_industrial = industrial;
    snapshot.buildings_service = service;
    snapshot.buildings_operational = operational;
    snapshot.buildings_under_construction = under_construction;
    snapshot.residents_capacity = residents_capacity;
    snapshot.residents_occupancy = residents_occupancy;
    snapshot.jobs_capacity = jobs_capacity;
    snapshot.jobs_occupancy = jobs_occupancy;
    snapshot.residents_target = residents_target;
    snapshot.jobs_target = jobs_target;
}

/// Update pedestrian metrics debug snapshot.
fn update_debug_pedestrians_snapshot(
    q_pedestrians: Query<&Pedestrian>,
    q_blocked: Query<&Pedestrian, With<BlockedAtUncontrolled>>,
    q_crossing: Query<(), With<PedestrianCrossing>>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugPedestriansSnapshot>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    let total = q_pedestrians.iter().count() as u32;
    let mut blocked = 0u32;
    let mut wait_sum = 0.0f32;
    let mut wait_max = 0.0f32;
    for p in q_blocked.iter() {
        blocked += 1;
        wait_sum += p.wait_blocked_hours;
        if p.wait_blocked_hours > wait_max {
            wait_max = p.wait_blocked_hours;
        }
    }

    snapshot.pedestrians_total = total;
    snapshot.pedestrians_blocked = blocked;
    snapshot.pedestrians_crossing = q_crossing.iter().count() as u32;
    snapshot.blocked_wait_avg_hours = if blocked > 0 {
        wait_sum / (blocked as f32)
    } else {
        0.0
    };
    snapshot.blocked_wait_max_hours = wait_max;
}

/// Update services metrics debug snapshot.
fn update_debug_services_snapshot(
    coverage: Option<Res<ServiceCoverageIndex>>,
    q_stations: Query<&ServiceStation>,
    q_vehicles: Query<&ServiceVehicle>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugServicesSnapshot>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    let mut stations_fire = 0u32;
    let mut stations_police = 0u32;
    let mut stations_medical = 0u32;
    for s in q_stations.iter() {
        match s.kind {
            ServiceKind::Fire => stations_fire += 1,
            ServiceKind::Police => stations_police += 1,
            ServiceKind::Medical => stations_medical += 1,
        }
    }

    let mut vehicles_total = 0u32;
    let mut vehicles_fire = 0u32;
    let mut vehicles_police = 0u32;
    let mut vehicles_medical = 0u32;
    for v in q_vehicles.iter() {
        vehicles_total += 1;
        match v.kind {
            ServiceKind::Fire => vehicles_fire += 1,
            ServiceKind::Police => vehicles_police += 1,
            ServiceKind::Medical => vehicles_medical += 1,
        }
    }

    snapshot.stations_fire = stations_fire;
    snapshot.stations_police = stations_police;
    snapshot.stations_medical = stations_medical;
    snapshot.vehicles_total = vehicles_total;
    snapshot.vehicles_fire = vehicles_fire;
    snapshot.vehicles_police = vehicles_police;
    snapshot.vehicles_medical = vehicles_medical;

    if let Some(c) = coverage.as_deref() {
        snapshot.coverage_fire = c.fire;
        snapshot.coverage_police = c.police;
        snapshot.coverage_medical = c.medical;
        snapshot.coverage_overall = c.overall();
        snapshot.coverage_buildings_total = c.buildings_total;
    } else {
        snapshot.coverage_fire = 0.0;
        snapshot.coverage_police = 0.0;
        snapshot.coverage_medical = 0.0;
        snapshot.coverage_overall = 0.0;
        snapshot.coverage_buildings_total = 0;
    }
}

/// Update emergency metrics debug snapshot.
fn update_debug_emergencies_snapshot(
    manager: Option<Res<EmergencyManager>>,
    q_emergencies: Query<&Emergency>,
    q_markers: Query<(), With<EmergencyMarker>>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugEmergenciesSnapshot>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    let mut total = 0u32;
    let mut fire = 0u32;
    let mut crime = 0u32;
    let mut medical = 0u32;
    let mut unresponded = 0u32;
    for e in q_emergencies.iter() {
        total += 1;
        if !e.responded {
            unresponded += 1;
        }
        match e.kind {
            EmergencyKind::Fire => fire += 1,
            EmergencyKind::Crime => crime += 1,
            EmergencyKind::Medical => medical += 1,
        }
    }

    snapshot.emergencies_active = total;
    snapshot.emergencies_fire = fire;
    snapshot.emergencies_crime = crime;
    snapshot.emergencies_medical = medical;
    snapshot.emergencies_unresponded = unresponded;
    snapshot.emergency_markers_active = q_markers.iter().count() as u32;

    if let Some(m) = manager.as_deref() {
        snapshot.hours_since_last_spawn = m.hours_since_last_spawn;
        snapshot.max_active_emergencies = m.max_active_emergencies as u32;
        snapshot.stats_total_fires = m.stats.total_fires;
        snapshot.stats_total_crimes = m.stats.total_crimes;
        snapshot.stats_total_medical = m.stats.total_medical;
        snapshot.stats_unresponded_fires = m.stats.unresponded_fires;
        snapshot.stats_unresponded_crime = m.stats.unresponded_crime;
        snapshot.stats_unresponded_medical = m.stats.unresponded_medical;
        snapshot.stats_total_resolved = m.stats.total_resolved;
        snapshot.stats_resolved_in_time = m.stats.resolved_in_time;
        snapshot.stats_failed_responses = m.stats.failed_responses;
    } else {
        snapshot.hours_since_last_spawn = 0;
        snapshot.max_active_emergencies = 0;
        snapshot.stats_total_fires = 0;
        snapshot.stats_total_crimes = 0;
        snapshot.stats_total_medical = 0;
        snapshot.stats_unresponded_fires = 0;
        snapshot.stats_unresponded_crime = 0;
        snapshot.stats_unresponded_medical = 0;
        snapshot.stats_total_resolved = 0;
        snapshot.stats_resolved_in_time = 0;
        snapshot.stats_failed_responses = 0;
    }
}

/// Update trip event counters debug snapshot.
fn update_debug_trips_snapshot(
    mut requested: MessageReader<TripRequested>,
    mut finished: MessageReader<TripFinished>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugTripsSnapshot>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    snapshot.requested_total = 0;
    snapshot.requested_walk = 0;
    snapshot.requested_car = 0;
    for msg in requested.read() {
        snapshot.requested_total += 1;
        match msg.mode {
            TripMode::Walk => snapshot.requested_walk += 1,
            TripMode::Car => snapshot.requested_car += 1,
        }
    }

    snapshot.finished_total = 0;
    snapshot.finished_work = 0;
    snapshot.finished_shop = 0;
    snapshot.finished_return_home = 0;
    for msg in finished.read() {
        snapshot.finished_total += 1;
        match msg.purpose {
            TripPurpose::Work => snapshot.finished_work += 1,
            TripPurpose::Shop => snapshot.finished_shop += 1,
            TripPurpose::ReturnHome => snapshot.finished_return_home += 1,
        }
    }
}

/// Cached map tile counts for debug snapshot.
#[derive(Default, Copy, Clone)]
struct MapCounts {
    tiles_total: u32,
    tiles_water: u32,
    tiles_road: u32,
    tiles_zone_residential: u32,
    tiles_zone_commercial: u32,
    tiles_zone_industrial: u32,
    tiles_building: u32,
    tiles_building_service: u32,
}

/// Cached map stats keyed by edit version.
#[derive(Default)]
struct MapDebugCache {
    version: u64,
    counts: MapCounts,
}

/// Update map tile counts debug snapshot.
fn update_debug_map_snapshot(
    grid: Res<MapGrid>,
    edit_v: Res<MapEditVersion>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugMapSnapshot>,
    mut cache: Local<MapDebugCache>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    if cache.version != edit_v.0 {
        cache.counts = compute_map_counts(&grid);
        cache.version = edit_v.0;
    }

    snapshot.map_edit_version = edit_v.0;
    snapshot.tiles_total = cache.counts.tiles_total;
    snapshot.tiles_water = cache.counts.tiles_water;
    snapshot.tiles_road = cache.counts.tiles_road;
    snapshot.tiles_zone_residential = cache.counts.tiles_zone_residential;
    snapshot.tiles_zone_commercial = cache.counts.tiles_zone_commercial;
    snapshot.tiles_zone_industrial = cache.counts.tiles_zone_industrial;
    snapshot.tiles_building = cache.counts.tiles_building;
    snapshot.tiles_building_service = cache.counts.tiles_building_service;
}

/// Compute map tile counts for debug snapshot.
fn compute_map_counts(grid: &MapGrid) -> MapCounts {
    let mut counts = MapCounts {
        tiles_total: grid.len() as u32,
        ..Default::default()
    };

    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else {
                continue;
            };
            if cell.water {
                counts.tiles_water += 1;
            }
            if cell.road.is_some() {
                counts.tiles_road += 1;
            }
            match cell.zone {
                ZoneKind::Residential => counts.tiles_zone_residential += 1,
                ZoneKind::Commercial => counts.tiles_zone_commercial += 1,
                ZoneKind::Industrial => counts.tiles_zone_industrial += 1,
                ZoneKind::None => {}
            }
            if let Some(kind) = cell.building {
                counts.tiles_building += 1;
                if matches!(
                    kind,
                    BuildingKind::FireStation
                        | BuildingKind::PoliceStation
                        | BuildingKind::Hospital
                ) {
                    counts.tiles_building_service += 1;
                }
            }
        }
    }

    counts
}

/// Update land value and pollution debug snapshot.
fn update_debug_environment_snapshot(
    land_value: Option<Res<LandValueIndex>>,
    pollution: Option<Res<PollutionIndex>>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugEnvironmentSnapshot>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    if let Some(lv) = land_value.as_deref() {
        let (min, max, avg) = stats_from_f32_slice(&lv.values);
        snapshot.land_value_min = min;
        snapshot.land_value_max = max;
        snapshot.land_value_avg = avg;
    } else {
        snapshot.land_value_min = 0.0;
        snapshot.land_value_max = 0.0;
        snapshot.land_value_avg = 0.0;
    }

    if let Some(p) = pollution.as_deref() {
        let (min, max, avg) = stats_from_f32_slice(&p.pollution);
        snapshot.pollution_min = min;
        snapshot.pollution_max = max;
        snapshot.pollution_avg = avg;
    } else {
        snapshot.pollution_min = 0.0;
        snapshot.pollution_max = 0.0;
        snapshot.pollution_avg = 0.0;
    }
}

/// Compute min/max/avg stats from a normalized slice.
fn stats_from_f32_slice(values: &[f32]) -> (f32, f32, f32) {
    if values.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    let mut min = f32::MAX;
    let mut max = f32::MIN;
    let mut sum = 0.0f32;
    for &v in values.iter() {
        let v = v.clamp(0.0, 1.0);
        if v < min {
            min = v;
        }
        if v > max {
            max = v;
        }
        sum += v;
    }
    let avg = sum / (values.len() as f32);
    (min, max, avg)
}

/// Update RCI demand debug snapshot.
fn update_debug_demand_snapshot(
    demand: Option<Res<RciDemand>>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugDemandSnapshot>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    if let Some(d) = demand.as_deref() {
        snapshot.demand_residential = d.residential;
        snapshot.demand_commercial = d.commercial;
        snapshot.demand_industrial = d.industrial;
    } else {
        snapshot.demand_residential = 0.0;
        snapshot.demand_commercial = 0.0;
        snapshot.demand_industrial = 0.0;
    }
}

/// Update config values debug snapshot.
#[allow(clippy::too_many_arguments)]
fn update_debug_config_snapshot(
    traffic_cfg: Res<TrafficConfig>,
    path_cfg: Res<PathfindingConfig>,
    economy_cfg: Res<EconomyConfig>,
    employment_cfg: Res<EmploymentConfig>,
    ped_cfg: Res<PedestrianConfig>,
    building_tuning: Res<BuildingTuning>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugConfigSnapshot>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    snapshot.traffic_max_active_vehicles = traffic_cfg.max_active_vehicles as u32;
    snapshot.traffic_max_route_plans_per_tick = traffic_cfg.max_route_plans_per_tick as u32;
    snapshot.traffic_heat_ema_decay = traffic_cfg.heat_ema_decay;
    snapshot.traffic_drive_on_right = traffic_cfg.drive_on_right;
    snapshot.traffic_tile_meters = traffic_cfg.tile_meters();
    snapshot.traffic_idm_desired_headway_secs = traffic_cfg.idm_desired_headway_secs;
    snapshot.traffic_idm_min_gap_m = traffic_cfg.idm_min_gap_m;
    snapshot.traffic_idm_max_accel_mps2 = traffic_cfg.idm_max_accel_mps2;
    snapshot.traffic_idm_comfortable_decel_mps2 = traffic_cfg.idm_comfortable_decel_mps2;
    snapshot.traffic_idm_max_decel_mps2 = traffic_cfg.idm_max_decel_mps2;
    snapshot.traffic_idm_delta = traffic_cfg.idm_delta;

    snapshot.path_cache_capacity = path_cfg.cache_capacity as u32;
    snapshot.path_cache_ttl_secs = path_cfg.cache_ttl_secs;
    snapshot.path_congestion_k = path_cfg.congestion_k;
    snapshot.path_congestion_max = path_cfg.congestion_max;
    snapshot.path_lane_change_penalty = path_cfg.lane_change_penalty;
    snapshot.path_turn_penalty = path_cfg.turn_penalty;
    snapshot.path_cost_scale = path_cfg.cost_scale;
    snapshot.path_enable_hierarchical = path_cfg.enable_hierarchical;
    snapshot.path_region_size = path_cfg.region_size as u32;
    snapshot.path_region_pad = path_cfg.region_pad;

    snapshot.economy_tax_per_citizen = economy_cfg.tax_per_citizen;
    snapshot.economy_income_per_commercial = economy_cfg.income_per_commercial;
    snapshot.economy_income_per_industrial = economy_cfg.income_per_industrial;
    snapshot.economy_road_maintenance = economy_cfg.road_maintenance;
    snapshot.economy_building_maintenance = economy_cfg.building_maintenance;
    snapshot.economy_happiness_target = economy_cfg.happiness_target;

    snapshot.employment_max_assignments_per_tick = employment_cfg.max_assignments_per_tick as u32;
    snapshot.employment_max_candidates_per_citizen =
        employment_cfg.max_candidates_per_citizen as u32;
    snapshot.employment_max_pathfind_attempts_per_tick =
        employment_cfg.max_pathfind_attempts_per_tick as u32;
    snapshot.employment_max_unassigned_scans_per_tick =
        employment_cfg.max_unassigned_scans_per_tick as u32;
    snapshot.employment_unreachable_pair_cache_enabled =
        employment_cfg.unreachable_pair_cache_enabled;
    snapshot.employment_unreachable_pair_cache_capacity =
        employment_cfg.unreachable_pair_cache_capacity as u32;
    snapshot.employment_unreachable_pair_cache_ttl_ticks =
        employment_cfg.unreachable_pair_cache_ttl_ticks;

    snapshot.pedestrian_walk_speed_kmh = ped_cfg.walk_speed_kmh;
    snapshot.pedestrian_walk_tour_max_m = ped_cfg.walk_tour_max_m;
    snapshot.pedestrian_max_active_walkers = ped_cfg.max_active_walkers as u32;
    snapshot.pedestrian_max_walkers_spawn_per_tick = ped_cfg.max_walkers_spawn_per_tick as u32;
    snapshot.pedestrian_wait_reroute_hours = ped_cfg.wait_reroute_hours;
    snapshot.pedestrian_wait_reroute_max_attempts = ped_cfg.wait_reroute_max_attempts;
    snapshot.pedestrian_uncontrolled_safety_margin_secs = ped_cfg.uncontrolled_safety_margin_secs;
    snapshot.pedestrian_uncontrolled_min_gap_tiles = ped_cfg.uncontrolled_min_gap_tiles;

    snapshot.building_growth_period_secs = building_tuning.growth_period_secs;
}

/// Lanelet graph observability mirror for BRP/MCP inspection.
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugLaneletState {
    pub built_version: u64,
    pub lanelet_count: u32,
    pub intersection_count: u32,
    pub max_lanelets_per_intersection: u32,
    pub max_conflicts_per_lanelet: u32,
    /// Phase-2: number of approach lanes that feed at least one lanelet (the `by_entry_lane` index).
    pub entry_lane_index_size: u32,
}

/// Update lanelet graph debug mirror.
fn update_debug_lanelet_state(
    graph: Option<Res<LaneletGraph>>,
    matrices: Option<Res<LaneletConflictMatrices>>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugLaneletState>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    if let Some(g) = graph.as_deref() {
        snapshot.built_version = g.version;
        snapshot.lanelet_count = g.lanelets.len() as u32;
        snapshot.intersection_count = g.by_intersection.len() as u32;
        snapshot.max_lanelets_per_intersection = g
            .by_intersection
            .values()
            .map(|v| v.len() as u32)
            .max()
            .unwrap_or(0);
        snapshot.entry_lane_index_size = g.by_entry_lane.len() as u32;
    } else {
        snapshot.built_version = 0;
        snapshot.lanelet_count = 0;
        snapshot.intersection_count = 0;
        snapshot.max_lanelets_per_intersection = 0;
        snapshot.entry_lane_index_size = 0;
    }

    snapshot.max_conflicts_per_lanelet = matrices
        .as_deref()
        .map(|m| {
            m.by_intersection
                .values()
                .flat_map(|mat| {
                    (0..mat.len()).map(|i| mat.row(i).iter().map(|w| w.count_ones()).sum::<u32>())
                })
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0);
}

/// Lanelet intersection arbiter observability mirror for BRP/MCP inspection (flat scalars; all zero
/// when the experimental flag is off — the arbiter never runs).
#[derive(Component, Reflect, Default, Copy, Clone)]
#[reflect(Component)]
pub struct DebugArbiterLedgerState {
    /// Reservations the arbiter granted this tick.
    pub admitted_this_tick: u32,
    /// Fresh candidates the arbiter refused this tick.
    pub refused_this_tick: u32,
    /// Max held conflict points across all per-intersection ledgers.
    pub held_points_max: u32,
    /// Total reserved exit slots across all exit tiles.
    pub reserved_exit_slots: u32,
    /// Largest age of any currently-approaching reservation (ms).
    pub max_approaching_age_ms: u32,
    /// 1 if any cluster's stall tripwire fired (must stay 0 flag-on; the arbiter never increments it).
    pub stall_tripwire_fired: u32,
    /// Pedestrian crosswalk activations seeded this tick (P3b).
    pub ped_blocked: u32,
    /// Right-turn-on-red grants this tick (P3b).
    pub rtor_grants: u32,
    /// ПДД-yield refusals (signalized red / not ready) this tick (P3b).
    pub yield_refusals: u32,
    /// Traffic lights in a protected-left interval (P3b).
    pub left_protected_active: u32,
    /// Reserved for the P3c ring-free force-admit counter; always 0 in P3a/P3b.
    pub ring_force_admits: u32,
}

/// Update the arbiter ledger debug mirror from the per-tick `ArbiterTickStats`.
fn update_debug_arbiter_ledger_state(
    stats: Option<Res<ArbiterTickStats>>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugArbiterLedgerState>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    if let Some(s) = stats.as_deref() {
        snapshot.admitted_this_tick = s.admitted;
        snapshot.refused_this_tick = s.refused;
        snapshot.held_points_max = s.held_points_max;
        snapshot.reserved_exit_slots = s.reserved_exit_slots;
        snapshot.max_approaching_age_ms = s.max_approaching_age_ms;
        snapshot.stall_tripwire_fired = s.stall_tripwire_fired;
        snapshot.ped_blocked = s.ped_blocked;
        snapshot.rtor_grants = s.rtor_grants;
        snapshot.yield_refusals = s.yield_refusals;
        snapshot.left_protected_active = s.left_protected_active;
    } else {
        *snapshot = DebugArbiterLedgerState::default();
    }
    // P3c liveness counter not yet wired.
    snapshot.ring_force_admits = 0;
}

fn set_string(target: &mut String, value: &str) {
    target.clear();
    target.push_str(value);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::intersections::IntersectionId;
    use crate::game::traffic::ManeuverKind;
    use crate::game::transport::LaneId;
    use crate::game::transport::lanelet::graph::Lanelet;
    use crate::game::transport::{
        ConflictMatrix, LaneletConflictMatrices, LaneletGraph, LaneletId,
    };

    fn make_lanelet(id: u32, intersection: IntersectionId, entry: u32, exit: u32) -> Lanelet {
        Lanelet {
            id: LaneletId(id),
            intersection,
            entry_lane: LaneId(entry),
            exit_lane: LaneId(exit),
            maneuver: ManeuverKind::Straight,
            internal_path: vec![],
        }
    }

    #[test]
    fn update_lanelet_state_reflects_graph_and_matrix() {
        use bevy::prelude::*;

        let mut app = App::new();

        let iid = IntersectionId(0);
        let mut graph = LaneletGraph::default();
        graph.version = 7;
        graph.lanelets = vec![make_lanelet(0, iid, 0, 1), make_lanelet(1, iid, 2, 3)];
        graph
            .by_intersection
            .insert(iid, vec![LaneletId(0), LaneletId(1)]);
        graph.by_entry_lane.insert(LaneId(0), vec![LaneletId(0)]);
        graph.by_entry_lane.insert(LaneId(2), vec![LaneletId(1)]);

        let p0 = vec![
            crate::game::map::TilePos { x: 0, y: 0 },
            crate::game::map::TilePos { x: 1, y: 0 },
        ];
        let p1 = vec![
            crate::game::map::TilePos { x: 0, y: 0 },
            crate::game::map::TilePos { x: 0, y: 1 },
        ];
        let mat = ConflictMatrix::from_paths(&[p0, p1]);
        let mut matrices = LaneletConflictMatrices::default();
        matrices.by_intersection.insert(iid, mat);

        app.insert_resource(graph);
        app.insert_resource(matrices);

        let entity = app.world_mut().spawn(DebugLaneletState::default()).id();
        app.insert_resource(DebugSnapshotEntity {
            entity: Some(entity),
        });

        app.add_systems(Update, update_debug_lanelet_state);
        app.update();

        let state = app.world().get::<DebugLaneletState>(entity).unwrap();
        assert_eq!(state.built_version, 7);
        assert_eq!(state.lanelet_count, 2);
        assert_eq!(state.intersection_count, 1);
        assert_eq!(state.max_lanelets_per_intersection, 2);
        assert_eq!(state.max_conflicts_per_lanelet, 1);
        assert_eq!(state.entry_lane_index_size, 2);
    }

    #[test]
    fn arbiter_ledger_mirror_reflects_tick_stats() {
        let mut app = App::new();
        app.insert_resource(ArbiterTickStats {
            admitted: 4,
            refused: 1,
            held_points_max: 3,
            reserved_exit_slots: 2,
            max_approaching_age_ms: 250,
            stall_tripwire_fired: 0,
            ped_blocked: 2,
            rtor_grants: 1,
            yield_refusals: 3,
            left_protected_active: 1,
        });
        let entity = app
            .world_mut()
            .spawn(DebugArbiterLedgerState::default())
            .id();
        app.insert_resource(DebugSnapshotEntity {
            entity: Some(entity),
        });
        app.add_systems(Update, update_debug_arbiter_ledger_state);
        app.update();

        let state = app.world().get::<DebugArbiterLedgerState>(entity).unwrap();
        assert_eq!(state.admitted_this_tick, 4);
        assert_eq!(state.refused_this_tick, 1);
        assert_eq!(state.held_points_max, 3);
        assert_eq!(state.reserved_exit_slots, 2);
        assert_eq!(state.max_approaching_age_ms, 250);
        assert_eq!(
            state.stall_tripwire_fired, 0,
            "tripwire must stay 0 (arbiter never increments stall_ticks)"
        );
        assert_eq!(state.ped_blocked, 2);
        assert_eq!(state.rtor_grants, 1);
        assert_eq!(state.yield_refusals, 3);
        assert_eq!(state.left_protected_active, 1);
        assert_eq!(state.ring_force_admits, 0);
    }
}

fn app_state_label(state: &AppState) -> &'static str {
    match state {
        AppState::MainMenu => "MainMenu",
        AppState::InGame => "InGame",
        AppState::Paused => "Paused",
    }
}

fn sim_speed_label(speed: SimSpeed) -> &'static str {
    match speed {
        SimSpeed::Paused => "Paused",
        SimSpeed::X1 => "X1",
        SimSpeed::X2 => "X2",
        SimSpeed::X3 => "X3",
    }
}

fn overlay_label(overlay: OverlayMode) -> &'static str {
    match overlay {
        OverlayMode::None => "None",
        OverlayMode::Water => "Water",
        OverlayMode::Height => "Height",
        OverlayMode::Zones => "Zones",
        OverlayMode::Roads => "Roads",
        OverlayMode::Traffic => "Traffic",
        OverlayMode::Path => "Path",
        OverlayMode::ServiceCoverage => "ServiceCoverage",
        OverlayMode::LandValue => "LandValue",
        OverlayMode::Pollution => "Pollution",
    }
}
