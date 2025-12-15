//! Persistence contract types (pre-M7).
//!
//! This module intentionally does NOT implement IO yet. It's a single place to keep the
//! "what is saved" contract stable before implementing M7 Save/Load.

use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::citizens::CitizenState;
use crate::game::citizens::{Citizen, CitizenWorkplace};
use crate::game::commands::GameCommand;
use crate::game::ids::{CitizenId, CitizenIdComp, CitizenIdGen};
use crate::game::map::{BuildingKind, TileKind, TilePos, ZoneKind};
use crate::game::map::{MapGrid, MapSeed};
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
    pub road: bool,
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

fn dump_save_contract(
    mut reader: MessageReader<GameCommand>,
    seed: Res<MapSeed>,
    grid: Res<MapGrid>,
    city: Res<City>,
    id_gen: Res<CitizenIdGen>,
    q_citizens: Query<(&CitizenIdComp, &Citizen, Option<&CitizenWorkplace>)>,
) {
    for cmd in reader.read() {
        if !matches!(cmd, GameCommand::DumpSaveContract) {
            continue;
        }
        let save = snapshot_savegame_v1(&seed, &grid, &city, &q_citizens, &id_gen);

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

        info!(
            "SaveContract v{}: seed={} map={}x{} tiles={} citizens={} next_citizen_id={} money={} day={} tile0={:?}/{:?}/{:?}/{:?}/{:?}/{:?} citizen0={:?}/{:?}/{:?}/{:?}/{:?}",
            save.save_version,
            save.seed,
            save.map.width,
            save.map.height,
            save.map.tiles.len(),
            save.citizens.len(),
            save.next_citizen_id,
            save.city.money,
            save.city.day,
            t_height,
            t_water,
            t_terrain,
            t_road,
            t_zone,
            t_building,
            c_id,
            c_home,
            c_last,
            c_state,
            c_workplace
        );
    }
}
