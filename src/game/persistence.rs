//! M7: Save/Load (v1) implementation.
//!
//! Uses the contract types from `persistence_contract` and stores data as `ron`.

use std::fs;
use std::path::{Path, PathBuf};

use bevy::ecs::message::MessageReader;
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;

use crate::game::buildings::Building;
use crate::game::citizens::{Citizen, CitizenWorkplace};
use crate::game::commands::GameCommand;
use crate::game::ids::{CitizenIdComp, CitizenIdGen};
use crate::game::map::{MapCell, MapGrid, MapSeed, TilePos};
use crate::game::persistence_contract::{CitizenSnapshotV1, MapGridV1, MapTileV1, SaveGameV1};
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;
use crate::game::traffic::Vehicle;
use crate::game::transport::GraphVersion;

pub struct PersistencePlugin;

impl Plugin for PersistencePlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(
            Update,
            (handle_save_commands, handle_load_commands)
                .in_set(GameSet::CommandApply)
                .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
        );
    }
}

fn saves_dir() -> PathBuf {
    PathBuf::from("saves")
}

fn slot_path(slot: u8) -> PathBuf {
    saves_dir().join(format!("slot{}.ron", slot.max(1)))
}

fn ensure_parent_dir(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn snapshot_map(grid: &MapGrid) -> MapGridV1 {
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
    MapGridV1 {
        width: grid.width,
        height: grid.height,
        tiles,
    }
}

fn snapshot_citizens(
    q: &Query<(&CitizenIdComp, &Citizen, Option<&CitizenWorkplace>)>,
) -> Vec<CitizenSnapshotV1> {
    let mut out = Vec::new();
    for (id, c, wp) in q.iter() {
        out.push(CitizenSnapshotV1 {
            id: id.0,
            home: c.home,
            last_place: c.last_place,
            state: c.state,
            workplace: wp.and_then(|w| w.workplace),
        });
    }
    out
}

fn handle_save_commands(
    mut reader: MessageReader<GameCommand>,
    seed: Res<MapSeed>,
    grid: Res<MapGrid>,
    city: Res<City>,
    id_gen: Res<CitizenIdGen>,
    q_citizens: Query<(&CitizenIdComp, &Citizen, Option<&CitizenWorkplace>)>,
) {
    for cmd in reader.read() {
        let GameCommand::SaveGame { slot } = cmd else {
            continue;
        };

        let save = SaveGameV1 {
            save_version: 1,
            seed: seed.0,
            map: snapshot_map(&grid),
            city: city.clone(),
            citizens: snapshot_citizens(&q_citizens),
            next_citizen_id: id_gen.next(),
        };

        let path = slot_path(*slot);
        if let Err(e) = ensure_parent_dir(&path) {
            error!("Save failed: cannot create save dir: {e}");
            continue;
        }

        let pretty = ron::ser::PrettyConfig::new();
        match ron::ser::to_string_pretty(&save, pretty) {
            Ok(text) => match fs::write(&path, text) {
                Ok(()) => info!("Saved game to {}", path.display()),
                Err(e) => error!("Save failed: write {}: {e}", path.display()),
            },
            Err(e) => error!("Save failed: serialize: {e}"),
        }
    }
}

fn apply_map_from_v1(grid: &mut MapGrid, v1: &MapGridV1) {
    *grid = MapGrid::new(v1.width, v1.height);
    for (i, t) in v1.tiles.iter().enumerate() {
        let x = (i % (v1.width as usize)) as i32;
        let y = (i / (v1.width as usize)) as i32;
        let pos = TilePos { x, y };
        let cell = MapCell {
            height: t.height,
            water: t.water,
            terrain: t.terrain,
            road: t.road,
            zone: t.zone,
            building: t.building,
        };
        grid.set(pos, cell);
    }
}

#[derive(SystemParam)]
struct LoadParams<'w, 's> {
    commands: Commands<'w, 's>,
    next_state: ResMut<'w, NextState<AppState>>,
    seed: ResMut<'w, MapSeed>,
    grid: ResMut<'w, MapGrid>,
    city: ResMut<'w, City>,
    id_gen: ResMut<'w, CitizenIdGen>,
    dirty: ResMut<'w, crate::game::map::DirtyTiles>,
    graph_version: ResMut<'w, GraphVersion>,
    q_buildings: Query<'w, 's, Entity, With<Building>>,
    q_vehicles: Query<'w, 's, Entity, With<Vehicle>>,
    q_citizens: Query<'w, 's, Entity, With<Citizen>>,
}

fn handle_load_commands(mut reader: MessageReader<GameCommand>, mut p: LoadParams) {
    for cmd in reader.read() {
        let GameCommand::LoadGame { slot } = cmd else {
            continue;
        };

        let path = slot_path(*slot);
        let Ok(text) = fs::read_to_string(&path) else {
            error!("Load failed: cannot read {}", path.display());
            continue;
        };

        let Ok(save) = ron::from_str::<SaveGameV1>(&text) else {
            error!("Load failed: invalid ron in {}", path.display());
            continue;
        };

        if save.save_version != 1 {
            error!(
                "Load failed: unsupported save_version {} (expected 1)",
                save.save_version
            );
            continue;
        }

        // Clear runtime entities that are not part of the save contract.
        for e in p.q_buildings.iter() {
            p.commands.entity(e).despawn();
        }
        for e in p.q_vehicles.iter() {
            p.commands.entity(e).despawn();
        }
        for e in p.q_citizens.iter() {
            p.commands.entity(e).despawn();
        }

        // Apply resources.
        p.seed.0 = save.seed;
        apply_map_from_v1(&mut p.grid, &save.map);
        *p.city = save.city.clone();
        p.id_gen.set_next(save.next_citizen_id);

        // Recreate citizens from snapshot (timers are reconstructed in MVP).
        for c in save.citizens.iter() {
            p.commands.spawn((
                CitizenIdComp(c.id),
                Citizen {
                    home: c.home,
                    state: c.state,
                    last_place: c.last_place,
                    // Timers will be randomized by the regular spawn system; for load we keep
                    // deterministic timers (fixed) to keep behavior stable.
                    decision_timer: Timer::from_seconds(2.0, TimerMode::Repeating),
                    shopping_need: Timer::from_seconds(12.0, TimerMode::Repeating),
                    work_stay: Timer::from_seconds(6.0, TimerMode::Once),
                    shop_stay: Timer::from_seconds(3.0, TimerMode::Once),
                    trip_departed_at_sec: None,
                    trip_purpose: None,
                },
                CitizenWorkplace {
                    workplace: c.workplace,
                },
            ));
        }

        // Mark map as dirty so render sync updates tiles; bump graph.
        p.dirty.mark_all();
        p.graph_version.bump();

        info!(
            "Loaded game from {} (citizens={}, money={}, day={})",
            path.display(),
            save.citizens.len(),
            p.city.money,
            p.city.day
        );

        // Ensure we're in-game after load.
        p.next_state.set(AppState::InGame);
    }
}
