use bevy::prelude::*;

use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::render_primitives::{RenderPrimitives, layer};
use crate::game::ui_state::{OverlayMode, UiState};

use crate::game::civic_coverage::{CivicCoverage, CivicKind};

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
    last_civic_version: u64,
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
    civic: Option<Res<CivicCoverage>>,
    mut pool: ResMut<ServiceCoverageOverlayPool>,
    mut commands: Commands,
    mut prims: ResMut<RenderPrimitives>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut q_tint: Query<
        (
            &mut MeshMaterial3d<StandardMaterial>,
            &mut Transform,
            &mut Visibility,
        ),
        (
            With<ServiceCoverageOverlayTintTile>,
            Without<ServiceCoverageOverlayUncoveredTile>,
        ),
    >,
    mut q_uncovered: Query<
        (
            &mut MeshMaterial3d<StandardMaterial>,
            &mut Transform,
            &mut Visibility,
        ),
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
    let civic = civic.as_deref().filter(|civic| civic.covers(grid.len()));
    let civic_version = civic.map_or(0, |civic| civic.version);
    let needs_update = !pool.last_enabled
        || pool.last_version != coverage.version
        || pool.last_civic_version != civic_version
        || cfg_changed;
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

            let emergency = (mask != 0).then(|| {
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
                Color::srgba(r.min(1.0), g.min(1.0), b.min(1.0), alpha)
            });
            // Schools, universities and parks tint in their own colour, the strongest on the tile,
            // fainter where a crowd weakens it.
            let civic_tint = civic.and_then(|civic| {
                CivicKind::ALL
                    .into_iter()
                    .map(|kind| (kind, civic.get(kind, idx)))
                    .filter(|(_, strength)| *strength > 0.0)
                    .max_by(|a, b| a.1.total_cmp(&b.1))
                    .map(|(kind, strength)| {
                        let color = kind.color().to_srgba();
                        Color::srgba(color.red, color.green, color.blue, 0.06 + 0.06 * strength)
                    })
            });
            let tint = match (emergency, civic_tint) {
                (Some(emergency), Some(civic)) => {
                    let (a, b) = (emergency.to_srgba(), civic.to_srgba());
                    Some(Color::srgba(
                        (a.red + b.red) / 2.0,
                        (a.green + b.green) / 2.0,
                        (a.blue + b.blue) / 2.0,
                        a.alpha.max(b.alpha),
                    ))
                }
                (emergency, civic) => emergency.or(civic),
            };
            if let Some(tint) = tint {
                tint_tiles.push((pos, tint));
            }

            if cell.zone != crate::game::map::ZoneKind::None && mask == 0 {
                uncovered_tiles.push(pos);
            }
        }
    }

    let tint_count = tint_tiles.len();
    let uncovered_count = uncovered_tiles.len();

    let hidden_mat = prims.material(&mut materials, Color::srgba(0.0, 0.0, 0.0, 0.0));
    ensure_pool(
        &mut commands,
        &mut pool.tint,
        tint_count,
        ServiceCoverageOverlayTintTile,
        cfg.tile_size,
        layer::COVERAGE,
        prims.quad.clone(),
        hidden_mat.clone(),
    );
    ensure_pool(
        &mut commands,
        &mut pool.uncovered,
        uncovered_count,
        ServiceCoverageOverlayUncoveredTile,
        cfg.tile_size,
        layer::COVERAGE_UNCOVERED,
        prims.quad.clone(),
        hidden_mat,
    );

    // Update tint layer.
    for (i, (pos, color)) in tint_tiles.into_iter().enumerate() {
        let e = pool.tint[i];
        if let Ok((mut mat, mut tf, mut vis)) = q_tint.get_mut(e) {
            mat.0 = prims.material(&mut materials, color);
            let w = tile_to_world(&cfg, pos);
            tf.translation.x = w.x;
            tf.translation.y = w.y;
            tf.translation.z = layer::COVERAGE;
            tf.scale = Vec2::splat(cfg.tile_size).extend(1.0);
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
        if let Ok((mut mat, mut tf, mut vis)) = q_uncovered.get_mut(e) {
            mat.0 = prims.material(&mut materials, Color::srgba(0.9, 0.1, 0.1, 0.25));
            let w = tile_to_world(&cfg, pos);
            tf.translation.x = w.x;
            tf.translation.y = w.y;
            tf.translation.z = layer::COVERAGE_UNCOVERED;
            tf.scale = Vec2::splat(cfg.tile_size).extend(1.0);
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
    pool.last_civic_version = civic_version;
    pool.last_cfg_w = cfg.width;
    pool.last_cfg_h = cfg.height;
    pool.last_tile_size = cfg.tile_size;
}

#[allow(clippy::too_many_arguments)]
fn ensure_pool<M: Component + Copy>(
    commands: &mut Commands,
    entries: &mut Vec<Entity>,
    needed: usize,
    marker: M,
    tile_size: f32,
    z: f32,
    quad: Handle<Mesh>,
    hidden_mat: Handle<StandardMaterial>,
) {
    if entries.len() < needed {
        let to_add = needed - entries.len();
        entries.reserve(to_add);
        for _ in 0..to_add {
            let e = commands
                .spawn((
                    marker,
                    Mesh3d(quad.clone()),
                    MeshMaterial3d(hidden_mat.clone()),
                    Transform::from_xyz(0.0, 0.0, z).with_scale(Vec2::splat(tile_size).extend(1.0)),
                    Visibility::Hidden,
                ))
                .id();
            entries.push(e);
        }
    }
}

use crate::game::map::tile_to_world;
