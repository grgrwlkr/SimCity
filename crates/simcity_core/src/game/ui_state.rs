use bevy::prelude::*;

use crate::game::roads::RoadKind;

/// Width of the right sidebar panel in egui points. Shared so layout that must align with the
/// sidebar's left edge (e.g. notifications) cannot silently drift from the panel's actual width.
pub const SIDEBAR_WIDTH_PX: f32 = 200.0;

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
            sim_speed: SimSpeed::X3,
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

impl OverlayMode {
    /// Parse an overlay by the name the toolbar shows, case-insensitively.
    ///
    /// Exists so the overlays can be driven from a script (BRP) instead of only
    /// from a menu: a screenshot proving an overlay still works has to be able
    /// to switch to it without a human clicking.
    pub fn from_name(name: &str) -> Option<Self> {
        match name
            .trim()
            .to_ascii_lowercase()
            .replace([' ', '_', '-'], "")
            .as_str()
        {
            "none" => Some(Self::None),
            "water" => Some(Self::Water),
            "height" => Some(Self::Height),
            "zones" => Some(Self::Zones),
            "roads" => Some(Self::Roads),
            "traffic" => Some(Self::Traffic),
            "path" => Some(Self::Path),
            "service" | "servicecoverage" => Some(Self::ServiceCoverage),
            "landvalue" => Some(Self::LandValue),
            "pollution" => Some(Self::Pollution),
            _ => None,
        }
    }
}

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum SimSpeed {
    Paused,
    X1,
    X2,
    X3,
}

impl SimSpeed {
    /// Parse a speed the way `OverlayMode::from_name` parses an overlay, so a
    /// script can stop the clock without entering `AppState::Paused` — that
    /// path resets the day and hour, which makes every frozen frame night.
    pub fn from_name(name: &str) -> Option<Self> {
        match name
            .trim()
            .to_ascii_lowercase()
            .replace([' ', '_', '-'], "")
            .as_str()
        {
            "paused" | "pause" | "0" => Some(Self::Paused),
            "x1" | "1" => Some(Self::X1),
            "x2" | "2" => Some(Self::X2),
            "x3" | "3" => Some(Self::X3),
            _ => None,
        }
    }

    /// Multiplier relative to x1 speed (drives virtual time scaling).
    pub fn multiplier(self) -> f32 {
        match self {
            SimSpeed::Paused => 0.0,
            SimSpeed::X1 => 1.0,
            SimSpeed::X2 => 2.0, // 1.0 / 0.5
            SimSpeed::X3 => 6.0, // 1.0 / 0.167
        }
    }
}
