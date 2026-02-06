use bevy::prelude::*;

use crate::game::roads::RoadKind;

#[derive(Resource, Debug, Clone)]
pub struct UiState {
    /// Seed input as text so we can edit it easily in egui.
    pub seed_text: String,
    pub tool: ToolMode,
    pub overlay: OverlayMode,
    pub sim_speed: SimSpeed,
    /// One-way road mode (when Road tool is selected)
    pub one_way_mode: bool,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            seed_text: "1".to_string(),
            tool: ToolMode::Road(RoadKind::TwoLane),
            overlay: OverlayMode::None,
            sim_speed: SimSpeed::X1,
            one_way_mode: false,
        }
    }
}

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum ToolMode {
    Road(RoadKind),
    Residential,
    Commercial,
    Industrial,
    FireStation,
    PoliceStation,
    Hospital,
    TrafficLight,
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
    ServiceCoverage,
    LandValue,
    Pollution,
}

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum SimSpeed {
    Paused,
    X1,
    X2,
    X3,
}

impl SimSpeed {
    /// Returns the real-time duration (in seconds) for one game hour at this speed.
    /// x1 = 1.0 sec/hour (24s/day), x2 = 0.5 sec/hour (12s/day), x3 = ~0.167 sec/hour (4s/day)
    pub fn secs_per_game_hour(self) -> f32 {
        match self {
            SimSpeed::Paused => 0.0,
            SimSpeed::X1 => 1.0,
            SimSpeed::X2 => 0.5,
            SimSpeed::X3 => 1.0 / 6.0, // ~0.167 => 24h in ~4 real seconds
        }
    }

    /// Multiplier relative to x1 speed (used by systems that scale dt).
    pub fn multiplier(self) -> f32 {
        match self {
            SimSpeed::Paused => 0.0,
            SimSpeed::X1 => 1.0,
            SimSpeed::X2 => 2.0, // 1.0 / 0.5
            SimSpeed::X3 => 6.0, // 1.0 / 0.167
        }
    }
}
