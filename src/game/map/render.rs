use std::collections::HashMap;

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::window::PrimaryWindow;

use crate::game::camera::MainCamera;
use crate::game::land_value::LandValueIndex;
use crate::game::pollution::PollutionIndex;
use crate::game::state::AppState;
use crate::game::transport::PathPool;
use crate::game::traffic::{Parked, Vehicle};
use crate::game::transport::PathPool;
use crate::game::ui_state::{OverlayMode, UiState};

use super::coords::map_origin;
use super::generation::generate_map_into_grid;
use super::input::CursorHighlight;
use super::{DirtyTiles, InGameEntity, MapConfig, MapGrid, MapIndex, MapSeed, TileKind, TilePos};

/// Chunk size for map tile sprite culling (performance).
const TILE_CHUNK_SIZE: i32 = 16;

#[derive(Component, Debug, Copy, Clone)]
pub(super) struct TileChunkRoot {
    cx: i32,
    cy: i32,
}

#[derive(Resource, Debug, Copy, Clone)]
pub(super) struct LastOverlayMode(pub(super) OverlayMode);

impl Default for LastOverlayMode {
    fn default() -> Self {
        Self(OverlayMode::None)
    }
}

/// Gizmo group for vehicle route overlays (Path overlay mode).
#[derive(Default, Reflect, GizmoConfigGroup)]
pub(super) struct RouteGizmos {}

pub(super) fn configure_route_gizmos(store: Option<ResMut<GizmoConfigStore>>) {
    let Some(mut store) = store else {
        return;
    };
    let (config, _) = store.config_mut::<RouteGizmos>();
    config.enabled = true;
    // Slightly thinner than default.
    config.line.width = 1.0;
}

pub(super) fn spawn_map_if_needed(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    seed: Res<MapSeed>,
    mut grid: ResMut<MapGrid>,
    mut index: ResMut<MapIndex>,
    q_tiles: Query<Entity, With<TilePos>>,
    mut dirty: ResMut<DirtyTiles>,
) {
    if !q_tiles.is_empty() {
        return;
    }

    index.tiles.clear();
    index
        .tiles
        .reserve((cfg.width as usize).saturating_mul(cfg.height as usize));

    // Auto-generate terrain on first enter so the player doesn't start on a flat blank map.
    generate_map_into_grid(&mut grid, seed.0);

    // Chunk roots (used for culling large off-screen tile groups).
    let chunks_x = (cfg.width + TILE_CHUNK_SIZE - 1) / TILE_CHUNK_SIZE;
    let chunks_y = (cfg.height + TILE_CHUNK_SIZE - 1) / TILE_CHUNK_SIZE;
    let mut chunks = HashMap::<IVec2, Entity>::new();
    for cy in 0..chunks_y {
        for cx in 0..chunks_x {
            let e = commands
                .spawn((
                    TileChunkRoot { cx, cy },
                    Transform::default(),
                    Visibility::Visible,
                    InGameEntity,
                ))
                .id();
            chunks.insert(IVec2::new(cx, cy), e);
        }
    }

    let origin = map_origin(&cfg);
    for y in 0..cfg.height {
        for x in 0..cfg.width {
            let kind = TileKind::Grass;
            let world = origin + Vec2::new(x as f32 * cfg.tile_size, y as f32 * cfg.tile_size);

            let cx = x / TILE_CHUNK_SIZE;
            let cy = y / TILE_CHUNK_SIZE;
            let Some(&parent) = chunks.get(&IVec2::new(cx, cy)) else {
                continue;
            };

            let e = commands
                .spawn((
                    Sprite::from_color(kind.color(), Vec2::splat(cfg.tile_size - 1.0)),
                    Transform::from_translation(world.extend(0.0)),
                    TilePos { x, y },
                    kind,
                    InGameEntity,
                ))
                .id();
            // Parent under chunk root for cheap culling.
            // NOTE: we avoid `set_parent_in_place` here: it relies on `GlobalTransform` being
            // up-to-date at spawn time, which is not guaranteed.
            commands.entity(parent).add_child(e);

            // Tiles are spawned in row-major order; this matches `MapGrid::idx`.
            index.tiles.push(e);
        }
    }

    commands.spawn((
        Sprite::from_color(
            Color::srgba(1.0, 1.0, 1.0, 0.25),
            Vec2::splat(cfg.tile_size + 2.0),
        ),
        Transform::from_translation(Vec3::new(0.0, 0.0, 10.0)),
        CursorHighlight,
        InGameEntity,
    ));

    dirty.mark_all();
}

