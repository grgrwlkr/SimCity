use bevy::prelude::*;

use crate::game::map::{BuildingKind, TilePos, ZoneKind};
use crate::game::roads::RoadCell;

/// Commands produced by UI / input and applied by simulation systems.
#[derive(Message, Debug, Clone)]
pub enum GameCommand {
    /// Start a new map (currently: resets the existing tile grid). Generation parameters will be
    /// added in the next milestone.
    GenerateMap { seed: u64 },

    /// Set the tile kind at the given tile position (MVP build/erase).
    SetRoad { pos: TilePos, road: RoadCell },

    /// Paint zoning at the given tile position.
    SetZone { pos: TilePos, zone: ZoneKind },

    /// Place a building directly (used for service buildings).
    PlaceBuilding { pos: TilePos, kind: BuildingKind },

    /// Erase player edits (road + zone + building) on the given tile.
    EraseTile { pos: TilePos },

    /// Debug: build an in-memory save snapshot (contract) and print a short summary to logs.
    DumpSaveContract,

    /// M7: Save to `saves/slot{slot}.ron`.
    SaveGame { slot: u8 },

    /// M7: Load from `saves/slot{slot}.ron`.
    LoadGame { slot: u8 },

    /// Spawn a number of debug vehicles on roads (M3 prototype).
    SpawnDebugVehicles { count: u32 },

    /// Despawn all vehicles (M3 prototype).
    ClearVehicles,

    /// Place a traffic light at an intersection.
    #[allow(dead_code)]
    PlaceTrafficLight { pos: TilePos },

    /// Remove a traffic light from an intersection.
    #[allow(dead_code)]
    RemoveTrafficLight { pos: TilePos },
}
