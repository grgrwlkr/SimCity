//! M7: Save/Load (v1) implementation.
//!
//! Uses the contract types from `persistence_contract` and stores data as `ron`.

use std::fs;
use std::path::{Path, PathBuf};

use bevy::ecs::message::MessageReader;
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;

use crate::game::buildings::{Building, BuildingPhase, calculate_parking_spots};
use crate::game::citizens::{Citizen, CitizenWorkplace};
use crate::game::commands::GameCommand;
use crate::game::emergencies::{Emergency, EmergencyManager, EmergencyStats};
use crate::game::ids::{CitizenIdComp, CitizenIdGen};
use crate::game::map::{
    BuildingKind, MapCell, MapConfig, MapEditVersion, MapGrid, MapSeed, TilePos,
};
use crate::game::persistence_contract::{
    BuildingPhaseSnapshot, BuildingSnapshot, CitizenSnapshotV1, MapGridV1, MapTileV1, SaveGameV1,
    SaveGameV2, SaveGameV3, ServiceStationSnapshot,
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

fn snapshot_buildings(q: &Query<&Building>) -> Vec<BuildingSnapshot> {
    let mut out = Vec::new();
    for b in q.iter() {
        out.push(BuildingSnapshot {
            kind: b.kind,
            anchor_pos: b.anchor_pos,
            footprint_width: b.footprint_width,
            footprint_length: b.footprint_length,
            level: b.level,
            phase: snapshot_building_phase(b.phase),
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
    out
}

fn snapshot_building_phase(phase: BuildingPhase) -> BuildingPhaseSnapshot {
    match phase {
        BuildingPhase::UnderConstruction { days_remaining } => {
            BuildingPhaseSnapshot::UnderConstruction { days_remaining }
        }
        BuildingPhase::Operational => BuildingPhaseSnapshot::Operational,
    }
}

fn restore_building_phase(phase: BuildingPhaseSnapshot) -> BuildingPhase {
    match phase {
        BuildingPhaseSnapshot::UnderConstruction { days_remaining } => {
            BuildingPhase::UnderConstruction { days_remaining }
        }
        BuildingPhaseSnapshot::Operational => BuildingPhase::Operational,
    }
}

fn spawn_building_entity_from_snapshot(
    commands: &mut Commands,
    cfg: &MapConfig,
    snapshot: &BuildingSnapshot,
) -> Entity {
    let origin = Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    );
    let center_x = snapshot.anchor_pos.x as f32 + (snapshot.footprint_width as f32 - 1.0) * 0.5;
    let center_y = snapshot.anchor_pos.y as f32 + (snapshot.footprint_length as f32 - 1.0) * 0.5;
    let world = origin + Vec2::new(center_x * cfg.tile_size, center_y * cfg.tile_size);
    let sprite_size = Vec2::new(
        snapshot.footprint_width as f32 * cfg.tile_size,
        snapshot.footprint_length as f32 * cfg.tile_size,
    );
    let mut tf = Transform::from_translation(Vec3::new(world.x, world.y, 8.0));
    tf.scale = Vec3::splat(1.0);

    commands
        .spawn((
            Building {
                kind: snapshot.kind,
                anchor_pos: snapshot.anchor_pos,
                footprint_width: snapshot.footprint_width,
                footprint_length: snapshot.footprint_length,
                level: snapshot.level,
                phase: restore_building_phase(snapshot.phase),
                construction_start_day: snapshot.construction_start_day,
                capacity_residents: snapshot.capacity_residents,
                capacity_jobs: snapshot.capacity_jobs,
                occupancy_residents: snapshot.occupancy_residents,
                occupancy_jobs: snapshot.occupancy_jobs,
                target_occupancy_residents: snapshot.target_occupancy_residents,
                target_occupancy_jobs: snapshot.target_occupancy_jobs,
                parking_spots: snapshot.parking_spots.clone(),
            },
            Sprite::from_color(snapshot.kind.color(), sprite_size),
            tf,
        ))
        .id()
}

#[derive(SystemParam)]
struct SaveParams<'w, 's> {
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

fn handle_save_commands(mut reader: MessageReader<GameCommand>, p: SaveParams) {
    for cmd in reader.read() {
        let GameCommand::SaveGame { slot } = cmd else {
            continue;
        };

        let save = SaveGameV3 {
            save_version: 3,
            seed: p.seed.0,
            map: snapshot_map(&p.grid),
            city: p.city.clone(),
            buildings: snapshot_buildings(&p.q_buildings),
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

fn derive_buildings_from_map(map: &MapGridV1, city: &City) -> Vec<BuildingSnapshot> {
    let mut out = Vec::new();
    let mut visited = vec![false; map.tiles.len()];

    for y in 0..map.height {
        for x in 0..map.width {
            let idx = (y as usize) * (map.width as usize) + (x as usize);
            if visited.get(idx).copied().unwrap_or(true) {
                continue;
            }
            let Some(kind) = map.tiles.get(idx).and_then(|t| t.building) else {
                continue;
            };

            let pos = TilePos { x, y };
            let Some((anchor, width, length)) = find_legacy_footprint(pos, kind, map, &visited)
            else {
                warn!(
                    "Load upgrade: could not reconstruct footprint at {:?} ({:?})",
                    pos, kind
                );
                visited[idx] = true;
                continue;
            };

            mark_legacy_footprint(&mut visited, map, anchor, width, length);
            out.push(building_snapshot_from_legacy(
                kind, anchor, width, length, city,
            ));
        }
    }

    out
}

fn build_legacy_candidates(kind: BuildingKind) -> Vec<(u8, u8)> {
    match kind {
        BuildingKind::FireStation | BuildingKind::PoliceStation | BuildingKind::Hospital => {
            vec![(3, 3)]
        }
        _ => {
            let mut out = Vec::new();
            for width in 3..=6u8 {
                for length in 3..=6u8 {
                    out.push((width, length));
                }
            }
            out.sort_by(|(aw, al), (bw, bl)| {
                let area_a = (*aw as u16) * (*al as u16);
                let area_b = (*bw as u16) * (*bl as u16);
                area_b
                    .cmp(&area_a)
                    .then_with(|| bl.cmp(al))
                    .then_with(|| bw.cmp(aw))
            });
            out
        }
    }
}

fn find_legacy_footprint(
    pos: TilePos,
    kind: BuildingKind,
    map: &MapGridV1,
    visited: &[bool],
) -> Option<(TilePos, u8, u8)> {
    for (width, length) in build_legacy_candidates(kind) {
        let w = width as i32;
        let l = length as i32;
        for dy in 0..l {
            for dx in 0..w {
                let anchor = TilePos {
                    x: pos.x - dx,
                    y: pos.y - dy,
                };
                if legacy_footprint_matches(map, visited, anchor, width, length, kind) {
                    return Some((anchor, width, length));
                }
            }
        }
    }
    None
}

fn legacy_footprint_matches(
    map: &MapGridV1,
    visited: &[bool],
    anchor: TilePos,
    width: u8,
    length: u8,
    kind: BuildingKind,
) -> bool {
    if anchor.x < 0 || anchor.y < 0 {
        return false;
    }
    if anchor.x + width as i32 > map.width || anchor.y + length as i32 > map.height {
        return false;
    }

    for dy in 0..length as i32 {
        for dx in 0..width as i32 {
            let x = anchor.x + dx;
            let y = anchor.y + dy;
            let idx = (y as usize) * (map.width as usize) + (x as usize);
            let Some(tile) = map.tiles.get(idx) else {
                return false;
            };
            if visited.get(idx).copied().unwrap_or(true) {
                return false;
            }
            if tile.building != Some(kind) {
                return false;
            }
        }
    }
    true
}

fn mark_legacy_footprint(
    visited: &mut [bool],
    map: &MapGridV1,
    anchor: TilePos,
    width: u8,
    length: u8,
) {
    for dy in 0..length as i32 {
        for dx in 0..width as i32 {
            let x = anchor.x + dx;
            let y = anchor.y + dy;
            let idx = (y as usize) * (map.width as usize) + (x as usize);
            if let Some(slot) = visited.get_mut(idx) {
                *slot = true;
            }
        }
    }
}

fn building_snapshot_from_legacy(
    kind: BuildingKind,
    anchor: TilePos,
    width: u8,
    length: u8,
    city: &City,
) -> BuildingSnapshot {
    let level = 1;
    let area = (width as u32) * (length as u32);
    let construction_days = Building::calculate_construction_days(kind, level, area);
    let num_spots = (area / 9).max(1) as usize;
    BuildingSnapshot {
        kind,
        anchor_pos: anchor,
        footprint_width: width,
        footprint_length: length,
        level,
        phase: BuildingPhaseSnapshot::UnderConstruction {
            days_remaining: construction_days,
        },
        construction_start_day: city.day,
        capacity_residents: kind.capacity_residents_for_level_area(level, area),
        capacity_jobs: kind.capacity_jobs_for_level_area(level, area),
        occupancy_residents: 0,
        occupancy_jobs: 0,
        target_occupancy_residents: 0,
        target_occupancy_jobs: 0,
        parking_spots: calculate_parking_spots(anchor, width, length, num_spots),
    }
}

fn derive_service_stations_from_buildings(
    buildings: &[BuildingSnapshot],
) -> Vec<ServiceStationSnapshot> {
    let mut out = Vec::new();
    for b in buildings.iter() {
        let Some(kind) = ServiceKind::from_building(b.kind) else {
            continue;
        };
        let total = b.kind.vehicle_capacity();
        out.push(ServiceStationSnapshot {
            kind,
            pos: b.anchor_pos,
            total_vehicles: total,
            available_vehicles: total,
        });
    }
    out
}

fn upgrade_v2_to_v3(v2: SaveGameV2) -> SaveGameV3 {
    let buildings = derive_buildings_from_map(&v2.map, &v2.city);
    SaveGameV3 {
        save_version: 3,
        seed: v2.seed,
        map: v2.map,
        city: v2.city,
        buildings,
        citizens: v2.citizens,
        next_citizen_id: v2.next_citizen_id,
        service_stations: v2.service_stations,
        emergency_stats: v2.emergency_stats,
    }
}

fn upgrade_v1_to_v3(v1: SaveGameV1) -> SaveGameV3 {
    let buildings = derive_buildings_from_map(&v1.map, &v1.city);
    let service_stations = derive_service_stations_from_buildings(&buildings);
    SaveGameV3 {
        save_version: 3,
        seed: v1.seed,
        map: v1.map,
        city: v1.city,
        buildings,
        citizens: v1.citizens,
        next_citizen_id: v1.next_citizen_id,
        service_stations,
        emergency_stats: EmergencyStats::default(),
    }
}

fn load_save_v3(text: &str) -> Result<SaveGameV3, String> {
    match ron::from_str::<SaveGameV3>(text) {
        Ok(v3) => {
            if v3.save_version != 3 {
                return Err(format!(
                    "unsupported save_version {} (expected 3)",
                    v3.save_version
                ));
            }
            Ok(v3)
        }
        Err(_) => match ron::from_str::<SaveGameV2>(text) {
            Ok(v2) => {
                if v2.save_version != 2 {
                    return Err(format!(
                        "unsupported save_version {} (expected 2)",
                        v2.save_version
                    ));
                }
                Ok(upgrade_v2_to_v3(v2))
            }
            Err(_) => match ron::from_str::<SaveGameV1>(text) {
                Ok(v1) => {
                    if v1.save_version != 1 {
                        return Err(format!(
                            "unsupported save_version {} (expected 1)",
                            v1.save_version
                        ));
                    }
                    Ok(upgrade_v1_to_v3(v1))
                }
                Err(e) => Err(format!("invalid ron: {e}")),
            },
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
    path_pool: ResMut<'w, crate::game::transport::PathPool>,
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

        let save = match load_save_v3(&text) {
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

        // Recreate buildings from snapshots.
        // NOTE: Active emergencies and in-flight service vehicles are not persisted (roadmap 5.6),
        // so we respawn station fleets in a stable "all parked" configuration.
        let station_by_pos: std::collections::HashMap<TilePos, ServiceStationSnapshot> = save
            .service_stations
            .iter()
            .copied()
            .map(|s| (s.pos, s))
            .collect();

        for b in save.buildings.iter() {
            let building_entity = spawn_building_entity_from_snapshot(&mut p.commands, &p.cfg, b);

            if let Some(s_kind) = ServiceKind::from_building(b.kind) {
                let (total, available) = station_by_pos
                    .get(&b.anchor_pos)
                    .map(|s| (s.total_vehicles, s.available_vehicles.min(s.total_vehicles)))
                    .unwrap_or_else(|| {
                        let t = b.kind.vehicle_capacity();
                        (t, t)
                    });

                p.commands.entity(building_entity).insert(ServiceStation {
                    kind: s_kind,
                    pos: b.anchor_pos,
                    total_vehicles: total,
                    available_vehicles: available,
                    occupied: false,
                });

                for _ in 0..available {
                    if let Some(start_pos) = adjacent_road_any(&p.grid, b.anchor_pos) {
                        spawn_service_vehicle(
                            &mut p.commands,
                            &p.cfg,
                            &mut p.path_pool,
                            s_kind,
                            building_entity,
                            start_pos,
                        );
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
