//! Persistence contract types (pre-M7).
//!
//! This module intentionally does NOT implement IO yet. It's a single place to keep the
//! "what is saved" contract stable before implementing M7 Save/Load.

use bevy::ecs::message::MessageReader;
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;

use crate::game::buildings::{Building, BuildingPhase};
use crate::game::citizens::CitizenState;
use crate::game::citizens::{Citizen, CitizenWorkplace};
use crate::game::commands::GameCommand;
use crate::game::emergencies::{EmergencyManager, EmergencyStats};
use crate::game::ids::{CitizenId, CitizenIdComp, CitizenIdGen};
use crate::game::map::{BuildingKind, TileKind, TilePos, ZoneKind};
use crate::game::map::{MapGrid, MapSeed};
use crate::game::roads::RoadCell;
use crate::game::services::ServiceKind;
use crate::game::services::ServiceStation;
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
                .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
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

fn snapshot_savegame_v1(
    seed: &MapSeed,
    grid: &MapGrid,
    city: &City,
    citizens: &Query<(&CitizenIdComp, &Citizen, Option<&CitizenWorkplace>)>,
    id_gen: &CitizenIdGen,
) -> SaveGameV1 {
    let mut tiles = Vec::with_capacity(grid.len());
    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let cell = grid.get(pos).unwrap_or_default();
            tiles.push(MapTileV1 {
                height: cell.height,
                water: cell.water,
                terrain: cell.terrain,
                road: cell.road,
                zone: cell.zone,
                building: cell.building,
            });
        }
    }

    let mut out_citizens = Vec::new();
    for (id, c, wp) in citizens.iter() {
        out_citizens.push(CitizenSnapshotV1 {
            id: id.0,
            home: c.home,
            last_place: c.last_place,
            state: c.state,
            workplace: wp.and_then(|w| w.workplace),
        });
    }

    SaveGameV1 {
        save_version: 1,
        seed: seed.0,
        map: MapGridV1 {
            width: grid.width,
            height: grid.height,
            tiles,
        },
        city: city.clone(),
        citizens: out_citizens,
        next_citizen_id: id_gen.next(),
    }
}

fn snapshot_savegame_v2(
    seed: &MapSeed,
    grid: &MapGrid,
    city: &City,
    citizens: &Query<(&CitizenIdComp, &Citizen, Option<&CitizenWorkplace>)>,
    id_gen: &CitizenIdGen,
    stations: &Query<&ServiceStation>,
    emergency_manager: Option<&EmergencyManager>,
) -> SaveGameV2 {
    let v1 = snapshot_savegame_v1(seed, grid, city, citizens, id_gen);

    let mut out_stations = Vec::new();
    for s in stations.iter() {
        out_stations.push(ServiceStationSnapshot {
            kind: s.kind,
            pos: s.pos,
            total_vehicles: s.total_vehicles,
            available_vehicles: s.available_vehicles,
        });
    }

    SaveGameV2 {
        save_version: 2,
        seed: v1.seed,
        map: v1.map,
        city: v1.city,
        citizens: v1.citizens,
        next_citizen_id: v1.next_citizen_id,
        service_stations: out_stations,
        emergency_stats: emergency_manager
            .map(|m| m.stats.clone())
            .unwrap_or_default(),
    }
}

