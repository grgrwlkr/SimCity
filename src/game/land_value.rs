//! Land value system - calculates land value based on proximity to roads, services, and pollution.

use bevy::prelude::*;

use crate::game::map::{MapGrid, TilePos};
use crate::game::pollution::PollutionIndex;
use crate::game::services::ServiceCoverageIndex;
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::traffic::TrafficIndex;

/// Land value index for each tile (0.0 - 1.0)
#[derive(Resource, Default)]
pub struct LandValueIndex {
    pub values: Vec<f32>, // 0.0 - 1.0 for each tile
    pub version: u64,
}

impl LandValueIndex {
    pub fn get(&self, idx: usize) -> f32 {
        self.values.get(idx).copied().unwrap_or(0.5)
    }
}

pub struct LandValuePlugin;

impl Plugin for LandValuePlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<LandValueIndex>().add_systems(
            FixedUpdate,
            compute_land_value
                .in_set(GameSet::PostSim)
                .run_if(in_state(AppState::InGame)),
        );
    }
}

/// Compute land value for all tiles
fn compute_land_value(
    grid: Res<MapGrid>,
    service_coverage: Option<Res<ServiceCoverageIndex>>,
    traffic: Option<Res<TrafficIndex>>,
    pollution: Option<Res<PollutionIndex>>,
    mut land_value: ResMut<LandValueIndex>,
) {
    let len = grid.len();
    if land_value.values.len() != len {
        land_value.values.clear();
        land_value.values.resize(len, 0.5);
    }

    // Base value
    let base_value = 0.5;

    // Compute for each tile
    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(idx) = grid.idx(pos) else {
                continue;
            };

            let mut value = base_value;

            // +0.2 for proximity to road
            if has_adjacent_road(&grid, pos) {
                value += 0.2;
            }

            // +0.1 for each service (Fire/Police/Medical)
            if let Some(coverage) = service_coverage.as_deref() {
                let service_bonus = (coverage.fire + coverage.police + coverage.medical) / 3.0;
                value += service_bonus * 0.3;
            }

            // -0.4 * pollution for pollution impact
            if let Some(poll) = pollution.as_deref()
                && let Some(idx) = grid.idx(pos)
            {
                let poll_value = poll.get(idx);
                value -= poll_value * 0.4;
            }

            // -0.2 for high traffic
            if let Some(traffic_idx) = traffic.as_deref()
                && traffic_idx.avg_congestion > 0.7
            {
                value -= 0.2;
            }

            // Clamp to [0.0, 1.0]
            value = value.clamp(0.0, 1.0);
            land_value.values[idx] = value;
        }
    }

    land_value.version += 1;
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
