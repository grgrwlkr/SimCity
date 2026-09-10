use bevy::prelude::*;

pub mod debug_world;
pub mod live;
pub mod mcp_status;

pub use simcity_core::game::{camera, sets, state, trips, ui_state};
pub use simcity_sim::game::{
    buildings, citizens, demand, economy, emergencies, employment, intersections, land_value, map,
    pedestrians, pollution, services, sim, traffic, transport,
};

pub struct DebugPlugin;

impl Plugin for DebugPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins((mcp_status::McpStatusPlugin, debug_world::DebugWorldPlugin));
        // The live BRP API is dev-only for the same reason the rest of the remote stack
        // is: unauthenticated world mutation plus file writes to caller-chosen paths.
        // It needs `RemotePlugin` to already be in the app — `main.rs` adds it first.
        #[cfg(feature = "dev")]
        app.add_plugins(live::LiveDebugPlugin);
    }
}
