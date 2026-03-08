use bevy::prelude::*;

mod audio_sfx;
pub mod camera;
pub mod ui;
mod ui_settings;

pub use simcity_core::game::{
    camera as shared_camera, commands, ids, roads, sets, sim_events, state, trips, ui_state,
};
pub use simcity_data::game::{custom_buildings, persistence_contract, scenarios};
pub use simcity_debug::game::{debug_world, mcp_status};
pub use simcity_sim::game::{
    buildings, citizens, command_history, day_night, demand, economy, emergencies, employment,
    intersections, land_value, map, notifications, pedestrians, pollution, public_transport,
    services, sim, telemetry, traffic, transport, zone_placement,
};
pub use ui_settings::UiSettings;

pub struct FrontendPlugin;

impl Plugin for FrontendPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins((
            audio_sfx::AudioSfxPlugin,
            camera::CameraPlugin,
            ui::UiPlugin,
            ui_settings::UiSettingsPlugin,
        ));
    }
}
