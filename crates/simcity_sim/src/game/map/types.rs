use bevy::prelude::*;

pub use simcity_core::game::map::{BuildingKind, MapConfig, TileKind, TilePos, ZoneKind};

/// Cursor hover read model for UI/inspector.
#[derive(Resource, Debug, Default, Copy, Clone)]
pub struct HoveredTile {
    pub tile: Option<TilePos>,
}

// NOTE: the former BuildMode/BuildTool resource pair was collapsed into
// `UiState.tool` (core `ToolMode`) — one enum, no per-frame sync system.