#[allow(clippy::too_many_arguments)]
fn snapshot_savegame_v3(
    seed: &MapSeed,
    grid: &MapGrid,
    city: &City,
    buildings: &Query<&Building>,
    citizens: &Query<(&CitizenIdComp, &Citizen, Option<&CitizenWorkplace>)>,
    id_gen: &CitizenIdGen,
    stations: &Query<&ServiceStation>,
    emergency_manager: Option<&EmergencyManager>,
) -> SaveGameV3 {
    let v2 = snapshot_savegame_v2(
        seed,
        grid,
        city,
        citizens,
        id_gen,
        stations,
        emergency_manager,
    );
    let mut out_buildings = Vec::new();
    for b in buildings.iter() {
        out_buildings.push(BuildingSnapshot {
            kind: b.kind,
            anchor_pos: b.anchor_pos,
            footprint_width: b.footprint_width,
            footprint_length: b.footprint_length,
            level: b.level,
            phase: match b.phase {
                BuildingPhase::UnderConstruction { days_remaining } => {
                    BuildingPhaseSnapshot::UnderConstruction { days_remaining }
                }
                BuildingPhase::Operational => BuildingPhaseSnapshot::Operational,
            },
            construction_start_day: b.construction_start_day,
            capacity_residents: b.capacity_residents,
            capacity_jobs: b.capacity_jobs,
            occupancy_residents: b.occupancy_residents,
            occupancy_jobs: b.occupancy_jobs,
            target_occupancy_residents: b.target_occupancy_residents,
            target_occupancy_jobs: b.target_occupancy_jobs,
            parking_spots: b.parking_spots.clone(),
        });
    }

    SaveGameV3 {
        save_version: 3,
        seed: v2.seed,
        map: v2.map,
        city: v2.city,
        buildings: out_buildings,
        citizens: v2.citizens,
        next_citizen_id: v2.next_citizen_id,
        service_stations: v2.service_stations,
        emergency_stats: v2.emergency_stats,
    }
}

fn dump_save_contract(mut reader: MessageReader<GameCommand>, p: DumpParams) {
    for cmd in reader.read() {
        if !matches!(cmd, GameCommand::DumpSaveContract) {
            continue;
        }
        let save = snapshot_savegame_v3(
            &p.seed,
            &p.grid,
            &p.city,
            &p.q_buildings,
            &p.q_citizens,
            &p.id_gen,
            &p.q_stations,
            p.emergency_manager.as_deref(),
        );

        // Touch snapshot fields so the contract stays "live" in the binary (no dead_code).
        let (t_height, t_water, t_terrain, t_road, t_zone, t_building) =
            if let Some(t) = save.map.tiles.first().copied() {
                (
                    Some(t.height),
                    Some(t.water),
                    Some(t.terrain),
                    Some(t.road),
                    Some(t.zone),
                    t.building,
                )
            } else {
                (None, None, None, None, None, None)
            };

        let (c_id, c_home, c_last, c_state, c_workplace) = if let Some(c) = save.citizens.first() {
            (
                Some(c.id),
                Some(c.home),
                Some(c.last_place),
                Some(c.state),
                c.workplace,
            )
        } else {
            (None, None, None, None, None)
        };

        let (s_kind, s_pos, s_total, s_avail) = if let Some(s) = save.service_stations.first() {
            (
                Some(s.kind),
                Some(s.pos),
                Some(s.total_vehicles),
                Some(s.available_vehicles),
            )
        } else {
            (None, None, None, None)
        };

        let (b_kind, b_pos, b_size, b_phase) = if let Some(b) = save.buildings.first() {
            (
                Some(b.kind),
                Some(b.anchor_pos),
                Some((b.footprint_width, b.footprint_length)),
                Some(b.phase),
            )
        } else {
            (None, None, None, None)
        };

        info!(
            "SaveContract v{}: seed={} map={}x{} tiles={} buildings={} citizens={} next_citizen_id={} money={} day={} stations={} emergency_stats={:?} tile0={:?}/{:?}/{:?}/{:?}/{:?}/{:?} building0={:?}/{:?}/{:?}/{:?} citizen0={:?}/{:?}/{:?}/{:?}/{:?} station0={:?}/{:?}/{:?}/{:?}",
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
            save.emergency_stats,
            t_height,
            t_water,
            t_terrain,
            t_road,
            t_zone,
            t_building,
            b_kind,
            b_pos,
            b_size,
            b_phase,
            c_id,
            c_home,
            c_last,
            c_state,
            c_workplace,
            s_kind,
            s_pos,
            s_total,
            s_avail
        );
    }
}

#[derive(SystemParam)]
struct DumpParams<'w, 's> {
    seed: Res<'w, MapSeed>,
    grid: Res<'w, MapGrid>,
    city: Res<'w, City>,
    id_gen: Res<'w, CitizenIdGen>,
    q_buildings: Query<'w, 's, &'static Building>,
    q_citizens: Query<
        'w,
        's,
        (
            &'static CitizenIdComp,
            &'static Citizen,
            Option<&'static CitizenWorkplace>,
        ),
    >,
    q_stations: Query<'w, 's, &'static ServiceStation>,
    emergency_manager: Option<Res<'w, EmergencyManager>>,
}
