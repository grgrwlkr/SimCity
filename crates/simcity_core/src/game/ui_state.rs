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

/// A tile the live debug API has put the cursor on, standing in for the pointer.
///
/// Automation drives the game from inside it: it has no pointer, and moving the real one is
/// off-limits. When set, the hovered tile is this tile instead of the one under the window's
/// cursor. Stays `None` in a player's build — only the dev-only `simcity/input` writes it.
#[derive(Resource, Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PointerOverride {
    pub tile: Option<crate::game::map::TilePos>,
}

/// Whether the pointer is over the player's game interface this frame.
///
/// Written by the game interface from the picking hover map, read by map editing: a click on a
/// panel must not also paint the tile beneath it. Kept apart from [`InputFocus`] on purpose —
/// the developer UI writes that one whole every frame and would erase this half.
#[derive(Resource, Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PointerOverGameUi {
    pub captured: bool,
}

/// Marks the root of a piece of the player's game interface (not the developer panels).
///
/// A contract with the live debug API: `simcity/capture` with `"ui": true` retargets exactly these
/// roots onto its offscreen camera for the frames it captures, so the game interface can be judged
/// without a window on screen. Put it on roots only — a marked child would be retargeted apart
/// from its parent.
#[derive(Component, Debug, Default, Clone, Copy)]
pub struct GameUiRoot;

/// Stable identity of the map-seed text field, shared by the toolbar that draws it and by
/// in-game automation that focuses it. A widget id derived from layout would change with any
/// edit to the toolbar and silently point automation at nothing.
pub const SEED_FIELD_ID: &str = "simcity.seed_field";

/// Whether a UI widget currently owns keyboard input.
///
/// Written once per frame by the UI layer at the head of `GameSet::Input`, read by every
/// keyboard consumer. A resource rather than a run condition on purpose: a condition would
/// have to reach into the UI toolkit, which no test can drive, and the writer changes when
/// the player-facing UI moves off egui while the consumers stay untouched.
///
/// Without it, typing into any text field also drives the game: letters pan the camera,
/// digits swap the active tool and space toggles pause. The pointer half was already
/// guarded; this is the keyboard half.
#[derive(Resource, Debug, Default, Clone, Copy, Eq, PartialEq)]
pub struct InputFocus {
    /// A widget is accepting text or otherwise consuming key presses this frame.
    pub keyboard_captured: bool,
}

impl InputFocus {
    /// True when a keyboard shortcut may act on the world this frame.
    pub fn hotkeys_allowed(self) -> bool {
        !self.keyboard_captured
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
    PowerPlant,
    WaterPump,
    Landfill,
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
    Power,
    WaterSupply,
    Garbage,
}

impl OverlayMode {
    /// A data map a player reads: every overlay but the plain map and the developer path view.
    /// While one is on, the effects that get in the way of reading it stand aside.
    pub fn is_data_map(self) -> bool {
        !matches!(self, OverlayMode::None | OverlayMode::Path)
    }

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
            "power" => Some(Self::Power),
            "watersupply" => Some(Self::WaterSupply),
            "garbage" => Some(Self::Garbage),
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
