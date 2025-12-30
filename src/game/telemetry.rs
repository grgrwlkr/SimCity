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
