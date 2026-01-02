use bevy::prelude::*;

use crate::game::ids::CitizenId;

use super::{CarOwner, Parked, Vehicle};

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
pub(super) struct TrafficVehicleCounts {
    /// Vehicles without `Parked`.
    pub(super) active: u32,
    /// Per-vehicle parked flag, so despawns can decrement the right counter without queries.
    pub(super) parked_flag: std::collections::HashMap<Entity, bool>,
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
