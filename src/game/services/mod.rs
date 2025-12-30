//! 5.3 Emergency services foundations (stations + service vehicles).
//!
//! This module is split into submodules to keep file sizes small (≤500 LOC) and to make
//! performance-critical parts explicit (coverage recomputation + overlay pooling).

use bevy::prelude::*;

use crate::game::map::MapEditVersion;
use crate::game::sets::GameSet;
use crate::game::state::AppState;

mod components;
mod coverage;
mod overlay;
mod systems;

pub use components::{
    ServiceKind, ServiceStation, ServiceVehicle, ServiceVehicleMarker, ServiceVehicleState,
};
pub use coverage::ServiceCoverageIndex;
pub(crate) use systems::{adjacent_road_any, spawn_service_vehicle};

pub struct ServicesPlugin;

impl Plugin for ServicesPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(
            Update,
            systems::sync_service_stations_from_buildings
                .in_set(GameSet::Sim)
                .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
        )
        .add_systems(
            FixedUpdate,
            systems::park_returned_service_vehicles
                .in_set(GameSet::Sim)
                .run_if(in_state(AppState::InGame)),
        )
        .init_resource::<ServiceCoverageIndex>()
        .init_resource::<overlay::ServiceCoverageOverlayPool>()
        .add_systems(
            FixedUpdate,
            coverage::compute_service_coverage_index
                .in_set(GameSet::PostSim)
                .run_if(in_state(AppState::InGame).and(resource_changed::<MapEditVersion>)),
        )
        .add_systems(
            Update,
            overlay::render_service_coverage_overlay
                .in_set(GameSet::RenderSync)
                .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
        );
    }
}
