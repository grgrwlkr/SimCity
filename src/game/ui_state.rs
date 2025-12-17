use bevy::prelude::*;

use crate::game::roads::RoadKind;

#[derive(Resource, Debug, Clone)]
pub struct UiState {
    /// Seed input as text so we can edit it easily in egui.
    pub seed_text: String,
    pub tool: ToolMode,
    pub overlay: OverlayMode,
    pub sim_speed: SimSpeed,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            seed_text: "1".to_string(),
            tool: ToolMode::Road(RoadKind::TwoLane),
            overlay: OverlayMode::None,
            sim_speed: SimSpeed::X1,
        }
    }
}

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum ToolMode {
    Road(RoadKind),
    Residential,
    Commercial,
    Industrial,
    Erase,
    Inspect,
}

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum OverlayMode {
    None,
    Water,
    Height,
    Zones,
    Roads,
    Traffic,
    Path,
}

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum SimSpeed {
    Paused,
    X1,
    X2,
    X4,
}

impl SimSpeed {
    pub fn multiplier(self) -> f32 {
        match self {
            SimSpeed::Paused => 0.0,
            SimSpeed::X1 => 1.0,
            SimSpeed::X2 => 2.0,
            SimSpeed::X4 => 4.0,
        }
    }
}
