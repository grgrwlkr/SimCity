use bevy::prelude::*;

use crate::game::ids::CitizenId;

use super::{CarOwner, Parked, Vehicle, VehicleMotionTimer};

/// A vehicle stopped for this long (sim seconds, continuously) is counted "frozen" — past the 60 s
/// stuck-reroute, so a non-zero `frozen_count` means jam recovery is failing to unstick it.
const VEHICLE_FROZEN_SECS: f32 = 30.0;
/// World-units/sec below which a vehicle is "stopped" for motion tracking.
const VEHICLE_MOTION_SPEED_EPS: f32 = 0.05;

/// Aggregate motion telemetry (debug): the worst continuous stopped/moving streaks + how many
/// vehicles are frozen. Drives gridlock detection in the Vehicle Debug panel + BRP mirror.
#[derive(Resource, Debug, Default, Clone, Copy)]
pub struct VehicleMotionStats {
    pub max_stopped_secs: f32,
    pub max_moving_secs: f32,
    pub frozen_count: u32,
    /// Tile of the most-stopped vehicle (for locating the jam), or (-1,-1) if none.
    pub worst_tile_x: i32,
    pub worst_tile_y: i32,
}

/// Insert a `VehicleMotionTimer` on every vehicle that lacks one.
pub(super) fn init_vehicle_motion_timers(
    mut commands: Commands,
    q: Query<Entity, (With<Vehicle>, Without<VehicleMotionTimer>)>,
) {
    for e in q.iter() {
        commands.entity(e).insert(VehicleMotionTimer::default());
    }
}

/// Update each vehicle's continuous moving/stopped streak from its speed, and aggregate the worst
/// streaks + frozen count into `VehicleMotionStats`.
pub(super) fn track_vehicle_motion(
    time: Res<Time<Fixed>>,
    path_pool: Res<crate::game::transport::PathPool>,
    mut stats: ResMut<VehicleMotionStats>,
    mut q: Query<(&Vehicle, &mut VehicleMotionTimer), Without<Parked>>,
) {
    let dt = time.delta_secs();
    let mut max_stopped = 0.0f32;
    let mut max_moving = 0.0f32;
    let mut frozen = 0u32;
    let mut worst = (-1i32, -1i32);
    for (v, mut mt) in q.iter_mut() {
        // A vehicle with no active route (idle service vehicle at its station, arrived car
        // awaiting cleanup) is not traffic — its motionlessness is by design, not a jam. Counting
        // the idle fleet made `frozen_vehicles`/`max_stopped_secs` useless as gridlock signals.
        if path_pool.len(v.path_handle) <= 1 {
            mt.stopped_secs = 0.0;
            mt.moving_secs = 0.0;
            continue;
        }
        if v.speed.abs() > VEHICLE_MOTION_SPEED_EPS {
            mt.moving_secs += dt;
            mt.stopped_secs = 0.0;
        } else {
            mt.stopped_secs += dt;
            mt.moving_secs = 0.0;
        }
        if mt.stopped_secs > max_stopped {
            max_stopped = mt.stopped_secs;
            worst = (v.tile_pos.x, v.tile_pos.y);
        }
        max_moving = max_moving.max(mt.moving_secs);
        if mt.stopped_secs >= VEHICLE_FROZEN_SECS {
            frozen += 1;
        }
    }
    stats.max_stopped_secs = max_stopped;
    stats.max_moving_secs = max_moving;
    stats.frozen_count = frozen;
    stats.worst_tile_x = worst.0;
    stats.worst_tile_y = worst.1;
}

/// O(1) lookup for persistent citizen-owned cars (CarTour Variant B).
///
/// Read model: "which car entity belongs to this citizen".
#[derive(Resource, Default)]
pub(super) struct CarOwnerIndex {
    pub(super) by_citizen: std::collections::HashMap<CitizenId, Entity>,
    pub(super) by_entity: std::collections::HashMap<Entity, CitizenId>,
}

impl CarOwnerIndex {
    pub(super) fn clear(&mut self) {
        self.by_citizen.clear();
        self.by_entity.clear();
    }
}

/// Counts of vehicle entities maintained incrementally (no full-world scans).
#[derive(Resource, Debug, Default)]
pub struct TrafficVehicleCounts {
    /// Vehicles without `Parked`.
    pub active: u32,
    /// Per-vehicle parked flag, so despawns can decrement the right counter without queries.
    pub parked_flag: std::collections::HashMap<Entity, bool>,
}

impl TrafficVehicleCounts {
    /// Total vehicles tracked (active + parked).
    pub fn total(&self) -> u32 {
        self.parked_flag.len() as u32
    }

    /// Vehicles currently parked.
    pub fn parked(&self) -> u32 {
        self.total().saturating_sub(self.active)
    }
}

pub(super) fn track_car_owner_index(
    mut idx: ResMut<CarOwnerIndex>,
    q_added: Query<(Entity, &CarOwner), Added<CarOwner>>,
    mut removed: RemovedComponents<CarOwner>,
) {
    for (e, owner) in q_added.iter() {
        idx.by_entity.insert(e, owner.citizen);
        idx.by_citizen.insert(owner.citizen, e);
    }
    for e in removed.read() {
        let Some(cid) = idx.by_entity.remove(&e) else {
            continue;
        };
        if idx.by_citizen.get(&cid).copied() == Some(e) {
            idx.by_citizen.remove(&cid);
        }
    }
}

pub(super) fn track_vehicle_counts(
    mut counts: ResMut<TrafficVehicleCounts>,
    q_added_vehicle: Query<Entity, Added<Vehicle>>,
    q_added_parked: Query<Entity, Added<Parked>>,
    mut removed_vehicle: RemovedComponents<Vehicle>,
    mut removed_parked: RemovedComponents<Parked>,
) {
    // New vehicles start as active (not parked) unless they also get `Parked` this tick.
    for e in q_added_vehicle.iter() {
        counts.active = counts.active.saturating_add(1);
        counts.parked_flag.insert(e, false);
    }

    // Parked added: active--.
    for e in q_added_parked.iter() {
        if let Some(flag) = counts.parked_flag.get_mut(&e)
            && !*flag
        {
            *flag = true;
            counts.active = counts.active.saturating_sub(1);
        }
    }

    // If a vehicle despawned, drop its flag and decrement active only if it wasn't parked.
    let removed_vehicles: Vec<Entity> = removed_vehicle.read().collect();
    for e in removed_vehicles.iter() {
        let Some(was_parked) = counts.parked_flag.remove(e) else {
            continue;
        };
        if !was_parked {
            counts.active = counts.active.saturating_sub(1);
        }
    }

    // Parked removed (unparked): active++ (unless the vehicle was despawned in the same tick).
    for e in removed_parked.read() {
        if removed_vehicles.contains(&e) {
            continue;
        }
        if let Some(flag) = counts.parked_flag.get_mut(&e)
            && *flag
        {
            *flag = false;
            counts.active = counts.active.saturating_add(1);
        }
    }
}
