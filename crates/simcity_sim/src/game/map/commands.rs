use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::buildings::{
    Building, BuildingPhase, calculate_parking_spots, for_each_footprint_tile,
};
use crate::game::command_history::{CommandHistory, UndoableCommand};
use crate::game::commands::{GameCommand, UndoRedoRequested};
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

/// Manual (service) building placement footprint — the single source for the
/// UI pre-check, the command apply and entity spawn. Literal drift between
/// those sites silently reintroduces the UI/apply validation divergence.
pub(crate) const MANUAL_BUILDING_FOOTPRINT: (u8, u8) = (3, 3);

pub(crate) fn spawn_building_entity(
    commands: &mut Commands,
    cfg: &MapConfig,
    pos: TilePos,
    kind: BuildingKind,
    city: &City,
) -> Entity {
    let (footprint_width, footprint_length) = MANUAL_BUILDING_FOOTPRINT;
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
    mut undo_reader: MessageReader<UndoRedoRequested>,
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
    mut bus_routes: Option<ResMut<crate::game::public_transport::BusRouteManager>>,
    q_buildings: Query<(Entity, &Building)>,
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
                let (footprint_width, footprint_length) = MANUAL_BUILDING_FOOTPRINT;
                let anchor = pos;

                let Some(footprint_tiles) =
                    validate_building_placement(&grid, anchor, footprint_width, footprint_length)
                else {
                    continue;
                };

                let cost = kind.build_cost();
                if city.money < cost {
                    continue;
                }

                // Save the zones the placement is about to clear for undo.
                let old_zones: Vec<(TilePos, ZoneKind)> = footprint_tiles
                    .iter()
                    .filter_map(|t| grid.get(*t).map(|c| (*t, c.zone)))
                    .collect();

                // Save command to history before applying
                history.push(UndoableCommand::PlaceBuilding {
                    pos: anchor,
                    kind,
                    old_zones,
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

                // Nothing to erase — a no-op entry would wipe the redo stack and
                // evict real entries when drag-erasing across empty land.
                if !old_road.is_some() && old_zone == ZoneKind::None && cell.building.is_none() {
                    continue;
                }

                // Erasing any cell of a building footprint removes the WHOLE
                // building; clearing a single cell would orphan the remaining
                // footprint cells as permanently un-buildable phantoms.
                let mut old_building: Option<Building> = None;
                if cell.building.is_some()
                    && let Some((entity, b)) = building_containing(&q_buildings, pos)
                {
                    erase_building_cells(&mut grid, &mut dirty, &b);
                    commands.entity(entity).despawn();
                    old_building = Some(b);
                }

                // Save command to history before applying
                history.push(UndoableCommand::EraseTile {
                    pos,
                    old_road,
                    old_zone,
                    old_building,
                });

                let road_changed = cell.road.is_some();
                // Re-read: the whole-building erase above may have touched this cell.
                cell = grid.get(pos).unwrap_or_default();
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
                // History entries were recorded against the OLD grid; exact-restore
                // would stamp stale cells into the new map validation-free (even
                // roads onto water). Same rule as LoadGame/LoadTestCity.
                history.clear();
                // Bus routes reference the old map's tiles — clear them on regeneration.
                if let Some(mgr) = bus_routes.as_mut() {
                    mgr.reset();
                }
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

    // Undo/redo requests are applied here (the owner of CommandHistory), NOT
    // replayed as GameCommands: replay would re-record history (wiping the redo
    // stack it just created) and get rejected by the user-facing build rules.
    for req in undo_reader.read() {
        let entry = if req.redo {
            history.redo()
        } else {
            history.undo()
        };
        let Some(entry) = entry else {
            continue;
        };
        apply_history_entry(
            &entry,
            req.redo,
            &mut commands,
            &cfg,
            &mut grid,
            &mut dirty,
            &mut road_dirty,
            &city,
            &mut graph_version,
            &mut map_edit_version,
            &q_buildings,
        );
    }
}

/// Validate a manual building placement.
///
/// Every footprint tile must exist and be free (no water, no road, no existing
/// building); road access is required for the footprint AS A WHOLE — at least
/// one footprint tile 4-adjacent to a road. A per-tile road requirement is
/// unsatisfiable: the center of a 3x3 footprint only neighbours other footprint
/// tiles, which must be road-free. Any adjacent road is necessarily outside the
/// footprint because footprint tiles themselves must be road-free.
///
/// Returns the footprint tiles on success.
pub(super) fn validate_building_placement(
    grid: &MapGrid,
    anchor: TilePos,
    width: u8,
    length: u8,
) -> Option<Vec<TilePos>> {
    let mut tiles = Vec::with_capacity((width as usize) * (length as usize));
    for dx in 0..(width as i32) {
        for dy in 0..(length as i32) {
            let tile = TilePos {
                x: anchor.x + dx,
                y: anchor.y + dy,
            };
            let cell = grid.get(tile)?;
            if cell.water || cell.road.is_some() || cell.building.is_some() {
                return None;
            }
            tiles.push(tile);
        }
    }
    tiles
        .iter()
        .any(|t| has_adjacent_road(grid, *t))
        .then_some(tiles)
}

fn has_adjacent_road(grid: &MapGrid, pos: TilePos) -> bool {
    [
        TilePos {
            x: pos.x - 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x + 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x,
            y: pos.y - 1,
        },
        TilePos {
            x: pos.x,
            y: pos.y + 1,
        },
    ]
    .into_iter()
    .any(|npos| {
        grid.get(npos)
            .is_some_and(|cell| !cell.water && cell.road.is_some())
    })
}

/// Find the building entity whose footprint contains `pos`.
fn building_containing(
    q_buildings: &Query<(Entity, &Building)>,
    pos: TilePos,
) -> Option<(Entity, Building)> {
    q_buildings
        .iter()
        .find(|(_, b)| {
            pos.x >= b.anchor_pos.x
                && pos.y >= b.anchor_pos.y
                && pos.x < b.anchor_pos.x + b.footprint_width as i32
                && pos.y < b.anchor_pos.y + b.footprint_length as i32
        })
        .map(|(e, b)| (e, b.clone()))
}

/// Clear the building layer of all footprint cells of `b`.
fn erase_building_cells(grid: &mut MapGrid, dirty: &mut DirtyTiles, b: &Building) {
    for_each_footprint_tile(
        b.anchor_pos,
        b.footprint_width,
        b.footprint_length,
        |tile| {
            if let Some(mut cell) = grid.get(tile)
                && cell.building == Some(b.kind)
            {
                cell.building = None;
                grid.set(tile, cell);
                if let Some(idx) = grid.idx(tile) {
                    dirty.mark(idx);
                }
            }
        },
    );
}

/// Clear any building occupying `tile` before an exact-restore writes over it.
/// Sim growth mutates cells WITHOUT history entries, so a restored snapshot can
/// land on top of a building that did not exist when the entry was recorded;
/// overwriting one layer blindly would orphan the rest of that building's
/// footprint as phantom un-buildable cells. A live owner is whole-erased
/// (footprint + entity); an already-orphaned cell (no owning entity) is cleared
/// in place.
fn clear_building_at(
    commands: &mut Commands,
    grid: &mut MapGrid,
    dirty: &mut DirtyTiles,
    q_buildings: &Query<(Entity, &Building)>,
    tile: TilePos,
) {
    if grid.get(tile).is_none_or(|c| c.building.is_none()) {
        return;
    }
    if let Some((entity, b)) = building_containing(q_buildings, tile) {
        erase_building_cells(grid, dirty, &b);
        commands.entity(entity).despawn();
    }
    if let Some(mut cell) = grid.get(tile)
        && cell.building.is_some()
    {
        cell.building = None;
        grid.set(tile, cell);
        if let Some(idx) = grid.idx(tile) {
            dirty.mark(idx);
        }
    }
}

/// Respawn a building entity from a saved `Building` component (undo of erase).
/// The component is restored verbatim so level/phase/occupancy survive.
fn respawn_building_entity(commands: &mut Commands, cfg: &MapConfig, b: &Building) -> Entity {
    let origin = map_origin(cfg);
    let center_x = b.anchor_pos.x as f32 + (b.footprint_width as f32 - 1.0) * 0.5;
    let center_y = b.anchor_pos.y as f32 + (b.footprint_length as f32 - 1.0) * 0.5;
    let world = origin + Vec2::new(center_x * cfg.tile_size, center_y * cfg.tile_size);
    let sprite_size = Vec2::new(
        b.footprint_width as f32 * cfg.tile_size,
        b.footprint_length as f32 * cfg.tile_size,
    );
    commands
        .spawn((
            b.clone(),
            Sprite::from_color(b.kind.color(), sprite_size),
            Transform::from_translation(Vec3::new(world.x, world.y, 8.0)),
        ))
        .id()
}

/// Exact-restore a road cell for undo/redo. Bypasses the user-facing build
/// rules on purpose (empty cells and downgrades must be restorable), but keeps
/// all side effects: dirty marks + graph/map version bumps.
fn restore_road_cell(
    grid: &mut MapGrid,
    dirty: &mut DirtyTiles,
    road_dirty: &mut RoadDirtyTiles,
    graph_version: &mut GraphVersion,
    map_edit_version: &mut MapEditVersion,
    pos: TilePos,
    road: RoadCell,
) {
    let Some(idx) = grid.idx(pos) else {
        return;
    };
    let mut cell = grid.get(pos).unwrap_or_default();
    if cell.road == road {
        return;
    }
    cell.road = road;
    grid.set(pos, cell);
    dirty.mark(idx);
    road_dirty.mark(idx);
    map_edit_version.bump();
    graph_version.bump();
}

/// Exact-restore a zone cell for undo/redo (bypasses zoning adjacency rules).
fn restore_zone_cell(
    grid: &mut MapGrid,
    dirty: &mut DirtyTiles,
    map_edit_version: &mut MapEditVersion,
    pos: TilePos,
    zone: ZoneKind,
) {
    let Some(idx) = grid.idx(pos) else {
        return;
    };
    let mut cell = grid.get(pos).unwrap_or_default();
    if cell.zone == zone {
        return;
    }
    cell.zone = zone;
    grid.set(pos, cell);
    dirty.mark(idx);
    map_edit_version.bump();
}

/// Apply a history entry in exact-restore mode: `forward == false` restores the
/// captured pre-state (undo), `forward == true` re-applies the post-state
/// (redo). Never records new history — `CommandHistory::undo/redo` already
/// moved the entry between stacks.
#[allow(clippy::too_many_arguments)]
fn apply_history_entry(
    entry: &UndoableCommand,
    forward: bool,
    commands: &mut Commands,
    cfg: &MapConfig,
    grid: &mut MapGrid,
    dirty: &mut DirtyTiles,
    road_dirty: &mut RoadDirtyTiles,
    city: &City,
    graph_version: &mut GraphVersion,
    map_edit_version: &mut MapEditVersion,
    q_buildings: &Query<(Entity, &Building)>,
) {
    match entry {
        UndoableCommand::SetRoad { pos, old, new } => {
            let road = if forward { *new } else { *old };
            clear_building_at(commands, grid, dirty, q_buildings, *pos);
            restore_road_cell(
                grid,
                dirty,
                road_dirty,
                graph_version,
                map_edit_version,
                *pos,
                road,
            );
        }
        UndoableCommand::SetZone { pos, old, new } => {
            let zone = if forward { *new } else { *old };
            clear_building_at(commands, grid, dirty, q_buildings, *pos);
            restore_zone_cell(grid, dirty, map_edit_version, *pos, zone);
        }
        UndoableCommand::PlaceBuilding {
            pos,
            kind,
            old_zones,
        } => {
            if forward {
                for (tile, _) in old_zones {
                    // A building may have grown here since the entry was recorded.
                    clear_building_at(commands, grid, dirty, q_buildings, *tile);
                    if let Some(mut cell) = grid.get(*tile) {
                        cell.building = Some(*kind);
                        cell.zone = ZoneKind::None;
                        grid.set(*tile, cell);
                        if let Some(idx) = grid.idx(*tile) {
                            dirty.mark(idx);
                        }
                    }
                }
                map_edit_version.bump();
                let _ = spawn_building_entity(commands, cfg, *pos, *kind, city);
            } else {
                // Whole-erases the placed building itself AND any building that
                // grew over these tiles since (partial overwrite would orphan
                // the outside cells of the grown footprint).
                for (tile, _) in old_zones {
                    clear_building_at(commands, grid, dirty, q_buildings, *tile);
                }
                for (tile, zone) in old_zones {
                    if let Some(mut cell) = grid.get(*tile) {
                        cell.building = None;
                        cell.zone = *zone;
                        grid.set(*tile, cell);
                        if let Some(idx) = grid.idx(*tile) {
                            dirty.mark(idx);
                        }
                    }
                }
                map_edit_version.bump();
            }
        }
        UndoableCommand::EraseTile {
            pos,
            old_road,
            old_zone,
            old_building,
        } => {
            if forward {
                // Re-erase: remove the (restored) building, then clear the tile.
                // Cells are cleared from the snapshot (not the entity lookup) so
                // the footprint cannot survive as phantoms even if the restored
                // entity's spawn is still deferred this frame.
                if let Some(b) = old_building {
                    erase_building_cells(grid, dirty, b);
                    if let Some((entity, _)) = building_containing(q_buildings, *pos) {
                        commands.entity(entity).despawn();
                    }
                }
                if let Some(idx) = grid.idx(*pos) {
                    let mut cell = grid.get(*pos).unwrap_or_default();
                    let road_changed = cell.road.is_some();
                    cell.road = RoadCell::none();
                    cell.zone = ZoneKind::None;
                    cell.building = None;
                    grid.set(*pos, cell);
                    dirty.mark(idx);
                    map_edit_version.bump();
                    if road_changed {
                        graph_version.bump();
                        road_dirty.mark(idx);
                    }
                }
            } else {
                restore_road_cell(
                    grid,
                    dirty,
                    road_dirty,
                    graph_version,
                    map_edit_version,
                    *pos,
                    *old_road,
                );
                restore_zone_cell(grid, dirty, map_edit_version, *pos, *old_zone);
                if let Some(b) = old_building {
                    // A different building may have (re)grown over parts of the
                    // old footprint since the erase — whole-erase it first so
                    // its non-overlapping cells don't survive as phantoms.
                    for_each_footprint_tile(
                        b.anchor_pos,
                        b.footprint_width,
                        b.footprint_length,
                        |tile| clear_building_at(commands, grid, dirty, q_buildings, tile),
                    );
                    for_each_footprint_tile(
                        b.anchor_pos,
                        b.footprint_width,
                        b.footprint_length,
                        |tile| {
                            if let Some(mut cell) = grid.get(tile) {
                                cell.building = Some(b.kind);
                                grid.set(tile, cell);
                                if let Some(idx) = grid.idx(tile) {
                                    dirty.mark(idx);
                                }
                            }
                        },
                    );
                    map_edit_version.bump();
                    let _ = respawn_building_entity(commands, cfg, b);
                }
            }
        }
    }
}
