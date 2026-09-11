// Port of crates/simcity_sim/src/game/transport/pathfinding/{mod,astar,cost,cache,regions}.rs:
// road-A* over the road graph with congestion-aware integer costs, a region pre-pass and a
// TTL + approximate-LRU path cache. Edge costs are computed in f32 exactly as Rust does.
import type { RoadDir, TilePos } from '../commands';
import type { IntersectionIndex } from '../intersections/index';
import type { MapGrid } from '../map/grid';
import { capacityPerLaneTile, dirLeft, dirRight, roadDesirability, roadSpeedLimit } from '../map/roads';
import type { TrafficOccupancy } from '../traffic/occupancy';
import { OpenSet } from './openSet';
import type { RegionGraph } from './regionGraph';
import type { RoadGraph } from './roadGraph';

const f32 = Math.fround;
const U32_MAX = 0xffff_ffff;
const MAX_CACHED_PATH = 1000;
/** Seconds a vehicle waits at a light on average, priced into the edge. */
const AVG_LIGHT_WAIT_SECS = 5;

export interface PathfindingConfig {
  cacheCapacity: number;
  cacheTtlSecs: number;
  /** `k` in `w = base_cost * (1 + k * congestion)`, `f32`. */
  congestionK: number;
  /** Clamp for occupancy / capacity, `f32`. */
  congestionMax: number;
  laneChangePenalty: number;
  turnPenalty: number;
  /** Float weights -> integer A* costs, `f32`. */
  costScale: number;
  enableHierarchical: boolean;
  regionSize: number;
  regionPad: number;
}

/** `PathfindingConfig::default()` (and assets/config/pathfinding.ron). */
export function defaultPathfindingConfig(): PathfindingConfig {
  return {
    cacheCapacity: 4096,
    cacheTtlSecs: 10,
    congestionK: 2,
    congestionMax: 2,
    laneChangePenalty: 40,
    turnPenalty: 80,
    costScale: 1000,
    enableHierarchical: true,
    regionSize: 16,
    regionPad: 1,
  };
}

interface CacheEntry {
  readonly path: readonly TilePos[];
  lastUsedSec: number;
}

export class PathCache {
  version = 0;
  map = new Map<string, CacheEntry>();
  /** `(key, last_used_sec at push)`; duplicates allowed, stale entries skipped on purge. */
  lru: Array<readonly [string, number]> = [];

  clear(): void {
    this.map.clear();
    this.lru = [];
  }
}

export interface PathfindingCtx {
  timeNowSec: number;
  cfg: PathfindingConfig;
  cache: PathCache;
  graph: RoadGraph;
  regions: RegionGraph | null;
  traffic: TrafficOccupancy;
  grid: MapGrid;
  intersections: IntersectionIndex;
}

const pathKey = (start: TilePos, goal: TilePos, version: number) =>
  `${start.x},${start.y}|${goal.x},${goal.y}|${version}`;

function enforceCacheLimits(timeNowSec: number, cfg: PathfindingConfig, cache: PathCache): void {
  let head = 0;
  // TTL purge (approximate, front-biased).
  while (head < cache.lru.length) {
    const [key, used] = cache.lru[head]!;
    if (timeNowSec - used <= cfg.cacheTtlSecs) break;
    head++;
    const entry = cache.map.get(key);
    if (entry !== undefined && Math.abs(entry.lastUsedSec - used) < Number.EPSILON) cache.map.delete(key);
  }
  // Capacity purge (approximate LRU).
  while (cache.map.size > cfg.cacheCapacity && head < cache.lru.length) {
    const [key, used] = cache.lru[head]!;
    head++;
    const entry = cache.map.get(key);
    if (entry !== undefined && Math.abs(entry.lastUsedSec - used) < Number.EPSILON) cache.map.delete(key);
  }
  if (head > 0) cache.lru = cache.lru.slice(head);
}

