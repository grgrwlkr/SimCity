// Stage 3½: pedestrians. A citizen on foot walks the pavements — the lane tiles beside a kerb, on the kerb side — and
// crosses a road only through an intersection box. The path comes from the map and is cached; how far along it a walker
// is, is state of the citizens, moved a game second at a time by `moveWalkers`. A road with no box within reach of the
// goal is crossed where it must be, at a price no detour pays.
//
// Stage 4: the crossings. At a light a walker waits for their green (tests_signalized.rs). At an uncontrolled box a walker
// on the kerb does not step in front of a car about to enter or already in the box, and one kept waiting past
// `waitRerouteSecs` looks for a way round it (tests_uncontrolled.rs). Once inside a box a walker walks on. The walkers on
// a box are published to traffic as `pedestrianCrossings`, which cars yield to.
import { DEFAULT_GAME_HOUR_NS } from './city';
import { TICK_DT_NS, periodTicks } from './rates';
import { SECOND_NS } from './timer';
import type { TilePos } from './commands';
import { inTileView, tileFToWorld, type TileView } from './map/coords';
import type { MapGrid } from './map/grid';
import { LinkHeap } from './meso/districts';
import { WALK_NONE, rebuildPedestrianGraph, type PedestrianGraph } from './pedestrians/graph';
import { isGreen, type TrafficLight } from './traffic/lights';
import { resolveVehicle } from './traffic/vehicles';
import { adjacentRoadTowards } from './transport/anchors';
import type { World } from './world';

const f32 = Math.fround;
const PI = f32(Math.PI);
const HALF_PI = f32(Math.PI / 2);

/** How far a walker keeps from a tile's middle towards its kerb, tiles. */
const KERB_OFFSET = 0.4;
/** A step across a road away from any box or along the middle of a wide one costs this many tiles of walking. */
const OFF_CROSSING_COST = 200;
/**
 * A step along a road the pedestrian graph gives no pavement, a six-lane one, costs this much more: a street beside it is
 * taken when the detour is short. As dear as a crossing away from a box it sent the searches of the metropolis round its
 * boulevards to their limit, three times the cost of every walk (measured 2026-09-15).
 */
const NO_PAVEMENT_COST = 1;
/** A search that looks at more tiles than this gives up, and the walker goes straight. */
const MAX_EXPANDED = 20_000;
/** What a crossing with a light is expected to add to a walk, seconds: about a quarter of a signal cycle. */
export const LIT_CROSSING_WAIT_SECS = 15;
/** Paths kept per world before the cache starts over. */
const PATH_CACHE_LIMIT = 20_000;
/** Walkers step this much game time at once; the renderer draws them on between their steps. */
export const WALKER_STEP_NS = SECOND_NS;
const NO_AVOID = -1;

// `ROAD_DIRS` indices.
const WEST = 1;
const EAST = 2;

export interface WalkPath {
  /** x, y of each corner, tile coordinates: the start, a point on every tile walked, the goal. */
  readonly points: Float32Array;
  /** Length of the path up to each corner, tiles along the axes. */
  readonly along: Float32Array;
  /** For the step into each corner: the intersection whose crossing it starts, -1 for none. */
  readonly gate: Int32Array;
  /** For the step into each corner: 1 when it runs east–west. */
  readonly eastWest: Uint8Array;
  /** For the step into each corner: 1 when it steps off a pavement into the box, 0 when it turns inside the box. */
  readonly fromKerb: Uint8Array;
  /** For each corner: the intersection of its box tile, -1 off a box. */
  readonly boxOf: Int32Array;
}

/** `slot` and `generation` of the citizen; world coordinates. */
export type WalkerVisitor = (slot: number, generation: number, x: number, y: number, heading: number) => void;

const pathCache = new WeakMap<World, { key: number; readonly paths: Map<string, WalkPath> }>();

// Scratch of the path search, reused between searches; never state.
let cost = new Float64Array(0);
let parent = new Int32Array(0);
let reached = new Uint32Array(0);
let search = 0;

const isRoad = (grid: MapGrid, i: number) => grid.roadKind[i] !== 0;
const SIDES = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
] as const;
const NO_SIDE = [0, 0] as const;
const isBox = (grid: MapGrid, i: number) => grid.roadKind[i] !== 0 && grid.roadDir[i] === 0;
const runsEastWest = (grid: MapGrid, i: number) => grid.roadDir[i] === WEST || grid.roadDir[i] === EAST;

