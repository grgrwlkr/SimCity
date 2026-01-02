use super::*;

#[derive(Resource, Default, Debug, Clone)]
pub(super) struct UiMetrics {
    pub(super) citizens: usize,
    pub(super) vehicles: usize,
    pub(super) buildings: usize,
    pub(super) employed: usize,
    pub(super) unemployed: usize,
    pub(super) employment_rate: f32,
    pub(super) avg_commute_secs: f32,
    pub(super) traffic_avg: f32,
    pub(super) traffic_max: f32,
    pub(super) traffic_max_tile: Option<TilePos>,
    pub(super) traffic_max_tile_vehicles: u16,
    pub(super) traffic_max_tile_capacity: u16,

    pub(super) demand_r: f32,
    pub(super) demand_c: f32,
    pub(super) demand_i: f32,

    pub(super) fire_stations: u32,
    pub(super) police_stations: u32,
    pub(super) medical_stations: u32,
    pub(super) fire_vehicles: (u32, u32),    // available / total
    pub(super) police_vehicles: (u32, u32),  // available / total
    pub(super) medical_vehicles: (u32, u32), // available / total

    pub(super) service_cov_fire: f32,
    pub(super) service_cov_police: f32,
    pub(super) service_cov_medical: f32,

    pub(super) active_emergencies: u32,
    pub(super) emergencies_resolved: u32,
    pub(super) emergencies_failed: u32,
}

/// Cached entity counts used by UI.
///
/// These are updated incrementally via Added/RemovedComponents to avoid full-world scans each frame.
#[derive(Resource, Default, Debug, Clone, Copy)]
pub(super) struct UiEntityCounts {
    pub(super) citizens: usize,
    pub(super) vehicles: usize,
    pub(super) buildings: usize,
    pub(super) emergencies: usize,
}

#[derive(Resource, Debug, Clone)]
pub(super) struct UiHistory {
    pub(super) last_day: u32,
    pub(super) max_len: usize,
    pub(super) samples: Vec<HistorySample>,
}

#[derive(Debug, Copy, Clone)]
pub(super) struct HistorySample {
    pub(super) day: u32,
    pub(super) population: u32,
    pub(super) money: i64,
    pub(super) traffic_avg: f32,
}

impl Default for UiHistory {
    fn default() -> Self {
        Self {
            last_day: 0,
            max_len: 240,
            samples: Vec::new(),
        }
    }
}

/// UI state + settings for building/copying debug dumps.
#[derive(Resource, Debug, Clone)]
pub(super) struct DebugDumpUiState {
    pub(super) open: bool,
    pub(super) enabled: bool,
    pub(super) window_secs: f32,
    pub(super) interval_secs: f32,
    pub(super) max_dump_samples: usize,
    pub(super) include_hovered_tile: bool,
    pub(super) include_daily_history_days: usize,
    pub(super) copy_requested: bool,
    pub(super) save_requested: bool,
    pub(super) clear_requested: bool,
    pub(super) last_copy: Option<DebugDumpCopyInfo>,
}

#[derive(Debug, Copy, Clone, serde::Serialize)]
pub(super) struct DebugDumpCopyInfo {
    pub(super) at_t_real_s: f32,
    pub(super) chars: usize,
    pub(super) samples: usize,
}

impl Default for DebugDumpUiState {
    fn default() -> Self {
        Self {
            open: false,
            enabled: true,
            window_secs: 120.0,
            interval_secs: 1.0,
            max_dump_samples: 600,
            include_hovered_tile: true,
            include_daily_history_days: 30,
            copy_requested: false,
            save_requested: false,
            clear_requested: false,
            last_copy: None,
        }
    }
}