/** `step_cost_for_edge`: integer cost of moving from `curIdx` to `nextIdx`. */
function stepCostForEdge(ctx: PathfindingCtx, curIdx: number, nextIdx: number, moveDir: RoadDir): number {
  const { grid, cfg } = ctx;
  const w = ctx.graph.width;
  const curPos = { x: curIdx % w, y: Math.floor(curIdx / w) };
  const nextPos = { x: nextIdx % w, y: Math.floor(nextIdx / w) };
  const cur = grid.get(curPos)?.road;
  const next = grid.get(nextPos)?.road;
  const kind = next?.kind ?? 'None';

  const speed = f32(Math.max(roadSpeedLimit(kind), 1));
  const capacity = f32(Math.max(capacityPerLaneTile(kind), 1));
  const desirability = f32(Math.max(roadDesirability(kind), f32(0.1)));
  const occupancy = f32(ctx.traffic.perTickVehicles[nextIdx] ?? 0);
  const congestion = Math.min(Math.max(f32(occupancy / capacity), 0), f32(Math.max(cfg.congestionMax, 0)));

  const travelTime = f32(1 / speed);
  const desirabilityFactor = f32(1 / desirability);
  const baseCost = f32(travelTime * desirabilityFactor);
  const congestionFactor = f32(1 + f32(cfg.congestionK * congestion));
  const costScale = f32(Math.max(cfg.costScale, 1));
  const raw = f32(f32(baseCost * congestionFactor) * costScale);

  let penalty = 0;
  if (cur !== undefined && next !== undefined && cur.dir !== 'None' && next.dir !== 'None') {
    const perpendicular = moveDir === dirLeft(cur.dir) || moveDir === dirRight(cur.dir);
    if (perpendicular && next.dir === cur.dir) penalty = f32(penalty + Math.max(cfg.laneChangePenalty, 0));
    else if (perpendicular && next.dir === moveDir) penalty = f32(penalty + Math.max(cfg.turnPenalty, 0));
  }

  const lightPenalty = ctx.intersections.hasTrafficLightAt(nextPos) ? f32(AVG_LIGHT_WAIT_SECS * costScale) : 0;
  const total = Math.max(f32(f32(raw + penalty) + lightPenalty), 1);
  return Math.min(Math.trunc(total), U32_MAX);
}

function manhattanIdx(a: number, b: number, w: number): number {
  return Math.abs((a % w) - (b % w)) + Math.abs(Math.floor(a / w) - Math.floor(b / w));
}

function bfsRegionPath(rg: RegionGraph, start: number, goal: number): number[] | undefined {
  const n = rg.edges.length;
  if (start >= n || goal >= n) return undefined;
  const pred = new Int32Array(n).fill(-1);
  pred[start] = start;
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    if (cur === goal) break;
    const mask = rg.edges[cur]!;
    const x = cur % rg.regionsW;
    const y = Math.floor(cur / rg.regionsW);
    const visit = (nidx: number) => {
      if (pred[nidx] === -1) {
        pred[nidx] = cur;
        queue.push(nidx);
      }
    };
    if ((mask & 1) !== 0 && x > 0) visit(cur - 1);
    if ((mask & 2) !== 0 && x + 1 < rg.regionsW) visit(cur + 1);
    if ((mask & 4) !== 0 && y > 0) visit(cur - rg.regionsW);
    if ((mask & 8) !== 0 && y + 1 < rg.regionsH) visit(cur + rg.regionsW);
  }
  if (pred[goal] === -1) return undefined;
  const path = [goal];
  let cur = goal;
  while (cur !== start) {
    cur = pred[cur]!;
    path.push(cur);
  }
  return path.reverse();
}

/** Regions the low-level search may enter: the BFS region path padded by `regionPad`. */
function computeAllowedRegions(ctx: PathfindingCtx, start: TilePos, goal: TilePos): Uint8Array | undefined {
  const rg = ctx.regions;
  if (!ctx.cfg.enableHierarchical || rg === null) return undefined;
  if (!rg.isBuiltFor(ctx.graph.version, Math.max(ctx.cfg.regionSize, 1), ctx.graph.width, ctx.graph.height)) {
    return undefined;
  }
  const startR = rg.regionId(start);
  const goalR = rg.regionId(goal);
  if (startR === undefined || goalR === undefined || startR === goalR) return undefined;
  const regionPath = bfsRegionPath(rg, startR, goalR);
  if (regionPath === undefined) return undefined;

  const pad = Math.max(ctx.cfg.regionPad, 0);
  const allowed = new Uint8Array(rg.edges.length);
  for (const rid of regionPath) {
    const rx = rid % rg.regionsW;
    const ry = Math.floor(rid / rg.regionsW);
    for (let dy = -pad; dy <= pad; dy++) {
      for (let dx = -pad; dx <= pad; dx++) {
        const nx = rx + dx;
        const ny = ry + dy;
        if (nx < 0 || ny < 0 || nx >= rg.regionsW || ny >= rg.regionsH) continue;
        allowed[ny * rg.regionsW + nx] = 1;
      }
    }
  }
  return allowed;
}