/** The side of a road tile its kerb is on, as a unit step; (0, 0) for a tile with road all round. */
function kerbSide(grid: MapGrid, x: number, y: number): readonly [number, number] {
  const [width, height] = [grid.width, grid.height];
  if (y + 1 >= height || !isRoad(grid, (y + 1) * width + x)) return SIDES[0];
  if (y === 0 || !isRoad(grid, (y - 1) * width + x)) return SIDES[1];
  if (x + 1 >= width || !isRoad(grid, y * width + x + 1)) return SIDES[2];
  if (x === 0 || !isRoad(grid, y * width + x - 1)) return SIDES[3];
  return NO_SIDE;
}

/**
 * The extra cost of a step from road tile `i` to road tile `j` along `dx`, `dy`: nothing on a pavement or through a box,
 * `OFF_CROSSING_COST` for stepping from one lane across to another, `NO_PAVEMENT_COST` onto a tile the pedestrian graph
 * gives no pavement but the goal.
 */
function stepPenalty(grid: MapGrid, graph: PedestrianGraph, i: number, j: number, dx: number, goal: number): number {
  if (isBox(grid, i) || isBox(grid, j)) return 0;
  const along = (tile: number) => runsEastWest(grid, tile) === (dx !== 0);
  if (!along(i) || !along(j)) return OFF_CROSSING_COST;
  if (j === goal) return 0;
  return graph.walk[j] === WALK_NONE ? NO_PAVEMENT_COST : 0;
}

/** Tile indices from `start` to `goal` over road tiles, by the pavements and the boxes but those of `avoid`; `null` without a way. */
function roadPath(w: World, start: number, goal: number, avoid: number): number[] | null {
  const grid = w.grid;
  rebuildPedestrianGraph(w);
  const graph = w.pedestrianGraph;
  const width = grid.width;
  const len = grid.len();
  if (reached.length < len) {
    [cost, parent, reached] = [new Float64Array(len), new Int32Array(len), new Uint32Array(len)];
    search = 0;
  }
  search += 1;
  const [gx, gy] = [goal % width, Math.floor(goal / width)];
  const heap = new LinkHeap();
  reached[start] = search;
  cost[start] = 0;
  parent[start] = -1;
  heap.push(0, start);
  for (let expanded = 0; heap.size > 0 && expanded < MAX_EXPANDED; expanded++) {
    const [, i] = heap.pop();
    if (i === goal) {
      const path: number[] = [];
      for (let at = goal; at >= 0; at = parent[at]!) path.push(at);
      return path.reverse();
    }
    const x = i % width;
    const y = (i - x) / width;
    // East, west, north, south, by index: no object a neighbour.
    for (let move = 0; move < 4; move++) {
      const dx = move === 0 ? 1 : move === 1 ? -1 : 0;
      const dy = move === 2 ? 1 : move === 3 ? -1 : 0;
      const [nx, ny] = [x + dx, y + dy];
      if (nx < 0 || ny < 0 || nx >= width || ny >= grid.height) continue;
      const j = ny * width + nx;
      if (!isRoad(grid, j)) continue;
      if (avoid !== NO_AVOID && isBox(grid, j) && w.intersections.intersectionIdAt({ x: nx, y: ny }) === avoid) continue;
      const next = cost[i]! + 1 + stepPenalty(grid, graph, i, j, dx, goal);
      if (reached[j] === search && next >= cost[j]!) continue;
      reached[j] = search;
      cost[j] = next;
      parent[j] = i;
      heap.push(next + Math.abs(gx - nx) + Math.abs(gy - ny), j);
    }
  }
  return null;
}

