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
use crate::game::emergencies::{Emergency, EmergencyManager, EmergencyStats};
use crate::game::ids::{CitizenIdComp, CitizenIdGen};
use crate::game::map::{
    MapCell, MapConfig, MapEditVersion, MapGrid, MapSeed, TilePos, spawn_building_entity,
};
use crate::game::persistence_contract::{
    CitizenSnapshotV1, MapGridV1, MapTileV1, SaveGameV1, SaveGameV2, ServiceStationSnapshot,
};
use crate::game::services::{
    ServiceKind, ServiceStation, ServiceVehicleMarker, adjacent_road_any, spawn_service_vehicle,
};
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

fn snapshot_service_stations(q: &Query<&ServiceStation>) -> Vec<ServiceStationSnapshot> {
    let mut out = Vec::new();
    for s in q.iter() {
        out.push(ServiceStationSnapshot {
            kind: s.kind,
            pos: s.pos,
            total_vehicles: s.total_vehicles,
            available_vehicles: s.available_vehicles,
        });
    }
    out
}

#[derive(SystemParam)]
struct SaveParams<'w, 's> {
    seed: Res<'w, MapSeed>,
    grid: Res<'w, MapGrid>,
    city: Res<'w, City>,
    id_gen: Res<'w, CitizenIdGen>,
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

fn handle_save_commands(mut reader: MessageReader<GameCommand>, p: SaveParams) {
    for cmd in reader.read() {
        let GameCommand::SaveGame { slot } = cmd else {
            continue;
        };

        let save = SaveGameV2 {
            save_version: 2,
            seed: p.seed.0,
            map: snapshot_map(&p.grid),
            city: p.city.clone(),
            citizens: snapshot_citizens(&p.q_citizens),
            next_citizen_id: p.id_gen.next(),
            service_stations: snapshot_service_stations(&p.q_stations),
            emergency_stats: p
                .emergency_manager
                .as_deref()
                .map(|m| m.stats.clone())
                .unwrap_or_default(),
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

fn upgrade_v1_to_v2(v1: SaveGameV1) -> SaveGameV2 {
    // Derive service station list from the map, since v1 did not store it explicitly.
    // Active emergencies and in-flight vehicles are intentionally not persisted (roadmap 5.6).
    let mut stations = Vec::new();
    for (i, t) in v1.map.tiles.iter().enumerate() {
        let kind = t.building;
        let Some(b_kind) = kind else {
            continue;
        };
        let Some(s_kind) = ServiceKind::from_building(b_kind) else {
            continue;
        };
        let x = (i % (v1.map.width as usize)) as i32;
        let y = (i / (v1.map.width as usize)) as i32;
        let pos = TilePos { x, y };
        let total = b_kind.vehicle_capacity();
        stations.push(ServiceStationSnapshot {
            kind: s_kind,
            pos,
            total_vehicles: total,
            available_vehicles: total,
        });
    }

    SaveGameV2 {
        save_version: 2,
        seed: v1.seed,
        map: v1.map,
        city: v1.city,
        citizens: v1.citizens,
        next_citizen_id: v1.next_citizen_id,
        service_stations: stations,
        emergency_stats: EmergencyStats::default(),
    }
}

fn load_save_v2(text: &str) -> Result<SaveGameV2, String> {
    match ron::from_str::<SaveGameV2>(text) {
        Ok(v2) => {
            if v2.save_version != 2 {
                return Err(format!(
                    "unsupported save_version {} (expected 2)",
                    v2.save_version
                ));
            }
            Ok(v2)
        }
        Err(_) => match ron::from_str::<SaveGameV1>(text) {
            Ok(v1) => {
                if v1.save_version != 1 {
                    return Err(format!(
                        "unsupported save_version {} (expected 1)",
                        v1.save_version
                    ));
                }
                Ok(upgrade_v1_to_v2(v1))
            }
            Err(e) => Err(format!("invalid ron: {e}")),
        },
    }
}

#[derive(SystemParam)]
struct LoadParams<'w, 's> {
    commands: Commands<'w, 's>,
    next_state: ResMut<'w, NextState<AppState>>,
    cfg: Res<'w, MapConfig>,
    seed: ResMut<'w, MapSeed>,
    grid: ResMut<'w, MapGrid>,
    city: ResMut<'w, City>,
    id_gen: ResMut<'w, CitizenIdGen>,
    emergency_manager: Option<ResMut<'w, EmergencyManager>>,
    dirty: ResMut<'w, crate::game::map::DirtyTiles>,
    graph_version: ResMut<'w, GraphVersion>,
    map_edit_version: ResMut<'w, MapEditVersion>,
    q_buildings: Query<'w, 's, Entity, With<Building>>,
    q_vehicles: Query<'w, 's, Entity, With<Vehicle>>,
    q_vehicle_markers: Query<'w, 's, Entity, With<ServiceVehicleMarker>>,
    q_citizens: Query<'w, 's, Entity, With<Citizen>>,
    q_emergencies: Query<'w, 's, Entity, With<Emergency>>,
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

        let save = match load_save_v2(&text) {
            Ok(s) => s,
            Err(e) => {
                error!("Load failed: {} in {}", e, path.display());
                continue;
            }
        };

        // Clear runtime entities that are not part of the save contract.
        for e in p.q_buildings.iter() {
            p.commands.entity(e).despawn();
        }
        // Service vehicles may have child marker entities; despawn them explicitly first.
        for e in p.q_vehicle_markers.iter() {
            p.commands.entity(e).despawn();
        }
        for e in p.q_vehicles.iter() {
            p.commands.entity(e).despawn();
        }
        for e in p.q_citizens.iter() {
            p.commands.entity(e).despawn();
        }
        for e in p.q_emergencies.iter() {
            p.commands.entity(e).despawn();
        }

        // Apply resources.
        p.seed.0 = save.seed;
        apply_map_from_v1(&mut p.grid, &save.map);
        *p.city = save.city.clone();
        p.id_gen.set_next(save.next_citizen_id);

        if let Some(mgr) = p.emergency_manager.as_mut() {
            // Keep timers/config from the current binary; restore only stats.
            mgr.stats = save.emergency_stats.clone();
        }

        // Recreate buildings from the grid snapshot.
        // NOTE: Active emergencies and in-flight service vehicles are not persisted (roadmap 5.6),
        // so we respawn station fleets in a stable "all parked" configuration.
        let station_by_pos: std::collections::HashMap<TilePos, ServiceStationSnapshot> = save
            .service_stations
            .iter()
            .copied()
            .map(|s| (s.pos, s))
            .collect();

        for y in 0..p.grid.height {
            for x in 0..p.grid.width {
                let pos = TilePos { x, y };
                let Some(cell) = p.grid.get(pos) else {
                    continue;
                };
                let Some(kind) = cell.building else {
                    continue;
                };

                let building_entity = spawn_building_entity(&mut p.commands, &p.cfg, pos, kind);

                if let Some(s_kind) = ServiceKind::from_building(kind) {
                    let (total, available) = station_by_pos
                        .get(&pos)
                        .map(|s| (s.total_vehicles, s.available_vehicles.min(s.total_vehicles)))
                        .unwrap_or_else(|| {
                            let t = kind.vehicle_capacity();
                            (t, t)
                        });

                    p.commands.entity(building_entity).insert(ServiceStation {
                        kind: s_kind,
                        pos,
                        total_vehicles: total,
                        available_vehicles: available,
                    });

                    for _ in 0..available {
                        if let Some(start_pos) = adjacent_road_any(&p.grid, pos) {
                            spawn_service_vehicle(
                                &mut p.commands,
                                &p.cfg,
                                s_kind,
                                building_entity,
                                start_pos,
                            );
                        }
                    }
                }
            }
        }

        // Recreate citizens from snapshot (timers are reconstructed in MVP).
        for c in save.citizens.iter() {
            p.commands.spawn((
                CitizenIdComp(c.id),
                Citizen {
                    home: c.home,
                    state: c.state,
                    last_place: c.last_place,
                    tour_mode: None,
                    car_parked_at: if c.state == crate::game::citizens::CitizenState::AtHome {
                        c.home
                    } else {
                        c.last_place
                    },
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
        p.map_edit_version.bump();

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
