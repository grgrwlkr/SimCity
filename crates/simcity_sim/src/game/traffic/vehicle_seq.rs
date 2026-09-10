//! A number for every vehicle, in the order vehicles entered the city.
//!
//! Ties between vehicles need a key that is the same on every run of the same city. `Entity` ids
//! are not: Bevy reserves them while systems run in parallel, so which vehicle gets which id
//! depends on thread timing. The sequence number depends only on the simulation.

use bevy::prelude::*;

use super::Vehicle;

/// The last sequence number handed out.
#[derive(Resource, Debug, Default)]
pub struct VehicleSeqGen(pub u64);

/// Number every vehicle that has none yet, in the order they appear in the world.
pub(crate) fn assign_vehicle_seq(
    mut next: ResMut<VehicleSeqGen>,
    mut q: Query<&mut Vehicle, Added<Vehicle>>,
) {
    for mut vehicle in &mut q {
        if vehicle.seq == 0 {
            next.0 += 1;
            vehicle.seq = next.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vehicles_are_numbered_in_the_order_they_arrive_and_keep_their_number() {
        let mut app = App::new();
        app.init_resource::<VehicleSeqGen>()
            .add_systems(Update, assign_vehicle_seq);
        let first = app.world_mut().spawn(Vehicle::default()).id();
        let second = app.world_mut().spawn(Vehicle::default()).id();
        app.update();
        let third = app.world_mut().spawn(Vehicle::default()).id();
        app.update();
        app.update();
        let seq = |app: &App, entity| app.world().get::<Vehicle>(entity).map(|v| v.seq);
        assert_eq!(
            (seq(&app, first), seq(&app, second), seq(&app, third)),
            (Some(1), Some(2), Some(3))
        );
    }
}