function buildPath(w: World, from: TilePos, to: TilePos, avoid: number): WalkPath {
  const grid = w.grid;
  // A walk from or to a lane tile — a street spot, the corner of a crossing given up on — keeps to that tile's side of the
  // road; the best lane beside it may be the far carriageway.
  const onLane = (p: TilePos) => {
    const i = grid.idx(p);
    return i !== undefined && isRoad(grid, i) && !isBox(grid, i);
  };
  const start = onLane(from) ? from : adjacentRoadTowards(grid, from, to);
  const goal = onLane(to) ? to : adjacentRoadTowards(grid, to, from);
  const tiles = start !== undefined && goal !== undefined ? (roadPath(w, grid.idx(start)!, grid.idx(goal)!, avoid) ?? []) : [];
  const n = tiles.length + 2;
  const points = new Float32Array(2 * n);
  const along = new Float32Array(n);
  const gate = new Int32Array(n).fill(-1);
  const eastWest = new Uint8Array(n);
  const fromKerb = new Uint8Array(n);
  const boxOf = new Int32Array(n).fill(-1);
  points[0] = from.x;
  points[1] = from.y;
  tiles.forEach((i, k) => {
    const [x, y] = [i % grid.width, Math.floor(i / grid.width)];
    const box = isBox(grid, i);
    const [kx, ky] = box ? [0, 0] : kerbSide(grid, x, y);
    points[2 * (k + 1)] = x + kx * KERB_OFFSET;
    points[2 * (k + 1) + 1] = y + ky * KERB_OFFSET;
    if (box) boxOf[k + 1] = w.intersections.intersectionIdAt({ x, y }) ?? -1;
    if (k === 0) return;
    const before = tiles[k - 1]!;
    eastWest[k + 1] = Math.abs(i - before) === 1 ? 1 : 0;
    // A crossing starts on the step into a box, and again where the walker turns inside it.
    const continues = k >= 2 && isBox(grid, before) && eastWest[k] === eastWest[k + 1];
    if (box && !continues) {
      gate[k + 1] = boxOf[k + 1]!;
      fromKerb[k + 1] = isBox(grid, before) ? 0 : 1;
    }
  });
  points[2 * (n - 1)] = to.x;
  points[2 * (n - 1) + 1] = to.y;
  for (let k = 1; k < n; k++) {
    along[k] = along[k - 1]! + Math.abs(points[2 * k]! - points[2 * k - 2]!) + Math.abs(points[2 * k + 1]! - points[2 * k - 1]!);
  }
  return { points, along, gate, eastWest, fromKerb, boxOf };
}

/** The path a walk from `from` to `to` takes on the current roads, keeping off the boxes of intersection `avoid`. */
export function walkPath(w: World, from: TilePos, to: TilePos, avoid = NO_AVOID): WalkPath {
  const key = w.graphVersion;
  let cached = pathCache.get(w);
  if (cached === undefined || cached.key !== key || cached.paths.size >= PATH_CACHE_LIMIT) {
    cached = { key, paths: new Map() };
    pathCache.set(w, cached);
  }
  const id = `${from.x},${from.y}>${to.x},${to.y}|${avoid}`;
  let path = cached.paths.get(id);
  if (path === undefined) {
    path = buildPath(w, from, to, avoid);
    cached.paths.set(id, path);
  }
  return path;
}

type SlotPath = { fx: number; fy: number; tx: number; ty: number; avoid: number; path: WalkPath } | undefined;
/** Derived, not state: the path each walker slot walks, and the ends it was found for. */
const slotPaths = new WeakMap<World, { key: number; readonly entries: SlotPath[] }>();

/** The paths of the walker slots for the current roads; taken once a pass, not once a walker. */
function slotPathsOf(w: World): SlotPath[] {
  let cache = slotPaths.get(w);
  if (cache === undefined || cache.key !== w.graphVersion) {
    cache = { key: w.graphVersion, entries: [] };
    slotPaths.set(w, cache);
    // New roads, new paths: every walker's next step looks at its path again.
    w.citizens.walkLimit.fill(-1);
  }
  return cache.entries;
}

/** The path of the walker in `slot`, without a key built for every walker every step. */
function walkerPath(w: World, slot: number, entries: SlotPath[] = slotPathsOf(w)): WalkPath {
  const c = w.citizens;
  const [fx, fy, tx, ty, avoid] = [c.walkFromX[slot]!, c.walkFromY[slot]!, c.destX[slot]!, c.destY[slot]!, c.walkAvoid[slot]!];
  const known = entries[slot];
  if (known !== undefined && known.fx === fx && known.fy === fy && known.tx === tx && known.ty === ty && known.avoid === avoid) return known.path;
  const path = walkPath(w, { x: fx, y: fy }, { x: tx, y: ty }, avoid);
  entries[slot] = { fx, fy, tx, ty, avoid, path };
  return path;
}

