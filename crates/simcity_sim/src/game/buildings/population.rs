use bevy::prelude::*;

use crate::game::sim::City;

use super::components::Building;

/// Update city population from building occupancy.
/// Population is the sum of occupancy_residents from all operational buildings.
pub fn update_city_population(mut city: ResMut<City>, q_buildings: Query<&Building>) {
    let total_population: u32 = q_buildings
        .iter()
        .filter(|b| matches!(b.phase, super::components::BuildingPhase::Operational))
        .map(|b| b.occupancy_residents as u32)
        .sum();

    city.population = total_population;
}
