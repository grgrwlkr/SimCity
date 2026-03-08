use bevy::prelude::*;

use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::ui_state::{OverlayMode, UiState};

use super::coverage::ServiceCoverageIndex;

#[derive(Component, Copy, Clone)]
pub(super) struct ServiceCoverageOverlayTintTile;

#[derive(Component, Copy, Clone)]
pub(super) struct ServiceCoverageOverlayUncoveredTile;

#[derive(Resource, Default)]
pub(super) struct ServiceCoverageOverlayPool {
    tint: Vec<Entity>,
    uncovered: Vec<Entity>,
    last_enabled: bool,
    last_version: u64,
    last_cfg_w: i32,
    last_cfg_h: i32,
    last_tile_size: f32,
}

#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(super) fn render_service_coverage_overlay(
    ui: Res<UiState>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    coverage: Res<ServiceCoverageIndex>,
    mut pool: ResMut<ServiceCoverageOverlayPool>,
    mut commands: Commands,
    mut q_tint: Query<
        (&mut Sprite, &mut Transform, &mut Visibility),
        (
            With<ServiceCoverageOverlayTintTile>,
            Without<ServiceCoverageOverlayUncoveredTile>,
        ),
    >,
    mut q_uncovered: Query<
        (&mut Sprite, &mut Transform, &mut Visibility),
        (
            With<ServiceCoverageOverlayUncoveredTile>,
            Without<ServiceCoverageOverlayTintTile>,
        ),
    >,
) {
    let enabled = ui.overlay == OverlayMode::ServiceCoverage;
    if !enabled {
        if pool.last_enabled {
            for &e in pool.tint.iter() {
                if let Ok((_s, _t, mut v)) = q_tint.get_mut(e) {
                    *v = Visibility::Hidden;
                }
            }
            for &e in pool.uncovered.iter() {
                if let Ok((_s, _t, mut v)) = q_uncovered.get_mut(e) {
                    *v = Visibility::Hidden;
                }
            }
            pool.last_enabled = false;
        }
        return;
    }

    let cfg_changed = pool.last_cfg_w != cfg.width
        || pool.last_cfg_h != cfg.height
        || (pool.last_tile_size - cfg.tile_size).abs() > f32::EPSILON;
    let needs_update = !pool.last_enabled || pool.last_version != coverage.version || cfg_changed;
    if !needs_update {
        return;
    }

    // Build desired overlay items (only on updates).
    let mut tint_tiles: Vec<(TilePos, Color)> = Vec::new();
    let mut uncovered_tiles: Vec<TilePos> = Vec::new();
    tint_tiles.reserve(grid.len().min(4096));
    uncovered_tiles.reserve(1024);

    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else { continue };
            if cell.water {
                continue;
            }
            let Some(idx) = grid.idx(pos) else { continue };
            let mask = coverage.coverage_map.get(idx).copied().unwrap_or(0);

            if mask != 0 {
                // Blend tint by active service bits.
                let mut r: f32 = 0.0;
                let mut g: f32 = 0.0;
                let mut b: f32 = 0.0;
                let mut bits = 0u32;
                if (mask & ServiceCoverageIndex::MASK_FIRE) != 0 {
                    r += 0.9;
                    bits += 1;
                }
                if (mask & ServiceCoverageIndex::MASK_POLICE) != 0 {
                    b += 0.9;
                    bits += 1;
                }
                if (mask & ServiceCoverageIndex::MASK_MEDICAL) != 0 {
                    g += 0.8;
                    bits += 1;
                }
                let alpha = match bits {
                    0 => 0.0,
                    1 => 0.06,
                    2 => 0.08,
                    _ => 0.10,
                };
                tint_tiles.push((pos, Color::srgba(r.min(1.0), g.min(1.0), b.min(1.0), alpha)));
            }

            if cell.zone != crate::game::map::ZoneKind::None && mask == 0 {
                uncovered_tiles.push(pos);
            }
        }
    }

    let tint_count = tint_tiles.len();
    let uncovered_count = uncovered_tiles.len();

    ensure_pool(
        &mut commands,
        &mut pool.tint,
        tint_count,
        ServiceCoverageOverlayTintTile,
        cfg.tile_size,
        4.0,
    );
    ensure_pool(
        &mut commands,
        &mut pool.uncovered,
        uncovered_count,
        ServiceCoverageOverlayUncoveredTile,
        cfg.tile_size,
        4.2,
    );

    let origin = map_origin(&cfg);

    // Update tint layer.
    for (i, (pos, color)) in tint_tiles.into_iter().enumerate() {
        let e = pool.tint[i];
        if let Ok((mut sprite, mut tf, mut vis)) = q_tint.get_mut(e) {
            sprite.color = color;
            sprite.custom_size = Some(Vec2::splat(cfg.tile_size));
            let w = origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size);
            tf.translation.x = w.x;
            tf.translation.y = w.y;
            tf.translation.z = 4.0;
            *vis = Visibility::Visible;
        }
    }
    for &e in pool.tint[tint_count..].iter() {
        if let Ok((_s, _t, mut vis)) = q_tint.get_mut(e) {
            *vis = Visibility::Hidden;
        }
    }

    // Update uncovered layer.
    for (i, pos) in uncovered_tiles.into_iter().enumerate() {
        let e = pool.uncovered[i];
        if let Ok((mut sprite, mut tf, mut vis)) = q_uncovered.get_mut(e) {
            sprite.color = Color::srgba(0.9, 0.1, 0.1, 0.25);
            sprite.custom_size = Some(Vec2::splat(cfg.tile_size));
            let w = origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size);
            tf.translation.x = w.x;
            tf.translation.y = w.y;
            tf.translation.z = 4.2;
            *vis = Visibility::Visible;
        }
    }
    for &e in pool.uncovered[uncovered_count..].iter() {
        if let Ok((_s, _t, mut vis)) = q_uncovered.get_mut(e) {
            *vis = Visibility::Hidden;
        }
    }

    pool.last_enabled = true;
    pool.last_version = coverage.version;
    pool.last_cfg_w = cfg.width;
    pool.last_cfg_h = cfg.height;
    pool.last_tile_size = cfg.tile_size;
}

fn ensure_pool<M: Component + Copy>(
    commands: &mut Commands,
    entries: &mut Vec<Entity>,
    needed: usize,
    marker: M,
    tile_size: f32,
    z: f32,
) {
    if entries.len() < needed {
        let to_add = needed - entries.len();
        entries.reserve(to_add);
        for _ in 0..to_add {
            let e = commands
                .spawn((
                    marker,
                    Sprite {
                        color: Color::srgba(0.0, 0.0, 0.0, 0.0),
                        custom_size: Some(Vec2::splat(tile_size)),
                        ..default()
                    },
                    Transform::from_xyz(0.0, 0.0, z),
                    Visibility::Hidden,
                ))
                .id();
            entries.push(e);
        }
    }
}

fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}