/** Walk measures kept per world before the cache starts over. */
const MEASURE_CACHE_LIMIT = 500_000;
/** Derived, not state: the length and lit crossings of walks between tile pairs, `lit × 2¹⁶ + tiles`, for a graph and its lights. */
const measureCache = new WeakMap<World, { graphVersion: number; lights: number; readonly values: Map<number, number> }>();

/** A number that moves when the set of lit intersections does. */
function lightsSignature(w: World): number {
  let signature = w.trafficLights.length;
  for (const light of w.trafficLights) signature = (Math.imul(signature, 31) + light.intersectionId) | 0;
  return signature;
}

/**
 * Metres of a walk from `from` to `to`, and the crossings with a light on its way. Kept apart from the paths themselves: the
 * planner measures a walk for every tour it times, far more pairs than paths are worth keeping.
 */
export function walkMeasure(w: World, from: TilePos, to: TilePos): { readonly meters: number; readonly litCrossings: number } {
  const grid = w.grid;
  const [a, b] = [grid.idx(from), grid.idx(to)];
  let values: Map<number, number> | undefined;
  const key = a === undefined || b === undefined ? -1 : a * grid.len() + b;
  if (key >= 0) {
    const lights = lightsSignature(w);
    let cache = measureCache.get(w);
    if (cache === undefined || cache.graphVersion !== w.graphVersion || cache.lights !== lights || cache.values.size >= MEASURE_CACHE_LIMIT) {
      cache = { graphVersion: w.graphVersion, lights, values: new Map() };
      measureCache.set(w, cache);
    }
    values = cache.values;
    const known = values.get(key);
    if (known !== undefined) {
      const litCrossings = Math.floor(known / 65536);
      return { meters: (known - litCrossings * 65536) * w.trafficConfig.tileMeters, litCrossings };
    }
  }
  const path = walkPath(w, from, to);
  const lit = new Set(w.trafficLights.map((light) => light.intersectionId));
  let litCrossings = 0;
  for (const intersection of path.gate) if (intersection >= 0 && lit.has(intersection)) litCrossings += 1;
  const tiles = path.along[path.along.length - 1]!;
  values?.set(key, litCrossings * 65536 + tiles);
  return { meters: tiles * w.trafficConfig.tileMeters, litCrossings };
}

/** The first index `k` from 1 whose `along[k]` passes `progress` (`strict`: reaches it), the last index when none does. */
function segmentAt(along: Float32Array, progress: number, strict: boolean): number {
  let [lo, hi] = [1, along.length - 1];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? along[mid]! < progress : along[mid]! <= progress) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * `ped_can_enter_uncontrolled`: whether a walker may step onto the uncontrolled crossing of intersection `id`, taking
 * `crossSecs` to cross a tile. Not while a meso car is in the box, a micro car holds a reservation for it, or the front
 * micro car on a tile entering it is within the minimum gap or would get there before the walker is across.
 */
function uncontrolledCrossingClear(w: World, id: number, crossSecs: number): boolean {
  const meso = w.mesoTraffic;
  if ((meso.boxBusyUntil.get(id) ?? -Infinity) > meso.nowSec) return false;
  const v = w.vehicles;
  if (v.order.length === 0) return true;
  if (w.reservations.isReserved(id)) return false;
  const cluster = w.intersections.clusterById(id);
  if (cluster === undefined) return true;
  const grid = w.grid;
  const cfg = w.pedestrianConfig;
  const tileSize = Math.max(w.mapConfig.tileSize, 0.001);
  const spatial = w.spatialIndex.isBuiltForLen(grid.len()) ? w.spatialIndex : undefined;
  const pool = w.pathPool;
  const intoBox = (slot: number) => {
    const next = pool.getTile(v.pathHandle[slot]!, v.pathCursor[slot]! + 1);
    const idx = next === undefined ? undefined : grid.idx(next);
    return idx !== undefined && isBox(grid, idx) && w.intersections.intersectionIdAt(next!) === id;
  };
  const tooClose = (progress: number, speed: number) => {
    const dist = Math.min(Math.max(1 - progress, 0), 1);
    if (dist <= cfg.uncontrolledMinGapTiles) return true;
    return speed > 0.1 && (dist * tileSize) / speed <= crossSecs + cfg.uncontrolledSafetyMarginSecs;
  };
  for (const tile of cluster.tiles) {
    for (const [dx, dy] of SIDES) {
      const idx = grid.idx({ x: tile.x + dx, y: tile.y + dy });
      if (idx === undefined || !isRoad(grid, idx) || isBox(grid, idx)) continue;
      if (spatial !== undefined) {
        const front = spatial.tileEntries(idx)?.at(-1);
        const slot = front === undefined ? undefined : resolveVehicle(v, front.vehicle);
        if (front !== undefined && slot !== undefined && intoBox(slot) && tooClose(front.progress, front.speed)) return false;
        continue;
      }
      // Without the index (a world traffic has not run in yet): every car on the tile.
      for (const slot of v.order) {
        if (v.parked[slot] === 1 || pool.len(v.pathHandle[slot]!) < 2) continue;
        const at = pool.getTile(v.pathHandle[slot]!, v.pathCursor[slot]!);
        if (at === undefined || grid.idx(at) !== idx) continue;
        if (intoBox(slot) && tooClose(v.progress[slot]!, v.speed[slot]!)) return false;
      }
    }
  }
  return true;
}