pub(super) fn cull_tile_chunks(
    cfg: Res<MapConfig>,
    q_window: Query<&Window, With<PrimaryWindow>>,
    q_camera: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut q_chunks: Query<(&TileChunkRoot, &mut Visibility)>,
) {
    let Ok(window) = q_window.single() else {
        return;
    };
    let Ok((camera, cam_gt)) = q_camera.single() else {
        return;
    };

    let viewport = camera
        .logical_viewport_size()
        .unwrap_or(Vec2::new(window.width(), window.height()))
        .max(Vec2::ONE);

    let corners = [
        Vec2::new(0.0, 0.0),
        Vec2::new(viewport.x, 0.0),
        Vec2::new(0.0, viewport.y),
        Vec2::new(viewport.x, viewport.y),
    ];

    let origin = map_origin(&cfg);
    let mut min_world = Vec2::splat(f32::INFINITY);
    let mut max_world = Vec2::splat(f32::NEG_INFINITY);
    for c in corners {
        let Ok(w) = camera.viewport_to_world_2d(cam_gt, c) else {
            // If we can't compute the viewport bounds, do not cull anything.
            for (_, mut vis) in q_chunks.iter_mut() {
                *vis = Visibility::Visible;
            }
            return;
        };
        min_world = min_world.min(w);
        max_world = max_world.max(w);
    }

    let world_to_tile_i = |w: Vec2| -> IVec2 {
        let local = w - origin;
        IVec2::new(
            (local.x / cfg.tile_size).floor() as i32,
            (local.y / cfg.tile_size).floor() as i32,
        )
    };

    let mut min_t = world_to_tile_i(min_world);
    let mut max_t = world_to_tile_i(max_world);
    // Clamp to map bounds (camera can go out of range).
    min_t.x = min_t.x.clamp(0, cfg.width.max(1) - 1);
    min_t.y = min_t.y.clamp(0, cfg.height.max(1) - 1);
    max_t.x = max_t.x.clamp(0, cfg.width.max(1) - 1);
    max_t.y = max_t.y.clamp(0, cfg.height.max(1) - 1);

    let pad = 1;
    let min_cx = (min_t.x / TILE_CHUNK_SIZE) - pad;
    let max_cx = (max_t.x / TILE_CHUNK_SIZE) + pad;
    let min_cy = (min_t.y / TILE_CHUNK_SIZE) - pad;
    let max_cy = (max_t.y / TILE_CHUNK_SIZE) + pad;

    for (chunk, mut vis) in q_chunks.iter_mut() {
        if chunk.cx >= min_cx && chunk.cx <= max_cx && chunk.cy >= min_cy && chunk.cy <= max_cy {
            *vis = Visibility::Visible;
        } else {
            *vis = Visibility::Hidden;
        }
    }
}

#[derive(SystemParam)]
pub(super) struct SyncDirtyTilesParams<'w, 's> {
    ui: Res<'w, UiState>,
    cfg: Res<'w, MapConfig>,
    grid: Res<'w, MapGrid>,
    index: Res<'w, MapIndex>,
    land_value: Option<Res<'w, LandValueIndex>>,
    pollution: Option<Res<'w, PollutionIndex>>,
    dirty: ResMut<'w, DirtyTiles>,
    q_tiles: Query<'w, 's, (&'static mut Sprite, &'static mut TileKind)>,
}

