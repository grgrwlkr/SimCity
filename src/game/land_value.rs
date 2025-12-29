//! Land value system - calculates land value based on proximity to roads, services, and pollution.

use bevy::prelude::*;

use crate::game::map::{MapGrid, TilePos};
use crate::game::pollution::PollutionIndex;
use crate::game::services::ServiceCoverageIndex;
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::traffic::TrafficOccupancy;

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
    traffic: Option<Res<TrafficOccupancy>>,
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
    let max_heat = traffic
        .as_deref()
        .and_then(|t| t.ema_heat.iter().copied().reduce(f32::max))
        .unwrap_or(0.0);

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
                let mut service_bonus = 0.0;
                if coverage.is_covered(idx, ServiceCoverageIndex::MASK_FIRE) {
                    service_bonus += 0.1;
                }
                if coverage.is_covered(idx, ServiceCoverageIndex::MASK_POLICE) {
                    service_bonus += 0.1;
                }
                if coverage.is_covered(idx, ServiceCoverageIndex::MASK_MEDICAL) {
                    service_bonus += 0.1;
                }
                value += service_bonus;
            }

            // -0.4 * pollution for pollution impact
            if let Some(poll) = pollution.as_deref()
                && let Some(idx) = grid.idx(pos)
            {
                let poll_value = poll.get(idx);
                value -= poll_value * 0.4;
            }

            // -0.2 for locally high traffic (nearby congested road tiles).
            // Uses per-tile `TrafficOccupancy.ema_heat` (not city-wide averages).
            if let Some(occ) = traffic.as_deref()
                && max_heat > 0.0
            {
                let local_heat = local_traffic_heat(occ, &grid, pos);
                let local_norm = (local_heat / max_heat).clamp(0.0, 1.0);
                if local_norm > 0.7 {
                    value -= 0.2;
                }
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

fn local_traffic_heat(occ: &TrafficOccupancy, grid: &MapGrid, pos: TilePos) -> f32 {
    let candidates = [
        pos,
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
    ];

    let mut best: f32 = 0.0;
    for p in candidates {
        let Some(cell) = grid.get(p) else {
            continue;
        };
        if cell.water || !cell.road.is_some() {
            continue;
        }
        let Some(idx) = grid.idx(p) else {
            continue;
        };
        best = best.max(occ.ema_heat.get(idx).copied().unwrap_or(0.0));
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::roads::RoadCell;

    #[test]
    fn land_value_uses_per_tile_service_coverage() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);

        let grid = MapGrid::new(3, 1);

        let covered = TilePos { x: 0, y: 0 };
        let uncovered = TilePos { x: 2, y: 0 };
        let covered_idx = grid.idx(covered).unwrap();
        let uncovered_idx = grid.idx(uncovered).unwrap();

        let mut coverage = ServiceCoverageIndex {
            fire: 1.0,
            police: 1.0,
            medical: 1.0,
            buildings_total: 1,
            coverage_map: vec![0; grid.len()],
        };
        coverage.coverage_map[covered_idx] = ServiceCoverageIndex::MASK_FIRE
            | ServiceCoverageIndex::MASK_POLICE
            | ServiceCoverageIndex::MASK_MEDICAL;

        app.insert_resource(grid);
        app.insert_resource(coverage);
        app.insert_resource(LandValueIndex::default());
        app.add_systems(Update, compute_land_value);
        app.update();

        let land_value = app.world().resource::<LandValueIndex>();
        assert!(
            land_value.values[covered_idx] > land_value.values[uncovered_idx],
            "covered tile should get higher land value than uncovered tile"
        );
    }

    #[test]
    fn land_value_uses_local_traffic_heat_not_citywide_average() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);

        let mut grid = MapGrid::new(3, 1);
        for x in 0..3 {
            let pos = TilePos { x, y: 0 };
            if let Some(mut cell) = grid.get(pos) {
                cell.road = RoadCell::none();
                cell.road.kind = crate::game::roads::RoadKind::TwoLane;
                cell.road.dir = crate::game::roads::RoadDir::East;
                cell.road.lane = 0;
                cell.road.flow = crate::game::roads::RoadFlow::TwoWay;
                cell.road.lane_type = crate::game::roads::LaneType::Regular;
                grid.set(pos, cell);
            }
        }

        let occ = TrafficOccupancy {
            per_tick_vehicles: vec![0; 3],
            ema_heat: vec![10.0, 1.0, 1.0], // only left tile is "congested"
        };

        app.insert_resource(grid);
        app.insert_resource(occ);
        app.insert_resource(LandValueIndex::default());
        app.add_systems(Update, compute_land_value);
        app.update();

        let lv = app.world().resource::<LandValueIndex>();
        assert!(lv.values[0] < lv.values[2]);
    }
}