/**
 * `SimStep::Traffic`, after the lights: every walker goes on at walking pace. At the corner before a crossing with a
 * light a walker waits until their direction is green; before an uncontrolled one, until no car is about to enter or in
 * the box, and past `waitRerouteSecs` of that looks for a way round it. Once on a crossing they walk on. Walks end with
 * their citizen's arrival, which the planner keeps. The walkers on a box are then published as `pedestrianCrossings`.
 */
export function moveWalkers(w: World, dtNs: number): void {
  const c = w.citizens;
  if (c.onFootCount === 0) {
    if (w.pedestrianCrossings.length > 0) w.pedestrianCrossingsVersion += 1;
    w.pedestrianCrossings.length = 0;
    return;
  }
  const seconds = (dtNs / 1e9) * (DEFAULT_GAME_HOUR_NS / w.gameHourNs);
  const pace = w.citizenConfig.walkKmh / 3.6 / w.trafficConfig.tileMeters;
  const cfg = w.pedestrianConfig;
  let lights: Map<number, TrafficLight> | undefined;
  const paths = slotPathsOf(w);
  const limits = c.walkLimit;
  const stride = pace * seconds;
  // A walker in the list may be rerouted, never removed, while the list is walked.
  for (const slot of c.walkers()) {
    // Inside a segment and not at a crossing to wait at: the step below would add the stride and stop there.
    const at = c.walkProgress[slot]!;
    if (at + stride < limits[slot]!) {
      c.walkProgress[slot] = at + stride;
      continue;
    }
    const { points, along, gate, eastWest, fromKerb, boxOf } = walkerPath(w, slot, paths);
    const total = along[along.length - 1]!;
    let progress = at;
    let k = segmentAt(along, progress, false);
    let heldAt = -1;
    for (let budget = pace * seconds; budget > 0 && progress < total; ) {
      if (progress === along[k - 1] && gate[k]! >= 0) {
        lights ??= new Map(w.trafficLights.map((light) => [light.intersectionId, light]));
        const light = lights.get(gate[k]!);
        if (light !== undefined) {
          if (!isGreen(light, eastWest[k] === 1 ? 'East' : 'North')) break;
        } else if (fromKerb[k] === 1 && c.walkReroutes[slot]! < cfg.waitRerouteMaxAttempts && !uncontrolledCrossingClear(w, gate[k]!, 1 / pace)) {
          heldAt = k;
          break;
        }
      }
      const step = Math.min(budget, along[k]! - progress);
      budget -= step;
      progress += step;
      if (progress >= along[k]!) {
        progress = along[k]!;
        k += 1;
      }
    }
    if (heldAt >= 0) {
      c.walkWaitSecs[slot] = c.walkWaitSecs[slot]! + seconds;
      if (c.walkWaitSecs[slot]! >= cfg.waitRerouteSecs) {
        // From the corner it stands at, a way that keeps off this box.
        c.walkWaitSecs[slot] = 0;
        c.walkReroutes[slot] = c.walkReroutes[slot]! + 1;
        c.restartWalk(slot, { x: Math.round(points[2 * (heldAt - 1)]!), y: Math.round(points[2 * (heldAt - 1) + 1]!) }, gate[heldAt]!);
        continue;
      }
    } else if (progress > at) {
      c.walkWaitSecs[slot] = 0;
    }
    c.walkProgress[slot] = progress;
    const stored = c.walkProgress[slot]!;
    const next = segmentAt(along, stored, false);
    const atCorner = stored === along[next - 1] || stored >= total;
    limits[slot] = stored >= total || (stored === along[next - 1] && gate[next]! >= 0) ? -1 : along[next]!;
    const box = atCorner ? -1 : boxOf[next]! >= 0 ? boxOf[next]! : boxOf[next - 1]!;
    c.walkCrossing[slot] = box < 0 ? -1 : box * 2 + (eastWest[next] === 1 ? 0 : 1);
  }

  const crossing = new Set<number>();
  for (const slot of c.walkers()) if (c.walkCrossing[slot]! >= 0) crossing.add(c.walkCrossing[slot]!);
  w.pedestrianCrossingsVersion += 1;
  w.pedestrianCrossings.length = 0;
  for (const code of [...crossing].sort((a, b) => a - b)) w.pedestrianCrossings.push({ intersectionId: code >> 1, axisNs: (code & 1) === 1 });
}

