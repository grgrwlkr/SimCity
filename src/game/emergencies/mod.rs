//! Emergency system: spawning, dispatching, resolving, and rendering.
//!
//! This module handles random emergency events, service vehicle dispatch,
//! emergency resolution, and visual markers on the map.

pub mod components;
pub mod systems;
pub mod utils;

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
            .add_systems(
                FixedUpdate,
                (
                    systems::spawn_emergencies,
                    systems::dispatch_emergency_vehicles,
                    systems::update_emergency_timers,
                    systems::resolve_emergencies,
                    systems::apply_emergency_consequences,
                    systems::cleanup_resolved_emergencies,
                )
                    .chain()
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            )
            // Maintain cheap tile->emergency lookup for UI (no per-frame scans).
            .add_systems(
                Update,
                systems::track_emergency_index
                    .in_set(GameSet::CommandApply)
                    .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
            );
    }
}
