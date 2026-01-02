//! Pollution system - industrial buildings create pollution that affects land value.

use bevy::prelude::*;

use crate::game::buildings::Building;
use crate::game::map::{BuildingKind, MapGrid, TilePos};
use crate::game::sets::GameSet;
use crate::game::state::AppState;

/// Pollution index for each tile (0.0 - 1.0)
#[derive(Resource, Default)]
pub struct PollutionIndex {
    pub pollution: Vec<f32>, // 0.0 - 1.0 for each tile
    chunk_size: usize,
    current_chunk: usize,
    needs_full_reset: bool,
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

/// Compute pollution incrementally
fn compute_pollution(
    grid: Res<MapGrid>,
    q_buildings: Query<&Building>,
    mut pollution: ResMut<PollutionIndex>,
) {
    let len = grid.len();
    if pollution.pollution.len() != len {
        pollution.pollution.clear();
        pollution.pollution.resize(len, 0.0);
        pollution.chunk_size = 32; // Smaller chunks for pollution
        pollution.current_chunk = 0;
        pollution.needs_full_reset = true;
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

    // Compute pollution for current chunk
    let tiles_per_chunk = pollution.chunk_size;
    let start_idx = pollution.current_chunk * tiles_per_chunk;
    let end_idx = (start_idx + tiles_per_chunk).min(len);

    // For each industrial building, spread pollution to current chunk
    for building in q_buildings.iter() {
        if building.kind != BuildingKind::Industrial {
            continue;
        }

        // Only spread to tiles in current chunk
        for dy in -POLLUTION_RADIUS..=POLLUTION_RADIUS {
            for dx in -POLLUTION_RADIUS..=POLLUTION_RADIUS {
                let check_pos = TilePos {
                    x: building.pos.x + dx,
                    y: building.pos.y + dy,
                };

                if let Some(idx) = grid.idx(check_pos) {
                    if idx < start_idx || idx >= end_idx {
                        continue; // Not in current chunk
                    }

                    let distance = ((dx * dx + dy * dy) as f32).sqrt();
                    if distance <= POLLUTION_RADIUS as f32 {
                        // Intensity decreases with distance
                        let intensity = 1.0 - (distance / POLLUTION_RADIUS as f32);
                        let current = pollution.pollution[idx];
                        // Accumulate pollution (max 1.0)
                        pollution.pollution[idx] = (current + intensity * 0.3).min(1.0);
                    }
                }
            }
        }
    }

    pollution.current_chunk += 1;
    if pollution.current_chunk * tiles_per_chunk >= len {
        pollution.current_chunk = 0;
        pollution.needs_full_reset = true; // Start over for next full cycle
    }
}

