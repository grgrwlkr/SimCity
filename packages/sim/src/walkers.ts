// Stage 3½: pedestrians. A citizen on foot walks the pavements — the lane tiles beside a kerb, on the kerb side — and
// crosses a road only through an intersection box, where a crossing with a light waits for the walker's green. The path
// comes from the map and is cached; how far along it a walker is, is state of the citizens, moved every tick by
// `moveWalkers`. A road with no box within reach of the goal is crossed where it must be, at a price no detour pays.
import { DEFAULT_GAME_HOUR_NS } from './city';
import type { TilePos } from './commands';
import { tileFToWorld } from './map/coords';
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
const isBox = (grid: MapGrid, i: number) => grid.roadKind[i] !== 0 && grid.roadDir[i] === 0;
const runsEastWest = (grid: MapGrid, i: number) => grid.roadDir[i] === WEST || grid.roadDir[i] === EAST;

/** The side of a road tile its kerb is on, as a unit step; (0, 0) for a tile with road all round. */
function kerbSide(grid: MapGrid, x: number, y: number): readonly [number, number] {
  for (const [dx, dy] of [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ] as const) {
    const i = grid.idx({ x: x + dx, y: y + dy });
    if (i === undefined || !isRoad(grid, i)) return [dx, dy];
  }
  return [0, 0];
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
    const [x, y] = [i % width, Math.floor(i / width)];
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const j = grid.idx({ x: x + dx, y: y + dy });
      if (j === undefined || !isRoad(grid, j)) continue;
      const next = cost[i]! + 1 + stepPenalty(grid, i, j, dx, goal);
      if (reached[j] === search && next >= cost[j]!) continue;
      reached[j] = search;
      cost[j] = next;
      parent[j] = i;
      heap.push(next + Math.abs(gx - (x + dx)) + Math.abs(gy - (y + dy)), j);
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

/** Metres of a walk from `from` to `to`, and the crossings with a light on its way. */
export function walkMeasure(w: World, from: TilePos, to: TilePos): { readonly meters: number; readonly litCrossings: number } {
  const path = walkPath(w, from, to);
  const lit = new Set(w.trafficLights.map((light) => light.intersectionId));
  let litCrossings = 0;
  for (const intersection of path.gate) if (intersection >= 0 && lit.has(intersection)) litCrossings += 1;
  return { meters: path.along[path.along.length - 1]! * w.trafficConfig.tileMeters, litCrossings };
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
  for (let slot = 0; slot < c.highWater; slot++) {
    if (c.alive[slot] !== 1 || c.onFoot[slot] !== 1) continue;
    const { along, gate, eastWest } = walkPath(w, { x: c.walkFromX[slot]!, y: c.walkFromY[slot]! }, { x: c.destX[slot]!, y: c.destY[slot]! });
    const total = along[along.length - 1]!;
    let progress = c.walkProgress[slot]!;
    let k = 1;
    while (k < along.length - 1 && along[k]! <= progress) k += 1;
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
  }
}

/** Where along `path` a walker `progress` tiles on is, and its heading along the axis it mostly moves on. */
function poseAt(path: WalkPath, progress: number): readonly [x: number, y: number, heading: number] {
  const { points, along } = path;
  const last = along.length - 1;
  let k = 1;
  while (k < last && along[k]! < progress) k += 1;
  const [ax, ay, bx, by] = [points[2 * k - 2]!, points[2 * k - 1]!, points[2 * k]!, points[2 * k + 1]!];
  const span = along[k]! - along[k - 1]!;
  const t = span > 0 ? Math.min(Math.max((progress - along[k - 1]!) / span, 0), 1) : 1;
  const [dx, dy] = [bx - ax, by - ay];
  const heading = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : PI) : dy >= 0 ? HALF_PI : -HALF_PI;
  return [ax + dx * t, ay + dy * t, heading];
}

/** Every citizen on foot, in slot order. */
export function forEachWalker(w: World, visit: WalkerVisitor): void {
  const c = w.citizens;
  if (c.onFootCount === 0) return;
  for (let slot = 0; slot < c.highWater; slot++) {
    if (c.alive[slot] !== 1 || c.onFoot[slot] !== 1) continue;
    const path = walkPath(w, { x: c.walkFromX[slot]!, y: c.walkFromY[slot]! }, { x: c.destX[slot]!, y: c.destY[slot]! });
    const [x, y, heading] = poseAt(path, c.walkProgress[slot]!);
    const at = tileFToWorld(w.mapConfig, x, y);
    visit(slot, c.generation[slot]!, at.x, at.y, heading);
  }
}