pub(super) fn sync_dirty_tiles_to_render(
    mut p: SyncDirtyTilesParams,
    mut changed: Local<Vec<usize>>,
) {
    p.dirty.drain_into(&mut changed);
    if changed.is_empty() {
        return;
    }

    for idx in changed.iter().copied() {
        let x = (idx % (p.grid.width as usize)) as i32;
        let y = (idx / (p.grid.width as usize)) as i32;
        let pos = TilePos { x, y };

        let Some(&entity) = p.index.tiles.get(idx) else {
            continue;
        };
        let Ok((mut sprite, mut kind)) = p.q_tiles.get_mut(entity) else {
            continue;
        };

        let cell = p.grid.get(pos).unwrap_or_default();
        let base_size = Vec2::splat(p.cfg.tile_size - 1.0);

        let base_terrain_or_zone = cell.zone.as_tile_kind().unwrap_or(cell.terrain);

        let (effective_kind, color, size) = match p.ui.overlay {
            OverlayMode::Height => {
                let t = (cell.height as f32) / 255.0;
                let gray = Color::srgb(t, t, t);
                let k = if cell.water {
                    TileKind::Water
                } else if cell.road.is_some() {
                    TileKind::Road
                } else {
                    base_terrain_or_zone
                };
                (k, gray, base_size)
            }
            OverlayMode::Water => {
                if cell.water {
                    (
                        TileKind::Water,
                        Color::srgba(0.15, 0.45, 0.95, 0.85),
                        base_size,
                    )
                } else {
                    (
                        base_terrain_or_zone,
                        Color::srgba(0.0, 0.0, 0.0, 0.10),
                        base_size,
                    )
                }
            }
            OverlayMode::Roads => {
                if cell.road.is_some() {
                    (TileKind::Road, Color::srgb(0.92, 0.92, 0.96), base_size)
                } else if cell.water {
                    (
                        TileKind::Water,
                        Color::srgba(0.1, 0.2, 0.4, 0.15),
                        base_size,
                    )
                } else {
                    (
                        base_terrain_or_zone,
                        Color::srgba(0.0, 0.0, 0.0, 0.10),
                        base_size,
                    )
                }
            }
            OverlayMode::LandValue => {
                // Land value overlay: red (low) to green (high)
                if let Some(land_val) = p.land_value.as_deref()
                    && let Some(idx) = p.grid.idx(pos)
                {
                    let value = land_val.get(idx);
                    // Gradient from red (0.0) to green (1.0)
                    let color = if value < 0.5 {
                        // Red to yellow
                        let t = value * 2.0;
                        Color::srgb(1.0, t, 0.0)
                    } else {
                        // Yellow to green
                        let t = (value - 0.5) * 2.0;
                        Color::srgb(1.0 - t, 1.0, 0.0)
                    };
                    let k = if cell.water {
                        TileKind::Water
                    } else if cell.road.is_some() {
                        TileKind::Road
                    } else {
                        base_terrain_or_zone
                    };
                    (k, color, base_size)
                } else {
                    // Fallback to base view if land value not available
                    if cell.water {
                        (TileKind::Water, TileKind::Water.color(), base_size)
                    } else if cell.road.is_some() {
                        (TileKind::Road, cell.road.kind.color(), base_size)
                    } else {
                        (
                            base_terrain_or_zone,
                            base_terrain_or_zone.color(),
                            base_size,
                        )
                    }
                }
            }
            OverlayMode::Pollution => {
                // Pollution overlay: green (clean) to red (polluted)
                if let Some(poll) = p.pollution.as_deref()
                    && let Some(idx) = p.grid.idx(pos)
                {
                    let poll_value = poll.get(idx);
                    // Gradient from green (0.0) to red (1.0)
                    let color = if poll_value < 0.5 {
                        // Green to yellow
                        let t = poll_value * 2.0;
                        Color::srgb(t, 1.0, 0.0)
                    } else {
                        // Yellow to red
                        let t = (poll_value - 0.5) * 2.0;
                        Color::srgb(1.0, 1.0 - t, 0.0)
                    };
                    let k = if cell.water {
                        TileKind::Water
                    } else if cell.road.is_some() {
                        TileKind::Road
                    } else {
                        base_terrain_or_zone
                    };
                    (k, color, base_size)
                } else {
                    // Fallback to base view if pollution not available
                    if cell.water {
                        (TileKind::Water, TileKind::Water.color(), base_size)
                    } else if cell.road.is_some() {
                        (TileKind::Road, cell.road.kind.color(), base_size)
                    } else {
                        (
                            base_terrain_or_zone,
                            base_terrain_or_zone.color(),
                            base_size,
                        )
                    }
                }
            }
            OverlayMode::Zones
            | OverlayMode::None
            | OverlayMode::Traffic
            | OverlayMode::Path
            | OverlayMode::ServiceCoverage => {
                // Base view: always show water/roads; zoning is shown on non-road tiles.
                if cell.water {
                    (TileKind::Water, TileKind::Water.color(), base_size)
                } else if cell.road.is_some() {
                    (TileKind::Road, cell.road.kind.color(), base_size)
                } else {
                    (
                        base_terrain_or_zone,
                        base_terrain_or_zone.color(),
                        base_size,
                    )
                }
            }
        };

        *kind = effective_kind;
        sprite.color = color;
        sprite.custom_size = Some(size);
    }
}