/// Rolling buffer of recent telemetry samples used for debugging/dumps.
#[derive(Resource, Debug, Default)]
pub(super) struct DebugTelemetry {
    pub(super) t_real_s: f32,
    pub(super) last_sample_t_s: f32,
    pub(super) samples: VecDeque<DebugTelemetrySample>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub(super) struct DebugTelemetrySample {
    pub(super) t_real_s: f32,
    pub(super) app_state: String,
    pub(super) sim_speed: String,
    pub(super) day: u32,
    pub(super) time_of_day: Option<f32>, // 0..1
    pub(super) money: i64,
    pub(super) population: u32,
    pub(super) traffic_avg: f32,
    pub(super) traffic_max: f32,
    pub(super) demand_r: f32,
    pub(super) demand_c: f32,
    pub(super) demand_i: f32,
    pub(super) active_emergencies: u32,
    pub(super) vehicles: VehicleAgg,
}

#[derive(SystemParam)]
pub(super) struct UiEntityCountTrackParams<'w, 's> {
    q_added_citizens: Query<'w, 's, (), Added<Citizen>>,
    removed_citizens: RemovedComponents<'w, 's, Citizen>,
    q_added_vehicles: Query<'w, 's, (), Added<Vehicle>>,
    removed_vehicles: RemovedComponents<'w, 's, Vehicle>,
    q_added_buildings: Query<'w, 's, (), Added<Building>>,
    removed_buildings: RemovedComponents<'w, 's, Building>,
    q_added_emergencies: Query<'w, 's, (), Added<Emergency>>,
    removed_emergencies: RemovedComponents<'w, 's, Emergency>,
}

pub(super) fn track_ui_entity_counts(
    state: Res<State<AppState>>,
    mut counts: ResMut<UiEntityCounts>,
    mut p: UiEntityCountTrackParams,
) {
    counts.citizens = counts
        .citizens
        .saturating_add(p.q_added_citizens.iter().count());
    counts.citizens = counts
        .citizens
        .saturating_sub(p.removed_citizens.read().count());

    counts.vehicles = counts
        .vehicles
        .saturating_add(p.q_added_vehicles.iter().count());
    counts.vehicles = counts
        .vehicles
        .saturating_sub(p.removed_vehicles.read().count());

    counts.buildings = counts
        .buildings
        .saturating_add(p.q_added_buildings.iter().count());
    counts.buildings = counts
        .buildings
        .saturating_sub(p.removed_buildings.read().count());

    counts.emergencies = counts
        .emergencies
        .saturating_add(p.q_added_emergencies.iter().count());
    counts.emergencies = counts
        .emergencies
        .saturating_sub(p.removed_emergencies.read().count());

    if !matches!(state.get(), AppState::InGame | AppState::Paused) {
        *counts = UiEntityCounts::default();
    }
}

pub(super) fn update_ui_metrics(mut p: UiMetricsParams) {
    if !matches!(p.state.get(), AppState::InGame | AppState::Paused) {
        p.metrics.citizens = 0;
        p.metrics.vehicles = 0;
        p.metrics.buildings = 0;
        p.metrics.employed = 0;
        p.metrics.unemployed = 0;
        p.metrics.employment_rate = 0.0;
        p.metrics.avg_commute_secs = 0.0;
        p.metrics.traffic_avg = 0.0;
        p.metrics.traffic_max = 0.0;
        p.metrics.traffic_max_tile = None;
        p.metrics.traffic_max_tile_vehicles = 0;
        p.metrics.traffic_max_tile_capacity = 0;

        p.metrics.demand_r = 0.0;
        p.metrics.demand_c = 0.0;
        p.metrics.demand_i = 0.0;

        p.metrics.fire_stations = 0;
        p.metrics.police_stations = 0;
        p.metrics.medical_stations = 0;
        p.metrics.fire_vehicles = (0, 0);
        p.metrics.police_vehicles = (0, 0);
        p.metrics.medical_vehicles = (0, 0);
        p.metrics.service_cov_fire = 0.0;
        p.metrics.service_cov_police = 0.0;
        p.metrics.service_cov_medical = 0.0;
        p.metrics.active_emergencies = 0;
        p.metrics.emergencies_resolved = 0;
        p.metrics.emergencies_failed = 0;
        return;
    }
    p.metrics.citizens = p.counts.citizens;
    p.metrics.vehicles = p.counts.vehicles;
    p.metrics.buildings = p.counts.buildings;
    if let Some(e) = p.employment.as_deref() {
        p.metrics.employed = e.employed;
        p.metrics.unemployed = e.unemployed;
        p.metrics.employment_rate = e.employment_rate;
    } else {
        p.metrics.employed = 0;
        p.metrics.unemployed = 0;
        p.metrics.employment_rate = 0.0;
    }

    if let Some(c) = p.commute.as_deref() {
        p.metrics.avg_commute_secs = c.avg_commute_secs;
    } else {
        p.metrics.avg_commute_secs = 0.0;
    }

    if let Some(t) = p.traffic.as_deref() {
        p.metrics.traffic_avg = t.avg_congestion;
        p.metrics.traffic_max = t.max_congestion;
        p.metrics.traffic_max_tile = t.max_congestion_tile;
        p.metrics.traffic_max_tile_vehicles = t.max_congestion_tile_vehicles;
        p.metrics.traffic_max_tile_capacity = t.max_congestion_tile_capacity;
    } else {
        p.metrics.traffic_avg = 0.0;
        p.metrics.traffic_max = 0.0;
        p.metrics.traffic_max_tile = None;
        p.metrics.traffic_max_tile_vehicles = 0;
        p.metrics.traffic_max_tile_capacity = 0;
    }

    if let Some(d) = p.demand.as_deref() {
        p.metrics.demand_r = d.residential;
        p.metrics.demand_c = d.commercial;
        p.metrics.demand_i = d.industrial;
    } else {
        p.metrics.demand_r = 0.0;
        p.metrics.demand_c = 0.0;
        p.metrics.demand_i = 0.0;
    }

    // Services stats.
    let mut fire_s = 0u32;
    let mut police_s = 0u32;
    let mut medical_s = 0u32;
    let mut fire_av = 0u32;
    let mut fire_total = 0u32;
    let mut police_av = 0u32;
    let mut police_total = 0u32;
    let mut medical_av = 0u32;
    let mut medical_total = 0u32;
    for s in p.q_stations.iter() {
        match s.kind {
            crate::game::services::ServiceKind::Fire => {
                fire_s += 1;
                fire_av += s.available_vehicles as u32;
                fire_total += s.total_vehicles as u32;
            }
            crate::game::services::ServiceKind::Police => {
                police_s += 1;
                police_av += s.available_vehicles as u32;
                police_total += s.total_vehicles as u32;
            }
            crate::game::services::ServiceKind::Medical => {
                medical_s += 1;
                medical_av += s.available_vehicles as u32;
                medical_total += s.total_vehicles as u32;
            }
        }
    }
    p.metrics.fire_stations = fire_s;
    p.metrics.police_stations = police_s;
    p.metrics.medical_stations = medical_s;
    p.metrics.fire_vehicles = (fire_av, fire_total);
    p.metrics.police_vehicles = (police_av, police_total);
    p.metrics.medical_vehicles = (medical_av, medical_total);

    if let Some(c) = p.service_coverage.as_deref() {
        p.metrics.service_cov_fire = c.fire;
        p.metrics.service_cov_police = c.police;
        p.metrics.service_cov_medical = c.medical;
    } else {
        p.metrics.service_cov_fire = 0.0;
        p.metrics.service_cov_police = 0.0;
        p.metrics.service_cov_medical = 0.0;
    }

    p.metrics.active_emergencies = p.counts.emergencies.min(u32::MAX as usize) as u32;
    if let Some(m) = p.emergency_manager.as_deref() {
        p.metrics.emergencies_resolved = m.stats.resolved_in_time;
        p.metrics.emergencies_failed = m.stats.failed_responses;
    } else {
        p.metrics.emergencies_resolved = 0;
        p.metrics.emergencies_failed = 0;
    }
}

#[derive(SystemParam)]
pub(super) struct UiMetricsParams<'w, 's> {
    state: Res<'w, State<AppState>>,
    metrics: ResMut<'w, UiMetrics>,
    counts: Res<'w, UiEntityCounts>,
    employment: Option<Res<'w, EmploymentStats>>,
    traffic: Option<Res<'w, TrafficIndex>>,
    commute: Option<Res<'w, CommuteStats>>,
    demand: Option<Res<'w, RciDemand>>,
    service_coverage: Option<Res<'w, ServiceCoverageIndex>>,
    emergency_manager: Option<Res<'w, EmergencyManager>>,
    q_stations: Query<'w, 's, &'static ServiceStation>,
}
