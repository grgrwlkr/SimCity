use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::buildings::{Building, BuildingPhase, calculate_parking_spots};
use crate::game::command_history::{CommandHistory, UndoableCommand};
use crate::game::commands::GameCommand;
use crate::game::roads::{RoadCell, RoadDir, RoadKind};
use crate::game::sim::City;
use crate::game::transport::GraphVersion;
use crate::game::zone_placement::can_zone_tile;

use super::coords::map_origin;
use super::dirty::RoadDirtyTiles;
use super::generation::generate_map_into_grid;
use super::{
    BuildingKind, DirtyTiles, MapConfig, MapEditVersion, MapGrid, MapSeed, TilePos, ZoneKind,
};

pub(crate) fn spawn_building_entity(
    commands: &mut Commands,
    cfg: &MapConfig,
    pos: TilePos,
    kind: BuildingKind,
    city: &City,
) -> Entity {
    // For manual placement, use default 3x3 footprint
    let footprint_width = 3u8;
    let footprint_length = 3u8;
    let origin = map_origin(cfg);
    // Position at center of footprint
    let center_x = pos.x as f32 + (footprint_width as f32 - 1.0) * 0.5;
    let center_y = pos.y as f32 + (footprint_length as f32 - 1.0) * 0.5;
    let world = origin + Vec2::new(center_x * cfg.tile_size, center_y * cfg.tile_size);
    let sprite_size = Vec2::new(
        footprint_width as f32 * cfg.tile_size,
        footprint_length as f32 * cfg.tile_size,
    );

    let level = 1;
    let area = (footprint_width as u32) * (footprint_length as u32);
    let construction_days = Building::calculate_construction_days(kind, level, area);

    commands
        .spawn((
            Building {
                kind,
                anchor_pos: pos,
                footprint_width,
                footprint_length,
                level,
                phase: BuildingPhase::UnderConstruction {
                    days_remaining: construction_days,
                },
                construction_start_day: city.day,
                capacity_residents: kind.capacity_residents_for_level_area(level, area),
                capacity_jobs: kind.capacity_jobs_for_level_area(level, area),
                occupancy_residents: 0,
                occupancy_jobs: 0,
                target_occupancy_residents: 0,
                target_occupancy_jobs: 0,
                parking_spots: {
                    // GDD 10.3.4: max(1, area/9) parking spots distributed within footprint.
                    let num_spots = (area / 9).max(1) as usize;
                    calculate_parking_spots(pos, footprint_width, footprint_length, num_spots)
                },
            },
            Sprite::from_color(kind.color(), sprite_size),
            Transform::from_translation(Vec3::new(world.x, world.y, 8.0)),
        ))
        .id()
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_game_commands_to_grid(
    mut cmd_reader: MessageReader<GameCommand>,
    mut commands: Commands,
    cfg: Res<MapConfig>,
    mut seed: ResMut<MapSeed>,
    mut grid: ResMut<MapGrid>,
    mut dirty: ResMut<DirtyTiles>,
    mut road_dirty: ResMut<RoadDirtyTiles>,
    mut city: ResMut<City>,
    mut graph_version: ResMut<GraphVersion>,
    mut map_edit_version: ResMut<MapEditVersion>,
    mut history: ResMut<CommandHistory>,
) {
    for cmd in cmd_reader.read() {
        match *cmd {
            GameCommand::SetRoad { pos, road } => {
                let Some(idx) = grid.idx(pos) else {
                    continue;
                };
                let mut cell = grid.get(pos).unwrap_or_default();

                // Water tiles are not buildable in MVP.
                if cell.water {
                    continue;
                }

                if !road.is_some() {
                    continue;
                }

                // Save old state for undo
                let old_road = cell.road;

                // If road already exists with same properties, skip (no cost, no change).
                // Note: intersections may override `dir` below, so compare after that logic.
                let mut new_road = road;

                // If we are writing onto an existing road tile with a perpendicular axis,
                // convert this tile into an intersection node (`dir: None`).
                //
                // This is a pragmatic MVP: it preserves connectivity at crossings without
                // requiring multi-direction lane data in a single tile.
                let axis_of = |d: RoadDir| -> Option<bool> {
                    // true = horizontal, false = vertical
                    match d {
                        RoadDir::East | RoadDir::West => Some(true),
                        RoadDir::North | RoadDir::South => Some(false),
                        RoadDir::None => None,
                    }
                };
                if cell.road.is_some()
                    && cell.road.dir != RoadDir::None
                    && new_road.dir != RoadDir::None
                    && axis_of(cell.road.dir).is_some()
                    && axis_of(new_road.dir).is_some()
                    && axis_of(cell.road.dir) != axis_of(new_road.dir)
                {
                    new_road.dir = RoadDir::None;
                }
                // If the tile is already an intersection node, keep it an intersection.
                // Note: only check if there IS an existing road; empty tiles have dir=None by default.
                if cell.road.is_some() && cell.road.dir == RoadDir::None {
                    new_road.dir = RoadDir::None;
                }

                if cell.road == new_road {
                    continue;
                }

                // Road upgrade/build rules:
                // - can build on empty tile
                // - can upgrade to a larger road
                // - can overwrite existing road of same kind (for intersections)
                // - can't downgrade (Erase -> rebuild)
                let cost = if cell.road.kind == RoadKind::None {
                    new_road.kind.build_cost_per_lane_tile()
                } else if cell.road.kind == new_road.kind {
                    // Same road kind but different direction (intersection) - no extra cost.
                    0
                } else if RoadKind::is_upgrade(cell.road.kind, new_road.kind) {
                    new_road
                        .kind
                        .build_cost_per_lane_tile()
                        .saturating_sub(cell.road.kind.build_cost_per_lane_tile())
                } else {
                    continue;
                };

                // Save command to history before applying
                history.push(UndoableCommand::SetRoad {
                    pos,
                    old: old_road,
                    new: new_road,
                });

                // Allow roads to be built even when in debt (road tooling UX).
                city.money -= cost;
                cell.road = new_road;
                // Invalidate any grown building on this tile when the player edits it.
                cell.building = None;
                grid.set(pos, cell);
                dirty.mark(idx);
                road_dirty.mark(idx);
                map_edit_version.bump();

                // B) Transport: bump road graph version when road topology changes.
                graph_version.bump();
            }
            GameCommand::SetZone { pos, zone } => {
                let Some(idx) = grid.idx(pos) else {
                    continue;
                };
                let mut cell = grid.get(pos).unwrap_or_default();

                // Can't zone if placement constraints are not met.
                if !can_zone_tile(&grid, pos) {
                    continue;
                }

                if cell.zone == zone {
                    continue;
                }

                // Save old state for undo
                let old_zone = cell.zone;

                // Save command to history before applying
                history.push(UndoableCommand::SetZone {
                    pos,
                    old: old_zone,
                    new: zone,
                });

                // Zones are free to place (zoning is just marking land for development).
                cell.zone = zone;
                // Zoning edits clear any existing building on tile for simplicity.
                cell.building = None;
                grid.set(pos, cell);
                dirty.mark(idx);
                map_edit_version.bump();
            }
            GameCommand::PlaceBuilding { pos, kind } => {
                // For manual placement, use default 3x3 footprint
                let footprint_width = 3u8;
                let footprint_length = 3u8;
                let anchor = pos;

                // Check if all footprint tiles are valid
                let mut all_valid = true;
                let mut footprint_tiles = Vec::new();
                for dx in 0..(footprint_width as i32) {
                    for dy in 0..(footprint_length as i32) {
                        let tile = TilePos {
                            x: anchor.x + dx,
                            y: anchor.y + dy,
                        };
                        if let Some(cell) = grid.get(tile) {
                            if cell.water || cell.road.is_some() || cell.building.is_some() {
                                all_valid = false;
                                break;
                            }
                            if !can_zone_tile(&grid, tile) {
                                all_valid = false;
                                break;
                            }
                            footprint_tiles.push(tile);
                        } else {
                            all_valid = false;
                            break;
                        }
                    }
                    if !all_valid {
                        break;
                    }
                }

                if !all_valid || footprint_tiles.is_empty() {
                    continue;
                }

                let cost = kind.build_cost();
                if city.money < cost {
                    continue;
                }

                // Save old state for undo (save all tiles)
                let old_buildings: Vec<(TilePos, Option<BuildingKind>)> = footprint_tiles
                    .iter()
                    .filter_map(|t| grid.get(*t).map(|c| (*t, c.building)))
                    .collect();

                // Save command to history before applying
                history.push(UndoableCommand::PlaceBuilding {
                    pos: anchor,
                    old: old_buildings.first().and_then(|(_, b)| *b),
                    new: kind,
                });

                city.money -= cost;

                // Mark all footprint tiles
                for tile in &footprint_tiles {
                    if let Some(mut cell) = grid.get(*tile) {
                        cell.building = Some(kind);
                        cell.zone = ZoneKind::None;
                        grid.set(*tile, cell);
                        if let Some(idx) = grid.idx(*tile) {
                            dirty.mark(idx);
                        }
                    }
                }
                map_edit_version.bump();

                let _ = spawn_building_entity(&mut commands, &cfg, anchor, kind, &city);
            }
            GameCommand::EraseTile { pos } => {
                let Some(idx) = grid.idx(pos) else {
                    continue;
                };
                let mut cell = grid.get(pos).unwrap_or_default();
                if cell.water {
                    continue;
                }

                // Save old state for undo
                let old_road = cell.road;
                let old_zone = cell.zone;
                let old_building = cell.building;

                // Save command to history before applying
                history.push(UndoableCommand::EraseTile {
                    pos,
                    old_road,
                    old_zone,
                    old_building,
                });

                let road_changed = cell.road.is_some();
                cell.road = RoadCell::none();
                cell.zone = ZoneKind::None;
                cell.building = None;
                grid.set(pos, cell);
                dirty.mark(idx);
                map_edit_version.bump();
                if road_changed {
                    graph_version.bump();
                    road_dirty.mark(idx);
                }
            }
            GameCommand::GenerateMap { seed: new_seed } => {
                seed.0 = new_seed;
                generate_map_into_grid(&mut grid, new_seed);
                dirty.mark_all();
                road_dirty.mark_all();
                map_edit_version.bump();
                // Map regeneration can affect roads (and invalidates any cached paths).
                graph_version.bump();
            }
            // Traffic commands are handled by TrafficPlugin.
            // Traffic light commands are handled by IntersectionsPlugin.
            GameCommand::DumpSaveContract
            | GameCommand::SaveGame { .. }
            | GameCommand::LoadGame { .. }
            | GameCommand::LoadTestCity
            | GameCommand::PlaceTrafficLight { .. }
            | GameCommand::RemoveTrafficLight { .. } => {}
        }
    }
}
