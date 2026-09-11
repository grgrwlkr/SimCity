//! Lightweight runtime telemetry snapshots used by UI / debug dumps.
//!
//! Design goal: avoid full-world scans in UI systems (especially at high entity counts).

use bevy::prelude::*;

/// Aggregated vehicle counters (debug/telemetry).
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct VehicleAgg {
    pub total: u32,
    pub parked: u32,
    pub no_route: u32,
    pub zero_speed: u32,

    pub free_flow: u32,
    pub approaching: u32,
    pub stopped: u32,
    pub waiting: u32,
    pub crossing: u32,
    pub accelerating: u32,

    /// Active buses (public transport vehicles).
    pub buses: u32,

    pub service_at_station: u32,
    pub service_en_route: u32,
    pub service_on_scene: u32,
    pub service_returning: u32,
    pub service_returning_no_route: u32,
    pub service_returning_parked: u32,
    pub service_returning_zero_speed: u32,
}

impl VehicleAgg {
    pub fn add_from(&mut self, other: &VehicleAgg) {
        self.total = self.total.saturating_add(other.total);
        self.parked = self.parked.saturating_add(other.parked);
        self.no_route = self.no_route.saturating_add(other.no_route);
        self.zero_speed = self.zero_speed.saturating_add(other.zero_speed);

        self.free_flow = self.free_flow.saturating_add(other.free_flow);
        self.approaching = self.approaching.saturating_add(other.approaching);
        self.stopped = self.stopped.saturating_add(other.stopped);
        self.waiting = self.waiting.saturating_add(other.waiting);
        self.crossing = self.crossing.saturating_add(other.crossing);
        self.accelerating = self.accelerating.saturating_add(other.accelerating);

        self.buses = self.buses.saturating_add(other.buses);

        self.service_at_station = self
            .service_at_station
            .saturating_add(other.service_at_station);
        self.service_en_route = self.service_en_route.saturating_add(other.service_en_route);
        self.service_on_scene = self.service_on_scene.saturating_add(other.service_on_scene);
        self.service_returning = self
            .service_returning
            .saturating_add(other.service_returning);
        self.service_returning_no_route = self
            .service_returning_no_route
            .saturating_add(other.service_returning_no_route);
        self.service_returning_parked = self
            .service_returning_parked
            .saturating_add(other.service_returning_parked);
        self.service_returning_zero_speed = self
            .service_returning_zero_speed
            .saturating_add(other.service_returning_zero_speed);
    }
}

/// Snapshot split by agent class to avoid extra scans.
///
/// `active` is built in traffic FixedUpdate while iterating non-parked vehicles.
/// `parked` is built in traffic Update while positioning parked vehicles.
#[derive(Resource, Debug, Default, Clone, serde::Serialize)]
pub struct VehicleAggSnapshot {
    pub active: VehicleAgg,
    pub parked: VehicleAgg,
}

impl VehicleAggSnapshot {
    pub fn combined(&self) -> VehicleAgg {
        let mut out = VehicleAgg::default();
        out.add_from(&self.active);
        out.add_from(&self.parked);
        out
    }
}

// ---------------------------------------------------------------------------
// Tick-cost + traffic-health log (live "frozen cars / collapsed FPS" forensics)
// ---------------------------------------------------------------------------

/// How often (in SIM seconds) the one-line traffic-health summary is written.
const TRAFFIC_HEALTH_PERIOD_SECS: f32 = 5.0;

/// Wall-clock timing of the FixedUpdate tick. `sim_tick_timing_start` runs before everything in
/// the schedule, `sim_tick_health_log` after everything: their difference is the true tick cost
/// regardless of what the individual systems do. Exists because the live "cars frozen + FPS
/// collapsed" report could not be attributed (background throttling vs sim spiral) without
/// per-tick cost and churn counters in the log.
#[derive(Resource, Default)]
pub struct SimTickTiming {
    start: Option<std::time::Instant>,
    last_cost_ms: f32,
    window_secs: f32,
}

/// First thing in FixedUpdate: remember the wall clock.
pub fn sim_tick_timing_start(mut timing: ResMut<SimTickTiming>) {
    timing.start = Some(std::time::Instant::now());
}

/// Last thing in FixedUpdate: close the cost measurement and every
/// `TRAFFIC_HEALTH_PERIOD_SECS` emit one compact health line: tick cost, wedged-stopped census,
/// and the cumulative route-producer + arbiter counters (deltas are readable from consecutive
/// lines). A tick cost persistently above the 100 ms budget or a frozen census that never drains
/// pins the problem to the sim; a low tick cost next to a low FPS pins it outside (rendering /
/// OS present throttling).
#[allow(clippy::type_complexity)]
pub fn sim_tick_health_log(
    mut timing: ResMut<SimTickTiming>,
    time: Res<bevy::time::Time<bevy::time::Fixed>>,
    producer: Option<Res<crate::game::traffic::RouteProducerStats>>,
    arbiter: Option<Res<crate::game::traffic::ArbiterTickStats>>,
    q: Query<(
        &crate::game::traffic::Vehicle,
        Option<&crate::game::traffic::VehicleMotionTimer>,
        Option<&crate::game::traffic::Parked>,
    )>,
) {
    if let Some(start) = timing.start.take() {
        timing.last_cost_ms = start.elapsed().as_secs_f32() * 1000.0;
    }
    timing.window_secs += time.delta_secs();
    if timing.window_secs < TRAFFIC_HEALTH_PERIOD_SECS {
        return;
    }
    timing.window_secs = 0.0;

    // Census over active (non-parked) vehicles: how many are wedged past a light cycle, and how
    // bad is the worst one. Parked vehicles are excluded (they legitimately never move).
    let mut wedged_over_30s = 0u32;
    let mut max_stopped_secs = 0.0f32;
    for (_, motion, parked) in q.iter() {
        if parked.is_some() {
            continue;
        }
        let stopped = motion.map(|m| m.stopped_secs).unwrap_or(0.0);
        if stopped > 30.0 {
            wedged_over_30s += 1;
        }
        max_stopped_secs = max_stopped_secs.max(stopped);
    }

    let Some(producer) = producer else {
        return;
    };
    let arbiter = arbiter.as_deref().cloned().unwrap_or_default();
    info!(
        "traffic-health: tick_cost_ms={:.1} active={} wedged>30s={} max_stopped_secs={:.0} \
         routes[spawn_ll,spawn_fb,stuck_ll,stuck_fb,guard,lc,swap]={},{},{},{},{},{},{} \
         arbiter[cand,adm,ref,coarse,drop_unres,drop_stale,miss_light]={},{},{},{},{},{},{}",
        timing.last_cost_ms,
        q.iter().filter(|(_, _, p)| p.is_none()).count(),
        wedged_over_30s,
        max_stopped_secs,
        producer.spawn_lanelet,
        producer.spawn_road_fallback,
        producer.stuck_lanelet,
        producer.stuck_road_fallback,
        producer.guard_refusals,
        producer.lane_change_handbuilt,
        producer.swap_break_handbuilt,
        arbiter.cand_approaching,
        arbiter.admitted,
        arbiter.refused,
        arbiter.coarse_admits,
        arbiter.drop_unresolved_lanelet,
        arbiter.drop_stale_lanelet,
        arbiter.missing_light_treated_unsignalized,
    );
}
