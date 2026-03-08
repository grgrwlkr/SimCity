use bevy::prelude::*;

use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::ui_state::{OverlayMode, UiState};

use super::TrafficOccupancy;

/// Marker for road tile overlays that show traffic heat.
#[derive(Component)]
pub(super) struct TrafficOverlayTile;

/// Cached entities for the traffic overlay to avoid per-frame spawn/despawn churn.
#[derive(Resource, Default)]
pub(super) struct TrafficOverlayPool {
    pub(super) entries: Vec<(Entity, usize)>, // (entity, grid_idx)
    pub(super) grid_len: usize,
}

/// Render traffic overlay on road tiles.
pub(super) fn render_traffic_overlay(
    ui: Res<UiState>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    occ: Res<TrafficOccupancy>,
    mut commands: Commands,
    mut pool: ResMut<TrafficOverlayPool>,
    mut q_sprites: Query<&mut Sprite, With<TrafficOverlayTile>>,
) {
    if ui.overlay != OverlayMode::Traffic {
        // Overlay disabled: despawn cached overlay entities once.
        if !pool.entries.is_empty() {
            for (e, _) in pool.entries.drain(..) {
                commands.entity(e).despawn();
            }
            pool.grid_len = 0;
        }
        return;
    }

    if occ.per_tick_vehicles.len() != grid.len() {
        return;
    }

    let max_heat = occ.max_heat().max(0.001);

    let origin = super::map_origin(&cfg);

    // (Re)build cached overlay entities if needed.
    if pool.entries.is_empty() || pool.grid_len != grid.len() {
        // Clear any stale entities.
        for (e, _) in pool.entries.drain(..) {
            commands.entity(e).despawn();
        }
        pool.grid_len = grid.len();

        for y in 0..grid.height {
            for x in 0..grid.width {
                let pos = TilePos { x, y };
                let Some(idx) = grid.idx(pos) else {
                    continue;
                };
                let Some(cell) = grid.get(pos) else {
                    continue;
                };
                if !cell.road.is_some() {
                    continue;
                }

                let world = origin + Vec2::new(x as f32 * cfg.tile_size, y as f32 * cfg.tile_size);

                let e = commands
                    .spawn((
                        TrafficOverlayTile,
                        Sprite {
                            color: Color::linear_rgb(0.0, 1.0, 0.0),
                            custom_size: Some(Vec2::splat(cfg.tile_size * 0.85)),
                            ..default()
                        },
                        Transform::from_xyz(world.x, world.y, 5.0),
                    ))
                    .id();
                pool.entries.push((e, idx));
            }
        }
    }

    // Update overlay colors without respawning entities (prevents flicker and reduces CPU churn).
    for (e, idx) in pool.entries.iter().copied() {
        let Ok(mut sprite) = q_sprites.get_mut(e) else {
            continue;
        };
        let heat = (occ.heat_idx(idx) / max_heat).clamp(0.0, 1.0);
        sprite.color = Color::linear_rgb(heat, 1.0 - heat, 0.0);
    }
}
