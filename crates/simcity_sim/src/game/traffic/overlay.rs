use bevy::prelude::*;

use crate::game::map::{MapConfig, MapGrid, TilePos, tile_to_world};
use crate::game::render_primitives::{RenderPrimitives, layer};
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
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(super) fn render_traffic_overlay(
    ui: Res<UiState>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    occ: Res<TrafficOccupancy>,
    mut commands: Commands,
    mut pool: ResMut<TrafficOverlayPool>,
    mut q_mats: Query<&mut MeshMaterial3d<StandardMaterial>, With<TrafficOverlayTile>>,
    mut prims: ResMut<RenderPrimitives>,
    mut materials: ResMut<Assets<StandardMaterial>>,
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

                let world = tile_to_world(&cfg, pos);

                let e = commands
                    .spawn((
                        TrafficOverlayTile,
                        Mesh3d(prims.quad.clone()),
                        MeshMaterial3d(
                            prims.material(&mut materials, Color::linear_rgb(0.0, 1.0, 0.0)),
                        ),
                        Transform::from_xyz(world.x, world.y, layer::TRAFFIC_HEAT)
                            .with_scale(Vec2::splat(cfg.tile_size * 0.85).extend(1.0)),
                    ))
                    .id();
                pool.entries.push((e, idx));
            }
        }
    }

    // Update overlay colors without respawning entities (prevents flicker and reduces CPU churn).
    for (e, idx) in pool.entries.iter().copied() {
        let Ok(mut mat) = q_mats.get_mut(e) else {
            continue;
        };
        // The material cache quantizes to 8-bit RGBA, so the gradient stays bounded.
        let heat = (occ.heat_idx(idx) / max_heat).clamp(0.0, 1.0);
        mat.0 = prims.material(&mut materials, Color::linear_rgb(heat, 1.0 - heat, 0.0));
    }
}