function astarRoadGraph(
  ctx: PathfindingCtx,
  startIdx: number,
  goalIdx: number,
  allowedRegions: Uint8Array | undefined,
): TilePos[] | undefined {
  const { graph } = ctx;
  const w = graph.width;
  const len = graph.edges.length;
  const cameFrom = new Int32Array(len).fill(-1);
  const bestG = new Uint32Array(len).fill(U32_MAX);
  const open = new OpenSet();

  bestG[startIdx] = 0;
  open.push(manhattanIdx(startIdx, goalIdx, w), 0, startIdx);

  const isAllowed = (idx: number): boolean => {
    if (allowedRegions === undefined || ctx.regions === null) return true;
    const rid = ctx.regions.regionId({ x: idx % w, y: Math.floor(idx / w) });
    return rid === undefined || rid >= allowedRegions.length || allowedRegions[rid] === 1;
  };

  while (open.size > 0) {
    const [g, idx] = open.pop();
    if (g !== bestG[idx]) continue;
    if (idx === goalIdx) {
      const out: TilePos[] = [];
      for (let cur = goalIdx; cur !== -1; cur = cameFrom[cur]!) out.push({ x: cur % w, y: Math.floor(cur / w) });
      return out.reverse();
    }
    const mask = graph.edges[idx]!;
    if (mask === 0) continue;

    const pushNeighbour = (nidx: number, moveDir: RoadDir) => {
      if (!isAllowed(nidx)) return;
      const step = Math.max(stepCostForEdge(ctx, idx, nidx, moveDir), 1);
      const ng = Math.min(g + step, U32_MAX);
      if (ng < bestG[nidx]!) {
        bestG[nidx] = ng;
        cameFrom[nidx] = idx;
        open.push(Math.min(ng + manhattanIdx(nidx, goalIdx, w), U32_MAX), ng, nidx);
      }
    };
    if ((mask & 1) !== 0 && idx > 0) pushNeighbour(idx - 1, 'West');
    if ((mask & 2) !== 0 && idx + 1 < len) pushNeighbour(idx + 1, 'East');
    if ((mask & 4) !== 0 && idx >= w) pushNeighbour(idx - w, 'South');
    if ((mask & 8) !== 0 && idx + w < len) pushNeighbour(idx + w, 'North');
  }
  return undefined;
}

function findRoadPath(ctx: PathfindingCtx, start: TilePos, goal: TilePos): TilePos[] {
  if (start.x === goal.x && start.y === goal.y) return [start];
  const { graph } = ctx;
  if (graph.edges.length === 0 || graph.width === 0) return [];
  const w = graph.width;
  const len = graph.edges.length;
  // Row-major indices from the graph width, bounds-checked only against the whole array (as Rust).
  const startIdx = start.y * w + start.x;
  const goalIdx = goal.y * w + goal.x;
  if (startIdx < 0 || goalIdx < 0 || startIdx >= len || goalIdx >= len) return [];
  if (graph.edges[startIdx] === 0) return [];
  return astarRoadGraph(ctx, startIdx, goalIdx, computeAllowedRegions(ctx, start, goal)) ?? [];
}

/**
 * A road path from the cache or a fresh A*. Empty when the graph is not built, start is not a road
 * node, or no path exists.
 */
export function findRoadPathCached(ctx: PathfindingCtx, start: TilePos, goal: TilePos): TilePos[] {
  const { cache, graph } = ctx;
  if (cache.version !== graph.version) {
    cache.clear();
    cache.version = graph.version;
  }
  const key = pathKey(start, goal, graph.version);
  const hit = cache.map.get(key);
  if (hit !== undefined) {
    hit.lastUsedSec = ctx.timeNowSec;
    cache.lru.push([key, ctx.timeNowSec]);
    return hit.path.slice();
  }

  const path = findRoadPath(ctx, start, goal);
  if (path.length >= 2 && path.length <= MAX_CACHED_PATH) {
    cache.map.set(key, { path: path.slice(), lastUsedSec: ctx.timeNowSec });
    cache.lru.push([key, ctx.timeNowSec]);
    enforceCacheLimits(ctx.timeNowSec, ctx.cfg, cache);
  }
  return path;
}
