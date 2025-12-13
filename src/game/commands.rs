use bevy::prelude::*;

use crate::game::map::{TileKind, TilePos};

/// Commands produced by UI / input and applied by simulation systems.
#[derive(Message, Debug, Clone)]
pub enum GameCommand {
    /// Start a new map (currently: resets the existing tile grid). Generation parameters will be
    /// added in the next milestone.
    GenerateMap { seed: u64 },

    /// Set the tile kind at the given tile position (MVP build/erase).
    SetTile { pos: TilePos, kind: TileKind },

    /// Spawn a number of debug vehicles on roads (M3 prototype).
    SpawnDebugVehicles { count: u32 },

    /// Despawn all vehicles (M3 prototype).
    ClearVehicles,
}
