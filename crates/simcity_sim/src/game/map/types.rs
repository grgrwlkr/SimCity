use bevy::prelude::*;

pub use simcity_core::game::map::{BuildingKind, MapConfig, TileKind, TilePos, ZoneKind};

/// Cursor hover read model for UI/inspector.
#[derive(Resource, Debug, Default, Copy, Clone)]
pub struct HoveredTile {
    pub tile: Option<TilePos>,
}

#[derive(Resource, Debug, Clone)]
pub struct BuildMode {
    pub selected: BuildTool,
}

impl Default for BuildMode {
    fn default() -> Self {
        Self {
            selected: BuildTool::Road(crate::game::roads::RoadKind::TwoLane),
        }
    }
}

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum BuildTool {
    Road(crate::game::roads::RoadKind),
    Zone(ZoneKind),
    PlaceBuilding(BuildingKind),
    TrafficLight,
    Erase,
    Inspect,
}
