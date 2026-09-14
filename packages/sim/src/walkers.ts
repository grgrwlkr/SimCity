// Stage 3½: pedestrians. A citizen on foot walks the pavements — the lane tiles beside a kerb, on the kerb side — and
// crosses a road only through an intersection box, where a crossing with a light waits for the walker's green. The path
// comes from the map and is cached; how far along it a walker is, is state of the citizens, moved every tick by
// `moveWalkers`. A road with no box within reach of the goal is crossed where it must be, at a price no detour pays.
import { DEFAULT_GAME_HOUR_NS } from './city';
import { TICK_DT_NS, periodTicks } from './rates';
import { SECOND_NS } from './timer';
import type { TilePos } from './commands';
import { inTileView, tileFToWorld, type TileView } from './map/coords';
import type { MapGrid } from './map/grid';
import { LinkHeap } from './meso/districts';
import { isGreen, type TrafficLight } from './traffic/lights';
import { adjacentRoadTowards } from './transport/anchors';
import type { World } from './world';

const f32 = Math.fround;
const PI = f32(Math.PI);
const HALF_PI = f32(Math.PI / 2);

/** How far a walker keeps from a tile's middle towards its kerb, tiles. */
const KERB_OFFSET = 0.4;
/** A step across a road away from any box, or along the middle of a wide one, costs this many tiles of walking. */
const OFF_CROSSING_COST = 200;
/** A search that looks at more tiles than this gives up, and the walker goes straight. */
const MAX_EXPANDED = 20_000;
/** What a crossing with a light is expected to add to a walk, seconds: about a quarter of a signal cycle. */
export const LIT_CROSSING_WAIT_SECS = 15;
/** Paths kept per world before the cache starts over. */
const PATH_CACHE_LIMIT = 20_000;
/** Walkers step this much game time at once; the renderer draws them on between their steps. */
export const WALKER_STEP_NS = SECOND_NS;

// `ROAD_DIRS` indices.
const WEST = 1;
const EAST = 2;

export interface WalkPath {
  /** x, y of each corner, tile coordinates: the start, a point on every tile walked, the goal. */
  readonly points: Float32Array;
  /** Length of the path up to each corner, tiles along the axes. */
  readonly along: Float32Array;
  /** For the step into each corner: the intersection whose light it waits for before it starts, -1 for none. */
  readonly gate: Int32Array;
  /** For the step into each corner: 1 when it runs east–west. */
  readonly eastWest: Uint8Array;
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
 * `OFF_CROSSING_COST` for stepping from one lane across to another or onto a lane with no kerb but the goal.
 */
function stepPenalty(grid: MapGrid, i: number, j: number, dx: number, goal: number): number {
  if (isBox(grid, i) || isBox(grid, j)) return 0;
  const along = (tile: number) => runsEastWest(grid, tile) === (dx !== 0);
  if (!along(i) || !along(j)) return OFF_CROSSING_COST;
  if (j === goal) return 0;
  const [kx, ky] = kerbSide(grid, j % grid.width, Math.floor(j / grid.width));
  return kx === 0 && ky === 0 ? OFF_CROSSING_COST : 0;
}

/** Tile indices from `start` to `goal` over road tiles, by the pavements and the boxes; `null` without a way. */
function roadPath(grid: MapGrid, start: number, goal: number): number[] | null {
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
      const next = cost[i]! + 1 + stepPenalty(grid, i, j, dx, goal);
      if (reached[j] === search && next >= cost[j]!) continue;
      reached[j] = search;
      cost[j] = next;
      parent[j] = i;
      heap.push(next + Math.abs(gx - nx) + Math.abs(gy - ny), j);
    }
  }
  return null;
}

function buildPath(w: World, from: TilePos, to: TilePos): WalkPath {
  const grid = w.grid;
  const start = adjacentRoadTowards(grid, from, to);
  const goal = adjacentRoadTowards(grid, to, from);
  const tiles = start !== undefined && goal !== undefined ? (roadPath(grid, grid.idx(start)!, grid.idx(goal)!) ?? []) : [];
  const n = tiles.length + 2;
  const points = new Float32Array(2 * n);
  const along = new Float32Array(n);
  const gate = new Int32Array(n).fill(-1);
  const eastWest = new Uint8Array(n);
  points[0] = from.x;
  points[1] = from.y;
  tiles.forEach((i, k) => {
    const [x, y] = [i % grid.width, Math.floor(i / grid.width)];
    const [kx, ky] = isBox(grid, i) ? [0, 0] : kerbSide(grid, x, y);
    points[2 * (k + 1)] = x + kx * KERB_OFFSET;
    points[2 * (k + 1) + 1] = y + ky * KERB_OFFSET;
    if (k === 0) return;
    const before = tiles[k - 1]!;
    eastWest[k + 1] = Math.abs(i - before) === 1 ? 1 : 0;
    // A crossing starts on the step into a box, and again where the walker turns inside it.
    const continues = k >= 2 && isBox(grid, before) && eastWest[k] === eastWest[k + 1];
    if (isBox(grid, i) && !continues) gate[k + 1] = w.intersections.intersectionIdAt({ x, y }) ?? -1;
  });
  points[2 * (n - 1)] = to.x;
  points[2 * (n - 1) + 1] = to.y;
  for (let k = 1; k < n; k++) {
    along[k] = along[k - 1]! + Math.abs(points[2 * k]! - points[2 * k - 2]!) + Math.abs(points[2 * k + 1]! - points[2 * k - 1]!);
  }
  return { points, along, gate, eastWest };
}

