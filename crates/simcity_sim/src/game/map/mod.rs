use std::collections::HashMap;

use bevy::prelude::*;

use crate::game::buildings::{Building, for_each_footprint_tile};
use crate::game::command_history::CommandHistory;
use crate::game::roads::RoadDir;
use crate::game::sets::GameSet;
use crate::game::state::AppState;

mod types;
pub use types::{BuildingKind, HoveredTile, MapConfig, TileKind, TilePos, ZoneKind};

mod grid;
pub use grid::{MapCell, MapGrid, MapSeed};

mod dirty;
pub use dirty::{DirtyTiles, MapEditVersion, RoadDirtyTiles};

mod lane_markings;
use lane_markings::{LaneMarkingIndex, sync_lane_markings};

mod road_preview;
use road_preview::{RoadPreviewPool, road_preview_render};

mod coords;
use coords::cursor_tile;
pub use coords::{map_origin, tile_f_to_world, tile_to_world, world_to_tile};

mod generation;

mod commands;
use commands::apply_game_commands_to_grid;

mod input;
use input::{
    CursorPaintState, RoadBuildState, build_mode_hotkeys, cursor_paint_to_command,
    handle_undo_redo, update_cursor_highlight, update_hovered_tile,
};

mod render;
use render::{
    LastOverlayMode, OverlayIndexVersions, RouteGizmos, configure_route_gizmos, cull_tile_chunks,
    mark_dirty_on_index_publish, mark_dirty_on_overlay_change, spawn_map_if_needed,
    sync_dirty_tiles_to_render, vehicle_routes_overlay_render,
};

pub struct MapPlugin;

impl Plugin for MapPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(MapConfig::default())
            .insert_resource(CommandHistory::new(100))
            .init_gizmo_group::<RouteGizmos>()
            .add_systems(Startup, (init_map_grid, configure_route_gizmos))
            .init_resource::<MapIndex>()
            .init_resource::<CursorPaintState>()
            .init_resource::<RoadBuildState>()
            .init_resource::<MapEditVersion>()
            .init_resource::<HoveredTile>()
            .init_resource::<LastOverlayMode>()
            .init_resource::<OverlayIndexVersions>()
            .init_resource::<BuildingEntityIndex>()
            .init_resource::<LaneMarkingIndex>()
            .init_resource::<RoadPreviewPool>()
            .add_systems(OnEnter(AppState::InGame), spawn_map_if_needed)
            .add_systems(
                OnEnter(AppState::MainMenu),
                (
                    cleanup_ingame_entities,
                    clear_building_entity_index,
                    clear_map_render_caches,
                ),
            )
            // Input
            .add_systems(
                Update,
                (
                    build_mode_hotkeys,
                    handle_undo_redo.after(build_mode_hotkeys),
                )
                    .in_set(GameSet::Input)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                (
                    update_cursor_highlight,
                    update_hovered_tile,
                    cursor_paint_to_command,
                )
                    .in_set(GameSet::Input)
                    .run_if(in_game_or_paused),
            )
            // Apply commands
            .add_systems(
                Update,
                apply_game_commands_to_grid
                    .in_set(GameSet::CommandApply)
                    .run_if(in_game_or_paused),
            )
            // Render sync / overlays
            .add_systems(
                Update,
                mark_dirty_on_overlay_change
                    .in_set(GameSet::RenderSync)
                    .before(sync_dirty_tiles_to_render)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                mark_dirty_on_index_publish
                    .in_set(GameSet::RenderSync)
                    .before(sync_dirty_tiles_to_render)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                track_building_entity_index
                    .in_set(GameSet::RenderSync)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                cull_tile_chunks
                    .in_set(GameSet::RenderSync)
                    .before(sync_dirty_tiles_to_render)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                sync_dirty_tiles_to_render
                    .in_set(GameSet::RenderSync)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                vehicle_routes_overlay_render
                    .in_set(GameSet::RenderSync)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                road_preview_render
                    .in_set(GameSet::RenderSync)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                sync_lane_markings
                    .in_set(GameSet::RenderSync)
                    .after(sync_dirty_tiles_to_render)
                    .run_if(in_game_or_paused),
            );
    }
}

#[derive(Component)]
struct InGameEntity;

#[derive(Resource, Default)]
pub struct BuildingEntityIndex {
    width: i32,
    height: i32,
    /// Dense tile-indexed lookup (avoids hashing in the UI inspector hot path).
    by_pos: Vec<Option<Entity>>,
    /// Reverse lookup to delete entries when entities despawn.
    by_entity: HashMap<Entity, Vec<usize>>,
}