/** Where along `path` a walker `progress` tiles on is, and its heading along the axis it mostly moves on. */
function poseAt(path: WalkPath, progress: number): readonly [x: number, y: number, heading: number] {
  const { points, along } = path;
  const k = segmentAt(along, progress, true);
  const [ax, ay, bx, by] = [points[2 * k - 2]!, points[2 * k - 1]!, points[2 * k]!, points[2 * k + 1]!];
  const span = along[k]! - along[k - 1]!;
  const t = span > 0 ? Math.min(Math.max((progress - along[k - 1]!) / span, 0), 1) : 1;
  const [dx, dy] = [bx - ax, by - ay];
  const heading = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : PI) : dy >= 0 ? HALF_PI : -HALF_PI;
  return [ax + dx * t, ay + dy * t, heading];
}

/**
 * How far along its path a walker may be drawn: the corner before the first crossing ahead whose light holds it now, or
 * before an uncontrolled crossing from the kerb, which only its next step may decide.
 */
function drawnLimit(path: WalkPath, progress: number, lights: ReadonlyMap<number, TrafficLight>): number {
  const { along, gate, eastWest, fromKerb } = path;
  const last = along.length - 1;
  for (let k = 1; k <= last; k++) {
    if (along[k - 1]! < progress || gate[k]! < 0) continue;
    const light = lights.get(gate[k]!);
    if (light === undefined ? fromKerb[k] === 1 : !isGreen(light, eastWest[k] === 1 ? 'East' : 'North')) return along[k - 1]!;
  }
  return along[last]!;
}

/**
 * Every citizen on foot, in no particular order; with a `view`, only those in it. A walker steps a second at a time and is
 * drawn on by the time since its last step, never past a crossing whose light holds it.
 */
export function forEachWalker(w: World, visit: WalkerVisitor, view?: TileView): void {
  const c = w.citizens;
  if (c.onFootCount === 0) return;
  const period = periodTicks(w, WALKER_STEP_NS);
  const pace = w.citizenConfig.walkKmh / 3.6 / w.trafficConfig.tileMeters;
  const ahead = period > 1 ? (((w.tick % period) * TICK_DT_NS) / 1e9) * (DEFAULT_GAME_HOUR_NS / w.gameHourNs) * pace : 0;
  const lights = new Map(w.trafficLights.map((light) => [light.intersectionId, light]));
  const paths = slotPathsOf(w);
  for (const slot of c.walkers()) {
    if (view !== undefined) {
      // A walk of a kilometre keeps within this of its ends, detours around a block included.
      const [fx, fy, tx, ty] = [c.walkFromX[slot]!, c.walkFromY[slot]!, c.destX[slot]!, c.destY[slot]!];
      const reach = Math.abs(fx - tx) + Math.abs(fy - ty);
      if (Math.max(fx, tx) + reach < view.minX || Math.min(fx, tx) - reach > view.maxX || Math.max(fy, ty) + reach < view.minY || Math.min(fy, ty) - reach > view.maxY) continue;
    }
    const path = walkerPath(w, slot, paths);
    const progress = c.walkProgress[slot]!;
    const [x, y, heading] = poseAt(path, ahead > 0 ? Math.max(Math.min(progress + ahead, drawnLimit(path, progress, lights)), progress) : progress);
    if (!inTileView(view, x, y)) continue;
    const at = tileFToWorld(w.mapConfig, x, y);
    visit(slot, c.generation[slot]!, at.x, at.y, heading);
  }
}
