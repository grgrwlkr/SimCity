//! Transport system: pathfinding, routing, and path management.
//!
//! This module handles road graphs, pathfinding algorithms, and shared path storage.

pub mod lane_graph;
pub mod lane_occupancy;
pub mod path_pool;
pub mod pathfinding;
pub mod region_graph;
pub mod road_graph;
pub mod turn_lanes;
pub mod version;

pub use lane_graph::{LaneGraph, LaneId, rebuild_lane_graph};
pub use lane_occupancy::VehicleId;
pub use path_pool::{PathHandle, PathPool};
pub use pathfinding::{PathCache, PathfindingConfig, PathfindingCtx, find_road_path_cached};
pub use region_graph::RegionGraph;
pub use road_graph::{RoadGraph, rebuild_road_graph_inner};
pub use version::GraphVersion;

use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;
use bevy::prelude::*;

/// Find a road tile adjacent to `pos` that points towards `target`.
/// Prefers roads facing the desired direction, falls back to any road.
pub fn adjacent_road_towards(grid: &MapGrid, pos: TilePos, target: TilePos) -> Option<TilePos> {
    let want = desired_dir(pos, target);
    let mut best_any = None;

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

    for cpos in candidates {
        if let Some(cell) = grid.get(cpos)
            && !cell.water
            && cell.road.is_some()
        {
            best_any = best_any.or(Some(cpos));
            if cell.road.dir == want {
                return Some(cpos);
            }
        }
    }

    best_any
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
            // .init_resource::<LaneOccupancy>()
            // .add_plugins(AsyncPathfindingPlugin)  // Temporarily disabled
            .add_systems(
                FixedUpdate,
                road_graph::rebuild_road_graph.in_set(crate::game::sets::GameSet::GraphUpdate),
            )
            .add_systems(
                FixedUpdate,
                region_graph::rebuild_region_graph.in_set(crate::game::sets::GameSet::GraphUpdate),
            )
            .add_systems(
                FixedUpdate,
                rebuild_lane_graph.in_set(crate::game::sets::GameSet::GraphUpdate),
            );
        // .add_systems(FixedUpdate, populate_lane_occupancy.in_set(crate::game::sets::GameSet::GraphUpdate));
    }
}