pub(super) fn mark_dirty_on_overlay_change(
    ui: Res<UiState>,
    mut last: ResMut<LastOverlayMode>,
    mut dirty: ResMut<DirtyTiles>,
) {
    if !ui.is_changed() {
        return;
    }
    if ui.overlay == last.0 {
        return;
    }
    last.0 = ui.overlay;
    dirty.mark_all();
}

/// Path overlay: draw the remaining planned routes for all active vehicles.
///
/// - Draws only the remaining route (no "already travelled" part) by starting at the vehicle's
///   current interpolated transform position.
/// - Updates automatically when routes are replanned.
pub(super) fn vehicle_routes_overlay_render(
    state: Res<State<AppState>>,
    ui: Res<UiState>,
    cfg: Res<MapConfig>,
    path_pool: Res<crate::game::transport::PathPool>,
    mut gizmos: Gizmos<RouteGizmos>,
    q_vehicles: Query<(&Vehicle, &Transform), Without<Parked>>,
    mut scratch: Local<Vec<Vec2>>,
) {
    if !matches!(state.get(), AppState::InGame | AppState::Paused) {
        return;
    }
    if ui.overlay != OverlayMode::Path {
        return;
    }

    // Route overlay color: visible but subtle.
    let color = Color::srgba(1.0, 0.75, 0.20, 0.70);
    let origin = map_origin(&cfg);

    // Guardrails to keep the overlay cheap when many vehicles are active.
    //
    // Rendering 1M routes is not feasible; cap work per frame strictly.
    const MAX_ROUTES_PER_FRAME: usize = 256;
    const MAX_POINTS_PER_ROUTE: usize = 256;

    let mut drawn = 0usize;
    for (vehicle, tf) in q_vehicles.iter() {
        if drawn >= MAX_ROUTES_PER_FRAME {
            break;
        }
        // We draw from current *world position* to the remaining tiles.
        let route = match path_pool.remaining_from(vehicle.path_handle, vehicle.path_cursor) {
            Some(route) if route.len() > 1 => route,
            _ => continue,
        };

        let remaining_tiles = route.len() - 1; // subtract current position
        let max_tiles = MAX_POINTS_PER_ROUTE.saturating_sub(1).max(1);
        let stride = remaining_tiles.div_ceil(max_tiles); // >= 1

        scratch.clear();
        scratch.reserve(remaining_tiles.min(MAX_POINTS_PER_ROUTE) + 1);
        scratch.push(tf.translation.truncate());

        for (i, pos) in route.iter().enumerate().skip(1) {
            // skip current position
            // Always include the last tile, even when downsampling.
            let rel_i = i; // i already starts from 1 due to skip(1)
            let is_last = rel_i + 1 == route.len();
            let should_take = is_last || (rel_i % stride == 0);
            if !should_take {
                continue;
            }

            let w = origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size);
            scratch.push(w);
        }

        if scratch.len() >= 2 {
            gizmos.linestrip_2d(scratch.iter().copied(), color);
            drawn += 1;
        }
    }
}
