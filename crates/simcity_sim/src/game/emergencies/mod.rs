//! Emergency system: spawning, dispatching, resolving, and rendering.
//!
//! This module handles random emergency events, service vehicle dispatch,
//! emergency resolution, and visual markers on the map.

pub mod components;
pub mod systems;

#[cfg(test)]
mod tests;

pub use components::*;

use crate::game::sets::GameSet;
use crate::game::state::AppState;
use bevy::prelude::*;

/// Plugin for the emergency system.
pub struct EmergenciesPlugin;

impl Plugin for EmergenciesPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<EmergencyManager>()
            .init_resource::<EmergencyEntityIndex>()
            .init_resource::<systems::DispatchStationIndex>()
            .add_systems(
                FixedUpdate,
                (
                    systems::spawn_emergencies,
                    systems::build_dispatch_station_index,
                    systems::dispatch_emergency_vehicles,
                    systems::update_emergency_timers,
                    systems::resolve_emergencies,
                    systems::apply_emergency_consequences,
                    systems::cleanup_resolved_emergencies,
                )
                    .chain()
                    .in_set(crate::game::SimStep::Emergencies)
                    .run_if(in_state(AppState::InGame)),
            )
            // Maintain cheap tile->emergency lookup for UI (no per-frame scans).
            .add_systems(
                Update,
                systems::track_emergency_index
                    .in_set(GameSet::CommandApply)
                    .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
            )
            // Sync visual markers to emergency locations (spawn/despawn/blink).
            .add_systems(
                Update,
                systems::sync_emergency_markers
                    .in_set(GameSet::RenderSync)
                    .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
            )
            .add_systems(OnExit(AppState::InGame), systems::cleanup_emergency_markers);
    }
}
