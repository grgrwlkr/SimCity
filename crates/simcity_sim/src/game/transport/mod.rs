//! Transport system: pathfinding, routing, and path management.
//!
//! This module handles road graphs, pathfinding algorithms, and shared path storage.

pub mod lane_graph;
pub mod lane_occupancy;
pub mod lane_pathfinding;
pub mod lanelet;
pub mod path_pool;
pub mod pathfinding;
pub mod region_graph;
pub mod road_graph;
pub mod turn_lanes;

pub use lane_graph::{LaneGraph, LaneId, build_lane_graph};
pub use lane_occupancy::VehicleId;
pub use lane_pathfinding::{LaneCostCtx, find_lane_path, lane_path_to_tiles};
pub use lanelet::{
    ConflictMatrix, Lanelet, LaneletConflictMatrices, LaneletGraph, LaneletId, build_lanelet_graph,
};
pub use path_pool::{PathHandle, PathPool};
pub use pathfinding::{PathCache, PathfindingConfig, PathfindingCtx, find_road_path_cached};
pub use region_graph::RegionGraph;
pub use road_graph::RoadGraph;
#[allow(unused_imports)] // Re-exported for tests/diagnostics
pub use road_graph::rebuild_road_graph_inner;
pub use simcity_core::game::transport::GraphVersion;

use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::sets::GameSet;
use bevy::prelude::*;

/// Find a road tile adjacent to `pos` that points towards `target`.
/// Prefers roads facing the desired direction, falls back to any road.
///
/// CRITICAL: For two-way two-lane roads, ensures we pick the correct lane
/// (right-hand traffic: each direction has its own lane).
pub fn adjacent_road_towards(grid: &MapGrid, pos: TilePos, target: TilePos) -> Option<TilePos> {
    let want = desired_dir(pos, target);
    let mut best_any = None;
    let mut best_correct_lane = None; // For two-way roads: prefer correct lane

    // Check pos itself first, then 4-neighbors.
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

    let mut best_non_opposite = None; // Not pointing straight against the desired direction.

    for cpos in candidates {
        if let Some(cell) = grid.get(cpos)
            && !cell.water
            && cell.road.is_some()
        {
            // The wrong-way carriageway of a one-way road is not drivable — never an anchor.
            if let crate::game::roads::RoadFlow::OneWay(one_way_dir) = cell.road.flow
                && cell.road.dir != RoadDir::None
                && cell.road.dir != one_way_dir
            {
                continue;
            }
            best_any = best_any.or(Some(cpos));
            if cell.road.dir != want.opposite() {
                best_non_opposite = best_non_opposite.or(Some(cpos));
            }
            // A lane matching the desired direction is always the right anchor.
            if cell.road.dir == want {
                best_correct_lane = best_correct_lane.or(Some(cpos));
            }
        }
    }

    // Prefer the direction-correct lane, then any lane not pointing straight against us
    // (perpendicular / intersection tiles), and only as a last resort the oncoming lane —
    // anchoring trips on the oncoming lane made cars visually spawn against traffic.
    best_correct_lane.or(best_non_opposite).or(best_any)
}

fn desired_dir(from: TilePos, to: TilePos) -> RoadDir {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    if dx.abs() >= dy.abs() {
        if dx >= 0 {
            RoadDir::East
        } else {
            RoadDir::West
        }
    } else if dy >= 0 {
        RoadDir::North
    } else {
        RoadDir::South
    }
}

/// Plugin for the transport system.
pub struct TransportPlugin;

impl Plugin for TransportPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<PathPool>()
            .init_resource::<PathCache>()
            .init_resource::<PathfindingConfig>()
            .init_resource::<GraphVersion>()
            .init_resource::<RoadGraph>()
            .init_resource::<RegionGraph>()
            .init_resource::<LaneGraph>()
            .init_resource::<LaneletGraph>()
            .init_resource::<LaneletConflictMatrices>()
            .init_resource::<turn_lanes::TurnLaneAutogenState>()
            .add_plugins(pathfinding::r#async::AsyncPathfindingPlugin)
            .add_systems(
                FixedUpdate,
                road_graph::rebuild_road_graph.in_set(GameSet::GraphUpdate),
            )
            .add_systems(
                FixedUpdate,
                region_graph::rebuild_region_graph.in_set(GameSet::GraphUpdate),
            )
            .add_systems(
                FixedUpdate,
                turn_lanes::autogen_turn_lanes
                    .in_set(GameSet::GraphUpdate)
                    .before(lane_graph::build_lane_graph),
            )
            .add_systems(
                FixedUpdate,
                lane_graph::build_lane_graph.in_set(GameSet::GraphUpdate),
            )
            .add_systems(
                FixedUpdate,
                build_lanelet_graph
                    .in_set(GameSet::GraphUpdate)
                    .after(lane_graph::build_lane_graph),
            );
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
