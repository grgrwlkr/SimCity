//! Emergency system: spawning, dispatching, resolving, and rendering.
//!
//! This module handles random emergency events, service vehicle dispatch,
//! emergency resolution, and visual markers on the map.

pub mod components;
pub mod utils;

pub use components::*;

use bevy::prelude::*;

/// Plugin for the emergency system.
pub struct EmergenciesPlugin;

impl Plugin for EmergenciesPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<EmergencyManager>()
            .init_resource::<EmergencyEntityIndex>();
        // TODO: implement emergency systems
    }
}
