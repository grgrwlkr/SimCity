//! Street furniture tuning, loaded from `assets/config/props.ron`.
//!
//! Props are the cheapest way to make a block read as inhabited and the easiest
//! way to wreck the frame: the pseudo-3D migration measured 800 shadow casters
//! taking it from 72 to 22 FPS. Everything here is therefore a density, and
//! every density is a knob rather than a constant in the spawn loop.

use bevy::prelude::*;
use serde::{Deserialize, Serialize};

/// Lamp posts along the kerb, and the wires strung between them.
#[derive(Debug, Copy, Clone, Serialize, Deserialize)]
pub struct StreetlightConfig {
    pub enabled: bool,
    /// One lamp every N eligible kerb tiles along a road run.
    pub spacing_tiles: u32,
    pub pole_height: f32,
    /// How far the lamp arm reaches over the carriageway.
    pub arm_length: f32,
    /// Distance from the tile centre to the kerb line.
    pub kerb_offset: f32,
    /// Wires between consecutive lamps; off when the lamps are off.
    pub wires: bool,
    /// How far a wire dips between two lamps, in world units.
    pub wire_sag: f32,
}

impl Default for StreetlightConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            spacing_tiles: 4,
            pole_height: 9.0,
            arm_length: 2.5,
            kerb_offset: 6.0,
            wires: true,
            wire_sag: 1.4,
        }
    }
}

/// Anything placed by a per-tile dice roll: bins, signs, awnings, parked cars.
#[derive(Debug, Copy, Clone, Serialize, Deserialize)]
pub struct PropChanceConfig {
    pub enabled: bool,
    /// Percent of eligible tiles that get one. The roll is a hash of the tile
    /// and the map seed, so it is the same on every run.
    pub chance_percent: u32,
}

impl Default for PropChanceConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            chance_percent: 25,
        }
    }
}

/// Shop signs — the one prop that is meant to be seen at night.
#[derive(Debug, Copy, Clone, Serialize, Deserialize)]
pub struct SignConfig {
    pub enabled: bool,
    pub chance_percent: u32,
    pub width: f32,
    pub height: f32,
    /// Height above the pavement the sign hangs at.
    pub mount_height: f32,
    /// Emissive strength after dark. Day keeps the sign unlit.
    pub night_emissive: f32,
}

impl Default for SignConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            chance_percent: 45,
            width: 5.0,
            height: 1.8,
            mount_height: 7.0,
            night_emissive: 5.0,
        }
    }
}

/// Root of `assets/config/props.ron`.
#[derive(Resource, Debug, Default, Copy, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PropsConfig {
    pub streetlight: StreetlightConfig,
    pub sign: SignConfig,
    pub bin: PropChanceConfig,
    pub awning: PropChanceConfig,
    pub parked_car: PropChanceConfig,
}
