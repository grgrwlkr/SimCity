//! 5.2 Zone placement constraints: zones can be painted only along roads.

use std::collections::HashSet;

use bevy::prelude::*;

use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::transport::GraphVersion;
use crate::game::ui_state::{ToolMode, UiState};

pub struct ZonePlacementPlugin;

impl Plugin for ZonePlacementPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ZonePlacementCache>()
            .add_systems(
                Update,
                update_zone_placement_cache
                    .in_set(GameSet::GraphUpdate)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                render_zone_placement_overlay
                    .in_set(GameSet::RenderSync)
                    .run_if(in_game_or_paused),
            );
    }
}

fn in_game_or_paused(state: Res<State<AppState>>) -> bool {
    matches!(state.get(), AppState::InGame | AppState::Paused)
}

/// Cache of valid positions for zoning (recomputed when roads change).
#[derive(Resource, Default)]
pub struct ZonePlacementCache {
    pub valid_positions: HashSet<TilePos>,
    pub graph_version: u64,
}

/// True if `pos` is eligible for zoning placement (R/C/I).
pub fn can_zone_tile(grid: &MapGrid, pos: TilePos) -> bool {
    let Some(cell) = grid.get(pos) else {
        return false;
    };

    if cell.water {
        return false;
    }
    if cell.road.is_some() {
        return false;
    }
    if cell.building.is_some() {
        return false;
    }

    has_adjacent_road(grid, pos)
}

fn has_adjacent_road(grid: &MapGrid, pos: TilePos) -> bool {
    for npos in [
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
    ] {
        if let Some(cell) = grid.get(npos)
            && !cell.water
            && cell.road.is_some()
        {
            return true;
        }
    }
    false
}

fn update_zone_placement_cache(
    grid: Res<MapGrid>,
    graph_version: Res<GraphVersion>,
    mut cache: ResMut<ZonePlacementCache>,
) {
    // Only recompute if roads changed.
    if cache.graph_version == graph_version.0 {
        return;
    }

    cache.valid_positions.clear();
    cache.graph_version = graph_version.0;

    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            if can_zone_tile(&grid, pos) {
                cache.valid_positions.insert(pos);
            }
        }
    }
}

#[derive(Component)]
struct ZonePlacementOverlayTile;

fn render_zone_placement_overlay(
    ui: Res<UiState>,
    cfg: Res<MapConfig>,
    cache: Res<ZonePlacementCache>,
    mut commands: Commands,
    existing: Query<Entity, With<ZonePlacementOverlayTile>>,
) {
    // Clear old overlay tiles.
    for e in existing.iter() {
        commands.entity(e).despawn();
    }

    // Show only for zone tools.
    if !matches!(
        ui.tool,
        ToolMode::Residential | ToolMode::Commercial | ToolMode::Industrial
    ) {
        return;
    }

    let origin = map_origin(&cfg);
    for pos in &cache.valid_positions {
        let world = origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size);
        commands.spawn((
            ZonePlacementOverlayTile,
            Sprite {
                color: Color::srgba(0.2, 0.8, 0.2, 0.25),
                custom_size: Some(Vec2::splat(cfg.tile_size)),
                ..default()
            },
            Transform::from_xyz(world.x, world.y, 3.0),
        ));
    }
}

fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::roads::{RoadCell, RoadDir, RoadKind};

    #[test]
    fn zoning_requires_adjacent_road_and_non_road_tile() {
        let mut grid = MapGrid::new(5, 5);

        // Place a road lane tile at (2,2).
        let mut road_cell = grid.get(TilePos { x: 2, y: 2 }).unwrap_or_default();
        road_cell.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::East,
            lane: 0,
        };
        grid.set(TilePos { x: 2, y: 2 }, road_cell);

        // Adjacent tile is valid.
        assert!(can_zone_tile(&grid, TilePos { x: 2, y: 3 }));

        // Non-adjacent tile is invalid.
        assert!(!can_zone_tile(&grid, TilePos { x: 0, y: 0 }));

        // Road tile itself is invalid.
        assert!(!can_zone_tile(&grid, TilePos { x: 2, y: 2 }));
    }
}
