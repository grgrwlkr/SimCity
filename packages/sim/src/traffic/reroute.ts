// The part of crates/simcity_sim/src/game/traffic/reroute_planner.rs stage 2a needs: re-planning a
// route through the lanelet planner and the direction guard every hand-built route passes.
import type { RoadDir, TilePos } from '../commands';
import type { MapGrid } from '../map/grid';
import { rangeU64Inclusive } from '../rng';
import { findRoute, routeIsDirectionCorrect, type Route } from '../transport/lanelet/pathfinding';
import type { World } from '../world';

const U64_MAX = (1n << 64n) - 1n;

/** `LaneletReplanRes::jitter_seed`: a fresh per-trip tie-break seed in `1..=u64::MAX`. */
export function drawJitterSeed(w: World): bigint {
  return rangeU64Inclusive(w.simRng, 1n, U64_MAX);
}

/** No step of `route` travels against a real road tile's lane direction. */
export function routeDirectionOk(route: readonly TilePos[], grid: MapGrid): boolean {
  return routeIsDirectionCorrect(route, grid);
}

/** `replan_route_with_lanelets`: `undefined` when an end lane is missing or the planner finds nothing. */
export function replanRouteWithLanelets(
  w: World,
  jitterSeed: bigint,
  curTile: TilePos,
  goalTile: TilePos,
  travelDir: RoadDir,
): Route | undefined {
  const lg = w.laneGraph;
  const startLane = lg.getRightmostLane(curTile, travelDir);
  if (startLane === undefined) return undefined;
  const goalCell = w.grid.get(goalTile);
  if (goalCell === undefined) return undefined;
  const goalLane = lg.getRightmostLane(goalTile, goalCell.road.dir);
  if (goalLane === undefined) return undefined;
  const route = findRoute(lg, w.laneletGraph, {
    grid: w.grid,
    traffic: w.trafficOccupancy,
    cfg: w.pathfindingConfig,
    jitterSeed,
  }, startLane, goalLane);
  return route.tiles.length === 0 ? undefined : route;
}