impl BuildingEntityIndex {
    fn ensure_sized(&mut self, grid: &MapGrid) {
        if self.width == grid.width && self.height == grid.height && self.by_pos.len() == grid.len()
        {
            return;
        }

        self.width = grid.width;
        self.height = grid.height;
        self.by_pos = vec![None; grid.len()];
        self.by_entity.clear();
    }

    pub fn get(&self, pos: TilePos) -> Option<Entity> {
        if pos.x < 0 || pos.y < 0 || pos.x >= self.width || pos.y >= self.height {
            return None;
        }
        let idx = (pos.y as usize) * (self.width as usize) + (pos.x as usize);
        self.by_pos.get(idx).copied().flatten()
    }

    fn remove_entity(&mut self, e: Entity) {
        let Some(idxs) = self.by_entity.remove(&e) else {
            return;
        };
        for idx in idxs {
            if self.by_pos.get(idx).copied().flatten() == Some(e) {
                self.by_pos[idx] = None;
            }
        }
    }

    fn insert_footprint(&mut self, e: Entity, b: &Building, grid: &MapGrid) {
        // Ensure we don't leave stale mappings if this entity was re-used.
        self.remove_entity(e);

        let mut idxs: Vec<usize> = Vec::new();
        for_each_footprint_tile(
            b.anchor_pos,
            b.footprint_width,
            b.footprint_length,
            |tile| {
                let Some(tile_idx) = grid.idx(tile) else {
                    return;
                };

                // If another building was mapped here, detach it.
                if let Some(prev) = self.by_pos[tile_idx].replace(e)
                    && prev != e
                    && let Some(prev_idxs) = self.by_entity.get_mut(&prev)
                {
                    if let Some(i) = prev_idxs.iter().position(|x| *x == tile_idx) {
                        prev_idxs.swap_remove(i);
                    }
                    if prev_idxs.is_empty() {
                        self.by_entity.remove(&prev);
                    }
                }

                idxs.push(tile_idx);
            },
        );

        if !idxs.is_empty() {
            self.by_entity.insert(e, idxs);
        }
    }
}

#[derive(Resource, Default)]
pub struct MapIndex {
    tiles: Vec<Entity>,
}

fn cleanup_ingame_entities(mut commands: Commands, q: Query<Entity, With<InGameEntity>>) {
    for e in &q {
        commands.entity(e).despawn();
    }
}

fn clear_map_render_caches(
    mut map_index: ResMut<MapIndex>,
    mut lane_markings: ResMut<LaneMarkingIndex>,
    mut preview_pool: ResMut<RoadPreviewPool>,
    road_dirty: Option<ResMut<RoadDirtyTiles>>,
) {
    map_index.tiles.clear();
    lane_markings.by_pos.clear();
    preview_pool.entities.clear();
    // Ensure no leftover "dirty roads" survive between sessions.
    if let Some(mut road_dirty) = road_dirty {
        let mut tmp = Vec::new();
        road_dirty.drain_into(&mut tmp);
    }
}

fn init_map_grid(mut commands: Commands, cfg: Res<MapConfig>) {
    let grid = MapGrid::new(cfg.width, cfg.height);
    let dirty = DirtyTiles::new((cfg.width as usize) * (cfg.height as usize));
    let road_dirty = RoadDirtyTiles::new((cfg.width as usize) * (cfg.height as usize));
    commands.insert_resource(grid);
    commands.insert_resource(dirty);
    commands.insert_resource(road_dirty);
    commands.insert_resource(MapSeed(1));
}

fn in_game_or_paused(state: Res<State<AppState>>) -> bool {
    matches!(state.get(), AppState::InGame | AppState::Paused)
}

fn clear_building_entity_index(mut index: ResMut<BuildingEntityIndex>) {
    index.width = 0;
    index.height = 0;
    index.by_pos.clear();
    index.by_entity.clear();
}

/// Maintains `BuildingEntityIndex` incrementally using ECS change detection.
///
/// This avoids full-world scans / full-map traversals just to serve UI inspector lookups.
fn track_building_entity_index(
    mut index: ResMut<BuildingEntityIndex>,
    grid: Res<MapGrid>,
    q_added: Query<(Entity, &Building), Added<Building>>,
    mut removed: RemovedComponents<Building>,
) {
    index.ensure_sized(&grid);

    for (e, b) in q_added.iter() {
        index.insert_footprint(e, b, &grid);
    }

    for e in removed.read() {
        index.remove_entity(e);
    }
}

// (moved to `map/coords.rs` and `map/render.rs`)

#[cfg(test)]
mod tests;
