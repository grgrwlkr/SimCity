//! 5.2 Zone placement constraints: zones can be painted only along roads.

use std::collections::HashSet;

use bevy::prelude::*;

use crate::game::map::{MapConfig, MapGrid, TilePos, tile_to_world};
use crate::game::render_primitives::{RenderPrimitives, layer};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::transport::GraphVersion;
use crate::game::ui_state::{ToolMode, UiState};

pub struct ZonePlacementPlugin;

impl Plugin for ZonePlacementPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ZonePlacementCache>()
            .init_resource::<ZonePlacementOverlayPool>()
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
/// Note: This does NOT check if a zone already exists - zones can be overwritten.
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

    // Clear and recompute cache when roads change.
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

#[derive(Resource, Default)]
struct ZonePlacementOverlayPool {
    entries: Vec<Entity>,
    last_enabled: bool,
    last_graph_version: u64,
    last_cfg_w: i32,
    last_cfg_h: i32,
    last_tile_size: f32,
}

#[allow(clippy::too_many_arguments)]
fn render_zone_placement_overlay(
    ui: Res<UiState>,
    cfg: Res<MapConfig>,
    cache: Res<ZonePlacementCache>,
    mut pool: ResMut<ZonePlacementOverlayPool>,
    mut commands: Commands,
    mut q_tiles: Query<
        (
            &mut MeshMaterial3d<StandardMaterial>,
            &mut Transform,
            &mut Visibility,
        ),
        With<ZonePlacementOverlayTile>,
    >,
    mut prims: ResMut<RenderPrimitives>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    // Show only for zone tools.
    let enabled = matches!(
        ui.tool,
        ToolMode::Residential | ToolMode::Commercial | ToolMode::Industrial
    );

    // If disabled, just hide existing pooled tiles (no despawn churn).
    if !enabled {
        if pool.last_enabled {
            for &e in pool.entries.iter() {
                if let Ok((_s, _t, mut v)) = q_tiles.get_mut(e) {
                    *v = Visibility::Hidden;
                }
            }
            pool.last_enabled = false;
        }
        return;
    }

    let cache_version = cache.graph_version;
    let cfg_changed = pool.last_cfg_w != cfg.width
        || pool.last_cfg_h != cfg.height
        || (pool.last_tile_size - cfg.tile_size).abs() > f32::EPSILON;
    let needs_rebuild =
        !pool.last_enabled || pool.last_graph_version != cache_version || cfg_changed;
    if !needs_rebuild {
        return;
    }

    let zone_mat = prims.material(&mut materials, Color::srgba(0.2, 0.8, 0.2, 0.25));
    let needed = cache.valid_positions.len();
    if pool.entries.len() < needed {
        let to_add = needed - pool.entries.len();
        pool.entries.reserve(to_add);
        for _ in 0..to_add {
            let e = commands
                .spawn((
                    ZonePlacementOverlayTile,
                    Mesh3d(prims.quad.clone()),
                    MeshMaterial3d(zone_mat.clone()),
                    Transform::from_xyz(0.0, 0.0, layer::ZONE_OVERLAY)
                        .with_scale(Vec2::splat(cfg.tile_size).extend(1.0)),
                    Visibility::Hidden,
                ))
                .id();
            pool.entries.push(e);
        }
    }

    // Assign visible overlay tiles to the cached positions.
    let mut i = 0usize;
    for pos in &cache.valid_positions {
        if i >= pool.entries.len() {
            break;
        }
        let e = pool.entries[i];
        if let Ok((mut mat, mut tf, mut vis)) = q_tiles.get_mut(e) {
            mat.0 = zone_mat.clone();
            let world = tile_to_world(&cfg, *pos);
            tf.translation.x = world.x;
            tf.translation.y = world.y;
            tf.translation.z = layer::ZONE_OVERLAY;
            tf.scale = Vec2::splat(cfg.tile_size).extend(1.0);
            *vis = Visibility::Visible;
        }
        i += 1;
    }

    // Hide any unused pooled entities.
    for &e in pool.entries[i..].iter() {
        if let Ok((_m, _t, mut vis)) = q_tiles.get_mut(e) {
            *vis = Visibility::Hidden;
        }
    }

    pool.last_enabled = true;
    pool.last_graph_version = cache_version;
    pool.last_cfg_w = cfg.width;
    pool.last_cfg_h = cfg.height;
    pool.last_tile_size = cfg.tile_size;
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
            flow: crate::game::roads::RoadFlow::TwoWay,
            lane_type: crate::game::roads::LaneType::Regular,
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
