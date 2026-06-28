use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use rand::RngExt;

use crate::game::intersections::IntersectionId;
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::sim::SimRng;
use crate::game::transport::lanelet::pathfinding::find_route;
use crate::game::transport::{
    LaneCostCtx, LaneGraph, LaneId, LaneletGraph, LaneletId, PathfindingConfig,
};

use super::{TrafficConfig, TrafficOccupancy};

/// Resources needed to re-run the lanelet-aware planner at a reroute site, bundled so individual
/// systems stay under Bevy's 16-param `IntoSystem` limit. `traffic`/`path_cfg` are NOT bundled here:
/// some callers already hold those (and an extra `Res` of the same type in one system is rejected),
/// so they stay as explicit args to `replan_route_with_lanelets`.
#[derive(SystemParam)]
pub(crate) struct LaneletReplanRes<'w> {
    pub traffic_cfg: Res<'w, TrafficConfig>,
    pub lane_graph: Res<'w, LaneGraph>,
    pub lanelet_graph: Res<'w, LaneletGraph>,
    pub sim_rng: ResMut<'w, SimRng>,
}

impl LaneletReplanRes<'_> {
    pub(crate) fn jitter_seed(&mut self) -> u64 {
        self.sim_rng.rng.random_range(1..=u64::MAX)
    }
}

/// Re-plan a mid-trip reroute through the SAME lanelet-aware planner that spawn uses, so the
/// `VehicleLaneletPlan` sidecar is re-populated instead of cleared. Without this, a rerouted vehicle
/// permanently loses its sidecar (only spawn writes it), the arbiter can't resolve a maneuver-legal
/// lanelet for it, drops it as a grant candidate, and the intersection under-admits into gridlock.
///
/// Returns `None` when start/goal lanes are unresolvable, or `find_route` yields an empty route — in
/// every such case the caller keeps its existing road-A* path + cleared sidecar.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(crate) fn replan_route_with_lanelets(
    lg: &LaneGraph,
    llg: &LaneletGraph,
    grid: &MapGrid,
    traffic: &TrafficOccupancy,
    path_cfg: &PathfindingConfig,
    jitter_seed: u64,
    cur_tile: TilePos,
    goal_tile: TilePos,
    travel_dir: RoadDir,
) -> Option<(Vec<TilePos>, Vec<(usize, IntersectionId, LaneletId)>)> {
    let start_lane = lg.get_rightmost_lane(cur_tile, travel_dir)?;
    let goal_dir = grid.get(goal_tile)?.road.dir;
    let goal_lane = lg.get_rightmost_lane(goal_tile, goal_dir)?;
    if start_lane == LaneId::INVALID || goal_lane == LaneId::INVALID {
        return None;
    }

    let ctx = LaneCostCtx {
        grid,
        traffic,
        cfg: path_cfg,
        jitter_seed,
    };
    let (tiles, sidecar) = find_route(lg, llg, &ctx, start_lane, goal_lane);
    if tiles.is_empty() {
        return None;
    }
    Some((tiles, sidecar))
}
