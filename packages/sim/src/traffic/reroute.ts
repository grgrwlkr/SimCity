// Port of crates/simcity_sim/src/game/traffic/reroute_planner.rs: re-planning a route through the lanelet
// planner with a direction-guarded road A* fallback, putting a planned route onto a vehicle, and the
// sweep that fixes routes a road edit made illegal.
import type { RoadDir, TilePos } from '../commands';
import type { MapGrid } from '../map/grid';
import { roadCellIsSome } from '../map/roads';
import { rangeU64Inclusive } from '../rng';
import { findRoute, routeIsDirectionCorrect, type Route } from '../transport/lanelet/pathfinding';
import { findRoadPathCached, type PathfindingCtx } from '../transport/pathfinding';
import type { World } from '../world';
import { fixedElapsedSecs } from './reservations';
import { clearLaneletPlanOnReroute, type LaneletPlanEntry } from './vehicles';

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

const planEntries = (route: Route): LaneletPlanEntry[] => route.sidecar.map((e) => [e[0], e[1], e[2]] as const);

/** A route ready for a vehicle, its lanelet plan kept with it so the two cannot drift apart. */
export interface PlannedRoute {
  readonly tiles: readonly TilePos[];
  readonly sidecar: readonly LaneletPlanEntry[];
  /** Lanelet graph version the sidecar ids were minted under; 0 for a road route. */
  readonly builtFor: number;
  readonly producer: 'Lanelet' | 'RoadFallback';
}

/** The road A* context over the world's graphs, at this tick's fixed time. */
export function roadPathCtx(w: World): PathfindingCtx {
  return {
    timeNowSec: fixedElapsedSecs(w),
    cfg: w.pathfindingConfig,
    cache: w.pathCache,
    graph: w.roadGraph,
    regions: w.regionGraph,
    traffic: w.trafficOccupancy,
    grid: w.grid,
    intersections: w.intersections,
  };
}

/**
 * `plan_tiles_lanelet_first`: the lanelet planner, else road A* (retried without the region corridor,
 * which hides detours such as a dead-end spur's U-turn) under the direction guard. `undefined` when
 * nothing legal routes.
 */
export function planTilesLaneletFirst(w: World, from: TilePos, to: TilePos): PlannedRoute | undefined {
  const travelDir = w.grid.get(from)?.road.dir ?? 'None';
  const lanelet = replanRouteWithLanelets(w, drawJitterSeed(w), from, to, travelDir);
  if (lanelet !== undefined) {
    return { tiles: lanelet.tiles, sidecar: planEntries(lanelet), builtFor: w.laneletGraph.version, producer: 'Lanelet' };
  }
  const ctx = roadPathCtx(w);
  let tiles = findRoadPathCached(ctx, from, to);
  if (tiles.length === 0 && ctx.regions !== null) tiles = findRoadPathCached({ ...ctx, regions: null }, from, to);
  if (tiles.length === 0) return undefined;
  if (!routeDirectionOk(tiles, w.grid)) {
    w.routeProducerStats.guardRefusals += 1;
    return undefined;
  }
  return { tiles, sidecar: [], builtFor: 0, producer: 'RoadFallback' };
}

/** `apply_route`: the vehicle in `slot` starts `planned` from its first tile, with the matching lanelet plan. */
export function applyRoute(w: World, slot: number, planned: PlannedRoute): void {
  const v = w.vehicles;
  w.pathPool.release(v.pathHandle[slot]!);
  v.pathHandle[slot] = w.pathPool.intern(planned.tiles);
  v.pathCursor[slot] = 0;
  v.progress[slot] = 0;
  v.laneletPlan[slot] = { entries: [...planned.sidecar], builtFor: planned.builtFor };
}

/** The sweep's memory between ticks: the graph version last seen and whether a sweep is unfinished. */
export interface RouteInvalidation {
  lastSeen: number | null;
  sweepPending: boolean;
}

/**
 * `invalidate_routes_on_graph_change` (FixedUpdate, after the lanelet graph): after a structural map
 * edit every active route is re-checked against the new grid. A route that leaves the roads or steps
 * against a lane is re-planned; without a legal continuation it is cut to the current tile, so the
 * vehicle never drives the stale tail. At most `maxRoutePlansPerTick` re-plans a tick, the rest carry
 * over. A still-legal route only loses a lanelet plan minted for the old graph.
 */
export function invalidateRoutesOnGraphChange(w: World): void {
  const state = w.routeInvalidation;
  const firstRun = state.lastSeen === null;
  const changed = state.lastSeen !== w.graphVersion;
  state.lastSeen = w.graphVersion;
  if (changed && !firstRun) state.sweepPending = true;
  if (!state.sweepPending) return;

  const budget = Math.max(w.trafficConfig.maxRoutePlansPerTick, 1);
  const v = w.vehicles;
  const pool = w.pathPool;
  let replans = 0;
  let outOfBudget = false;
  for (const slot of v.order) {
    if (v.parked[slot] === 1) continue;
    const rest = pool.remainingFrom(v.pathHandle[slot]!, v.pathCursor[slot]!);
    if (rest === undefined || rest.length <= 1) continue;
    const plan = v.laneletPlan[slot]!;
    const onRoads = rest.every((tile) => {
      const cell = w.grid.get(tile);
      return cell !== undefined && !cell.water && roadCellIsSome(cell.road);
    });
    if (onRoads && routeDirectionOk(rest, w.grid)) {
      if (plan.entries.length > 0 && plan.builtFor !== w.graphVersion) clearLaneletPlanOnReroute(plan);
      continue;
    }
    if (replans >= budget) {
      outOfBudget = true;
      break;
    }
    replans += 1;
    const current = rest[0]!;
    const goal = rest[rest.length - 1]!;
    const route = replanRouteWithLanelets(w, drawJitterSeed(w), current, goal, w.grid.get(current)?.road.dir ?? 'None');
    pool.release(v.pathHandle[slot]!);
    if (route !== undefined) {
      v.pathHandle[slot] = pool.intern(route.tiles);
      plan.entries = planEntries(route);
      plan.builtFor = w.laneletGraph.version;
    } else {
      v.pathHandle[slot] = pool.intern([current]);
      clearLaneletPlanOnReroute(plan);
    }
    v.pathCursor[slot] = 0;
  }
  state.sweepPending = outOfBudget;
}
