//! Pollution system - industrial buildings create pollution that affects land value.

use bevy::prelude::*;

use crate::game::buildings::Building;
use crate::game::map::{BuildingKind, MapEditVersion, MapGrid, TilePos};
use crate::game::sets::GameSet;
use crate::game::state::AppState;

/// Pollution index for each tile (0.0 - 1.0)
#[derive(Resource, Default)]
pub struct PollutionIndex {
    pub pollution: Vec<f32>, // 0.0 - 1.0 for each tile
    chunk_size: usize,
    current_chunk: usize,
    needs_full_reset: bool,
    /// True while a recompute pass is in progress.
    dirty: bool,
    /// Last observed map edit version.
    last_map_edit_version: u64,
    /// Cached anchors of industrial buildings.
    buildings: Vec<TilePos>,
    /// Cursor into `buildings` during recompute.
    building_cursor: usize,
    /// Precomputed kernel offsets for pollution spread.
    kernel: Vec<PollutionKernelOffset>,
}

impl PollutionIndex {
    pub fn get(&self, idx: usize) -> f32 {
        self.pollution.get(idx).copied().unwrap_or(0.0)
    }
}

pub struct PollutionPlugin;

impl Plugin for PollutionPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<PollutionIndex>().add_systems(
            FixedUpdate,
            compute_pollution
                .in_set(GameSet::PostSim)
                .run_if(in_state(AppState::InGame)),
        );
    }
}

/// Pollution radius from industrial buildings
const POLLUTION_RADIUS: i32 = 10;
const RESET_CHUNK_SIZE: usize = 256;
const BUILDING_BATCH_TARGET_TICKS: usize = 20;
const BUILDING_BATCH_MAX: usize = 64;

#[derive(Debug, Copy, Clone)]
struct PollutionKernelOffset {
    /// Relative x offset from anchor.
    dx: i32,
    /// Relative y offset from anchor.
    dy: i32,
    /// Precomputed intensity contribution.
    intensity: f32,
}

/// Compute pollution incrementally
fn compute_pollution(
    grid: Res<MapGrid>,
    edit_v: Res<MapEditVersion>,
    q_buildings: Query<&Building>,
    mut pollution: ResMut<PollutionIndex>,
) {
    let len = grid.len();
    if pollution.pollution.len() != len {
        pollution.pollution.clear();
        pollution.pollution.resize(len, 0.0);
        pollution.chunk_size = RESET_CHUNK_SIZE;
        pollution.current_chunk = 0;
        pollution.needs_full_reset = true;
        pollution.dirty = true;
        pollution.last_map_edit_version = edit_v.0;
        pollution.building_cursor = 0;
        rebuild_industrial_building_list(&q_buildings, &mut pollution.buildings);
        build_pollution_kernel(&mut pollution.kernel);
    }

    if pollution.kernel.is_empty() {
        build_pollution_kernel(&mut pollution.kernel);
    }

    if pollution.last_map_edit_version != edit_v.0 {
        pollution.last_map_edit_version = edit_v.0;
        pollution.dirty = true;
        pollution.needs_full_reset = true;
        pollution.current_chunk = 0;
        pollution.building_cursor = 0;
        rebuild_industrial_building_list(&q_buildings, &mut pollution.buildings);
    }

    if !pollution.dirty {
        return;
    }

    // Reset chunks incrementally
    if pollution.needs_full_reset {
        let tiles_per_chunk = pollution.chunk_size;
        let start_idx = pollution.current_chunk * tiles_per_chunk;
        let end_idx = (start_idx + tiles_per_chunk).min(len);

        for idx in start_idx..end_idx {
            pollution.pollution[idx] = 0.0;
        }

        pollution.current_chunk += 1;
        if pollution.current_chunk * tiles_per_chunk >= len {
            pollution.needs_full_reset = false;
            pollution.current_chunk = 0;
        }
        return; // Reset phase - don't compute pollution yet
    }

    if pollution.buildings.is_empty() {
        pollution.dirty = false;
        pollution.needs_full_reset = true;
        pollution.current_chunk = 0;
        pollution.building_cursor = 0;
        return;
    }

    // Compute pollution by processing a batch of industrial buildings per tick.
    let batch = buildings_per_tick(pollution.buildings.len());
    let end = (pollution.building_cursor + batch).min(pollution.buildings.len());
    let width = grid.width;
    let height = grid.height;
    let width_usize = width.max(0) as usize;
    if width_usize == 0 {
        pollution.dirty = false;
        pollution.needs_full_reset = true;
        pollution.current_chunk = 0;
        pollution.building_cursor = 0;
        return;
    }

    for anchor in &pollution.buildings[pollution.building_cursor..end] {
        let base_x = anchor.x;
        let base_y = anchor.y;
        for k in pollution.kernel.iter() {
            let x = base_x + k.dx;
            let y = base_y + k.dy;
            if x < 0 || y < 0 || x >= width || y >= height {
                continue;
            }
            let idx = (y as usize) * width_usize + (x as usize);
            if idx >= pollution.pollution.len() {
                continue;
            }
            let next = pollution.pollution[idx] + k.intensity;
            pollution.pollution[idx] = next.min(1.0);
        }
    }

    pollution.building_cursor = end;
    if pollution.building_cursor >= pollution.buildings.len() {
        pollution.dirty = false;
        pollution.needs_full_reset = true;
        pollution.current_chunk = 0;
        pollution.building_cursor = 0;
    }
}

/// Builds the list of industrial building anchors for pollution updates.
fn rebuild_industrial_building_list(q_buildings: &Query<&Building>, out: &mut Vec<TilePos>) {
    out.clear();
    out.extend(
        q_buildings
            .iter()
            .filter(|b| b.kind == BuildingKind::Industrial)
            .map(|b| b.anchor_pos),
    );
}

/// Precomputes the pollution kernel offsets for the configured radius.
fn build_pollution_kernel(out: &mut Vec<PollutionKernelOffset>) {
    if !out.is_empty() {
        return;
    }

    let r = POLLUTION_RADIUS;
    let r2 = r * r;
    let rf = r as f32;
    for dy in -r..=r {
        for dx in -r..=r {
            let d2 = dx * dx + dy * dy;
            if d2 > r2 {
                continue;
            }
            let dist = (d2 as f32).sqrt();
            let intensity = (1.0 - (dist / rf)).max(0.0) * 0.3;
            if intensity <= 0.0 {
                continue;
            }
            out.push(PollutionKernelOffset { dx, dy, intensity });
        }
    }
}

/// Computes how many buildings to process per tick for pollution updates.
fn buildings_per_tick(total: usize) -> usize {
    if total == 0 {
        return 0;
    }
    let target = BUILDING_BATCH_TARGET_TICKS.max(1);
    let per_tick = (total + target - 1) / target;
    per_tick.clamp(1, BUILDING_BATCH_MAX)
}
