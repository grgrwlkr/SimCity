use std::collections::HashMap;

use bevy::prelude::*;

use crate::game::buildings::Building;
use crate::game::command_history::CommandHistory;
use crate::game::roads::RoadDir;
use crate::game::sets::GameSet;
use crate::game::state::AppState;

mod types;
pub use types::{
    BuildMode, BuildTool, BuildingKind, HoveredTile, MapConfig, TileKind, TilePos, ZoneKind,
};

mod grid;
pub use grid::{MapCell, MapGrid, MapSeed};

mod dirty;
use dirty::RoadDirtyTiles;
pub use dirty::{DirtyTiles, MapEditVersion};

mod lane_markings;
use lane_markings::{LaneMarkingIndex, sync_lane_markings};

mod road_preview;
use road_preview::{RoadPreviewPool, road_preview_render};

mod coords;
use coords::cursor_tile;

mod generation;

mod commands;
use commands::apply_game_commands_to_grid;
pub(crate) use commands::spawn_building_entity;

mod input;
use input::{
    CursorPaintState, RoadBuildState, build_mode_hotkeys, cursor_paint_to_command,
    handle_undo_redo, sync_build_mode_from_ui, update_cursor_highlight, update_hovered_tile,
};

mod render;
use render::{
    LastOverlayMode, RouteGizmos, configure_route_gizmos, cull_tile_chunks,
    mark_dirty_on_overlay_change, spawn_map_if_needed, sync_dirty_tiles_to_render,
    vehicle_routes_overlay_render,
};

pub struct MapPlugin;

impl Plugin for MapPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(MapConfig::default())
            .insert_resource(CommandHistory::new(100))
            .init_gizmo_group::<RouteGizmos>()
            .add_systems(Startup, (init_map_grid, configure_route_gizmos))
            .init_resource::<MapIndex>()
            .init_resource::<BuildMode>()
            .init_resource::<CursorPaintState>()
            .init_resource::<RoadBuildState>()
            .init_resource::<MapEditVersion>()
            .init_resource::<HoveredTile>()
            .init_resource::<LastOverlayMode>()
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
                    sync_build_mode_from_ui.after(build_mode_hotkeys),
                    handle_undo_redo.after(sync_build_mode_from_ui),
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
pub(crate) struct BuildingEntityIndex {
    width: i32,
    height: i32,
    /// Dense tile-indexed lookup (avoids hashing in the UI inspector hot path).
    by_pos: Vec<Option<Entity>>,
    /// Reverse lookup to delete entries when entities despawn.
    by_entity: HashMap<Entity, usize>,
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

    pub(crate) fn get(&self, pos: TilePos) -> Option<Entity> {
        if pos.x < 0 || pos.y < 0 || pos.x >= self.width || pos.y >= self.height {
            return None;
        }
        let idx = (pos.y as usize) * (self.width as usize) + (pos.x as usize);
        self.by_pos.get(idx).copied().flatten()
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
        let Some(pos_idx) = grid.idx(b.pos) else {
            continue;
        };

        // If this entity was previously tracked at some other tile, clear that old mapping.
        if let Some(old_idx) = index.by_entity.insert(e, pos_idx)
            && index.by_pos.get(old_idx).copied().flatten() == Some(e)
        {
            index.by_pos[old_idx] = None;
        }

        // New buildings win for the purpose of UI lookups (duplicates should not happen).
        if let Some(prev) = index.by_pos[pos_idx].replace(e)
            && prev != e
        {
            index.by_entity.remove(&prev);
        }
    }

    for e in removed.read() {
        let Some(pos_idx) = index.by_entity.remove(&e) else {
            continue;
        };
        if index.by_pos.get(pos_idx).copied().flatten() == Some(e) {
            index.by_pos[pos_idx] = None;
        }
    }
}

// (moved to `map/coords.rs` and `map/render.rs`)

#[cfg(test)]
mod tests;
