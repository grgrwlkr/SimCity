//! Persistence contract types: the serialized shapes (`SaveGameV1`..`SaveGameV3` and
//! their snapshot structs) that define "what is saved".
//!
//! Save/Load IO lives in `persistence`; this module only owns the contract types plus
//! the `DumpSaveContract` debug command, which logs a summary of the exact snapshot
//! `SaveGame` would write (built via `persistence::snapshot_savegame`, traffic lights
//! included).

use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::citizens::CitizenState;
use crate::game::commands::GameCommand;
use crate::game::emergencies::EmergencyStats;
use crate::game::ids::CitizenId;
use crate::game::map::{BuildingKind, TileKind, TilePos, ZoneKind};
use crate::game::persistence::{SaveParams, snapshot_savegame};
use crate::game::roads::RoadCell;
use crate::game::services::ServiceKind;
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;

pub struct PersistenceContractPlugin;

impl Plugin for PersistenceContractPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(
            Update,
            dump_save_contract
                .in_set(GameSet::CommandApply)
                .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
        );
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct SaveGameV1 {
    pub save_version: u32,
    pub seed: u64,
    pub map: MapGridV1,
    pub city: City,
    pub citizens: Vec<CitizenSnapshotV1>,
    pub next_citizen_id: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct SaveGameV2 {
    pub save_version: u32, // = 2
    pub seed: u64,
    pub map: MapGridV1,
    pub city: City,
    pub citizens: Vec<CitizenSnapshotV1>,
    pub next_citizen_id: u64,
    pub service_stations: Vec<ServiceStationSnapshot>,
    pub emergency_stats: EmergencyStats,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Copy, Clone)]
pub enum BuildingPhaseSnapshot {
    /// Building is under construction
    UnderConstruction {
        /// Days remaining until completion
        days_remaining: u32,
    },
    /// Building is operational and can have occupancy
    Operational,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct BuildingSnapshot {
    pub kind: BuildingKind,
    /// Anchor position (top-left corner of the footprint)
    pub anchor_pos: TilePos,
    /// Width of the footprint (3-6 tiles)
    pub footprint_width: u8,
    /// Length of the footprint (3-6 tiles)
    pub footprint_length: u8,
    /// Current building level (1-3)
    pub level: u8,
    /// Current construction/operational phase
    pub phase: BuildingPhaseSnapshot,
    /// Day when construction started (for tracking progress)
    pub construction_start_day: u32,
    pub capacity_residents: u16,
    pub capacity_jobs: u16,
    /// Current number of residents (GDD 10.3.5)
    pub occupancy_residents: u16,
    /// Current number of jobs filled (GDD 10.3.5)
    pub occupancy_jobs: u16,
    /// Target number of residents (calculated from demand)
    pub target_occupancy_residents: u16,
    /// Target number of jobs (calculated from demand)
    pub target_occupancy_jobs: u16,
    /// Parking spot positions inside the footprint (GDD 10.3.4)
    pub parking_spots: Vec<TilePos>,
    /// Decay state: road access loss
    pub no_road_access_decay: Option<NoRoadAccessDecaySnapshot>,
    /// Decay state: low happiness
    pub low_happiness_decay: Option<LowHappinessDecaySnapshot>,
    /// Decay state: economic losses
    pub economic_decay: Option<EconomicDecaySnapshot>,
}

/// Snapshot of NoRoadAccessDecay component
#[derive(serde::Serialize, serde::Deserialize, Debug, Copy, Clone)]
pub struct NoRoadAccessDecaySnapshot {
    pub access_lost_day: u32,
}

/// Snapshot of LowHappinessDecay component
#[derive(serde::Serialize, serde::Deserialize, Debug, Copy, Clone)]
pub struct LowHappinessDecaySnapshot {
    pub decay_start_day: u32,
    pub avg_happiness: f32,
}

/// Snapshot of EconomicDecay component
#[derive(serde::Serialize, serde::Deserialize, Debug, Copy, Clone)]
pub struct EconomicDecaySnapshot {
    pub decay_start_day: u32,
    pub cumulative_losses: i64,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct SaveGameV3 {
    pub save_version: u32, // = 3
    pub seed: u64,
    pub map: MapGridV1,
    pub city: City,
    pub buildings: Vec<BuildingSnapshot>,
    pub citizens: Vec<CitizenSnapshotV1>,
    pub next_citizen_id: u64,
    pub service_stations: Vec<ServiceStationSnapshot>,
    pub emergency_stats: EmergencyStats,
    /// User-placed traffic lights: one representative tile per controlled intersection cluster.
    /// Additive field (P0-7); absent in pre-P0-7 saves → defaults to empty vec.
    #[serde(default)]
    pub traffic_light_tiles: Vec<TilePos>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Copy, Clone)]
pub struct ServiceStationSnapshot {
    pub kind: ServiceKind,
    pub pos: TilePos,
    pub total_vehicles: u8,
    pub available_vehicles: u8,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct MapGridV1 {
    pub width: i32,
    pub height: i32,
    pub tiles: Vec<MapTileV1>, // row-major
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Copy, Clone)]
pub struct MapTileV1 {
    pub height: u8,
    pub water: bool,
    pub terrain: TileKind,
    pub road: RoadCell,
    pub zone: ZoneKind,
    pub building: Option<BuildingKind>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct CitizenSnapshotV1 {
    pub id: CitizenId,
    pub home: TilePos,
    pub last_place: TilePos,
    pub state: CitizenState,
    pub workplace: Option<TilePos>,
}

fn dump_save_contract(mut reader: MessageReader<GameCommand>, p: SaveParams) {
    for cmd in reader.read() {
        if !matches!(cmd, GameCommand::DumpSaveContract) {
            continue;
        }
        let save = snapshot_savegame(&p);

        info!(
            "SaveContract v{}: seed={} map={}x{} tiles={} buildings={} citizens={} next_citizen_id={} money={} day={} stations={} traffic_lights={} emergency_stats={:?}",
            save.save_version,
            save.seed,
            save.map.width,
            save.map.height,
            save.map.tiles.len(),
            save.buildings.len(),
            save.citizens.len(),
            save.next_citizen_id,
            save.city.money,
            save.city.day,
            save.service_stations.len(),
            save.traffic_light_tiles.len(),
            save.emergency_stats,
        );
    }
}
