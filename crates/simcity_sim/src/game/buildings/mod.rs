//! M4: Zoning -> building growth (primitives).

mod components;
pub mod components_pub {
    pub use super::components::*;
}
mod construction;
mod decay;
mod footprint;
mod growth;
mod occupancy;
mod population;
mod spawn;
mod upgrade;
mod zone_depth;

#[cfg(test)]
mod tests;

pub use components::*;
pub use construction::*;
pub use decay::*;
pub use footprint::*;
pub use growth::*;
pub use occupancy::update_occupancy;
pub use spawn::calculate_parking_spots;
pub use spawn::spawn_building_entity;
pub use upgrade::*;
pub use zone_depth::{MAX_ZONE_DEPTH, is_within_zone_depth};

// Re-export functions that were in the original file
pub use components::{cleanup_buildings, reset_building_upgrade_clock};
pub use decay::despawn_invalid_buildings;
pub use growth::{reset_growth_rng_on_new_map, seed_growth_rng_from_map};

use crate::game::sets::GameSet;
use crate::game::state::AppState;
use bevy::prelude::*;

pub struct BuildingsPlugin;

impl Plugin for BuildingsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<BuildingUpgradeClock>()
            .init_resource::<BuildingGrowthRng>()
            .add_systems(
                OnEnter(AppState::MainMenu),
                (cleanup_buildings, reset_building_upgrade_clock),
            )
            .add_systems(
                OnEnter(AppState::InGame),
                (seed_growth_rng_from_map, reset_building_upgrade_clock),
            )
            .add_systems(
                Update,
                (
                    reset_growth_rng_on_new_map
                        .in_set(GameSet::CommandApply)
                        .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
                    update_construction_progress
                        .in_set(GameSet::Sim)
                        .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
                    update_occupancy
                        .in_set(GameSet::Sim)
                        .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
                    population::update_city_population
                        .after(update_occupancy)
                        .in_set(GameSet::PostSim)
                        .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
                ),
            )
            .add_systems(
                FixedUpdate,
                (
                    grow_buildings,
                    despawn_invalid_buildings.before(building_decay_no_road_access),
                    building_decay_no_road_access,
                    building_decay_low_happiness,
                    building_decay_economic,
                    upgrade_buildings,
                )
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            );
    }
}