/** The path a walk from `from` to `to` takes on the current roads. */
export function walkPath(w: World, from: TilePos, to: TilePos): WalkPath {
  const key = w.graphVersion;
  let cached = pathCache.get(w);
  if (cached === undefined || cached.key !== key || cached.paths.size >= PATH_CACHE_LIMIT) {
    cached = { key, paths: new Map() };
    pathCache.set(w, cached);
  }
  const id = `${from.x},${from.y}>${to.x},${to.y}`;
  let path = cached.paths.get(id);
  if (path === undefined) {
    path = buildPath(w, from, to);
    cached.paths.set(id, path);
  }
  return path;
}

type SlotPath = { fx: number; fy: number; tx: number; ty: number; path: WalkPath } | undefined;
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
  const [fx, fy, tx, ty] = [c.walkFromX[slot]!, c.walkFromY[slot]!, c.destX[slot]!, c.destY[slot]!];
  const known = entries[slot];
  if (known !== undefined && known.fx === fx && known.fy === fy && known.tx === tx && known.ty === ty) return known.path;
  const path = walkPath(w, { x: fx, y: fy }, { x: tx, y: ty });
  entries[slot] = { fx, fy, tx, ty, path };
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
 * `SimStep::Traffic`, after the lights: every walker goes on at walking pace. At the corner before a crossing with a
 * light a walker waits until their direction is green; once on the crossing they walk on. Walks end with their citizen's
 * arrival, which the planner keeps.
 */
export function moveWalkers(w: World, dtNs: number): void {
  const c = w.citizens;
  if (c.onFootCount === 0) return;
  const seconds = (dtNs / 1e9) * (DEFAULT_GAME_HOUR_NS / w.gameHourNs);
  const pace = w.citizenConfig.walkKmh / 3.6 / w.trafficConfig.tileMeters;
  let lights: Map<number, TrafficLight> | undefined;
  const paths = slotPathsOf(w);
  const limits = c.walkLimit;
  const stride = pace * seconds;
  for (const slot of c.walkers()) {
    // Inside a segment and not at a crossing to wait at: the step below would add the stride and stop there.
    const at = c.walkProgress[slot]!;
    if (at + stride < limits[slot]!) {
      c.walkProgress[slot] = at + stride;
      continue;
    }
    const { along, gate, eastWest } = walkerPath(w, slot, paths);
    const total = along[along.length - 1]!;
    let progress = at;
    let k = segmentAt(along, progress, false);
    for (let budget = pace * seconds; budget > 0 && progress < total; ) {
      if (progress === along[k - 1] && gate[k]! >= 0) {
        lights ??= new Map(w.trafficLights.map((light) => [light.intersectionId, light]));
        const light = lights.get(gate[k]!);
        if (light !== undefined && !isGreen(light, eastWest[k] === 1 ? 'East' : 'North')) break;
      }
      const step = Math.min(budget, along[k]! - progress);
      budget -= step;
      progress += step;
      if (progress >= along[k]!) {
        progress = along[k]!;
        k += 1;
      }
    }
    c.walkProgress[slot] = progress;
    const stored = c.walkProgress[slot]!;
    const next = segmentAt(along, stored, false);
    limits[slot] = stored >= total || (stored === along[next - 1] && gate[next]! >= 0) ? -1 : along[next]!;
  }
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

/** How far along its path a walker may be drawn: the corner before the first crossing ahead whose light holds it now. */
function drawnLimit(path: WalkPath, progress: number, lights: ReadonlyMap<number, TrafficLight>): number {
  const { along, gate, eastWest } = path;
  const last = along.length - 1;
  for (let k = 1; k <= last; k++) {
    if (along[k - 1]! < progress || gate[k]! < 0) continue;
    const light = lights.get(gate[k]!);
    if (light !== undefined && !isGreen(light, eastWest[k] === 1 ? 'East' : 'North')) return along[k - 1]!;
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
