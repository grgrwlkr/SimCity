// Stage 3½: pedestrians as the renderer sees them. A citizen on foot goes from where the walk started to where it ends
// over the road tiles, keeping to those beside a kerb where it can and to the kerb side of each, at the pace that brings
// them there at the minute they arrive. Paths are derived per walk and cached here, never state.
import { gameSecond } from './city';
import type { TilePos } from './commands';
import { tileFToWorld } from './map/coords';
import type { MapGrid } from './map/grid';
import { LinkHeap } from './meso/districts';
import { adjacentRoadTowards } from './transport/anchors';
import type { World } from './world';

const f32 = Math.fround;
const PI = f32(Math.PI);
const HALF_PI = f32(Math.PI / 2);

/** How far a walker keeps from a tile's middle towards its kerb, tiles. */
const KERB_OFFSET = 0.4;
/** A step onto a tile with no kerb costs this many: walkers keep to the pavement and cross where they must. */
const INNER_COST = 3;
/** A search that looks at more tiles than this gives up, and the walker goes straight. */
const MAX_EXPANDED = 20_000;

/** `slot` and `generation` of the citizen; world coordinates. */
export type WalkerVisitor = (slot: number, generation: number, x: number, y: number, heading: number) => void;

interface Walk {
  readonly startSec: number;
  readonly toX: number;
  readonly toY: number;
  /** x, y of each corner of the path, tile coordinates. */
  readonly points: Float32Array;
  /** Length of the path up to each corner, tiles along the axes. */
  readonly along: Float32Array;
  seen: number;
}

const walksOf = new WeakMap<World, Map<number, Walk>>();
let pass = 0;

// Scratch of the path search, reused between searches; never state.
let cost = new Float64Array(0);
let parent = new Int32Array(0);
let reached = new Uint32Array(0);
let search = 0;

/** The side of a road tile its kerb is on, as a unit step; (0, 0) for a tile with road all round. */
function kerbSide(grid: MapGrid, x: number, y: number): readonly [number, number] {
  for (const [dx, dy] of [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ] as const) {
    const i = grid.idx({ x: x + dx, y: y + dy });
    if (i === undefined || grid.roadKind[i] === 0) return [dx, dy];
  }
  return [0, 0];
}

/** Tile indices from `start` to `goal` over road tiles, cheapest by the kerb; `null` without a way. */
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
      if (j === undefined || grid.roadKind[j] === 0) continue;
      const [kx, ky] = kerbSide(grid, x + dx, y + dy);
      const next = cost[i]! + (kx === 0 && ky === 0 ? INNER_COST : 1);
      if (reached[j] === search && next >= cost[j]!) continue;
      reached[j] = search;
      cost[j] = next;
      parent[j] = i;
      heap.push(next + Math.abs(gx - (x + dx)) + Math.abs(gy - (y + dy)), j);
    }
  }
  return null;
}

function buildWalk(w: World, from: TilePos, to: TilePos, startSec: number): Walk {
  const grid = w.grid;
  const corners: number[] = [from.x, from.y];
  const start = adjacentRoadTowards(grid, from, to);
  const goal = adjacentRoadTowards(grid, to, from);
  const path = start !== undefined && goal !== undefined ? roadPath(grid, grid.idx(start)!, grid.idx(goal)!) : null;
  for (const i of path ?? []) {
    const [x, y] = [i % grid.width, Math.floor(i / grid.width)];
    const [kx, ky] = kerbSide(grid, x, y);
    corners.push(x + kx * KERB_OFFSET, y + ky * KERB_OFFSET);
  }
  corners.push(to.x, to.y);
  const points = Float32Array.from(corners);
  const along = new Float32Array(points.length / 2);
  for (let k = 1; k < along.length; k++) {
    along[k] = along[k - 1]! + Math.abs(points[2 * k]! - points[2 * k - 2]!) + Math.abs(points[2 * k + 1]! - points[2 * k - 1]!);
  }
  return { startSec, toX: to.x, toY: to.y, points, along, seen: 0 };
}

/** Where along `walk` a walker is at `share` of the way, and its heading along the axis it mostly moves on. */
function poseAlong(walk: Walk, share: number): readonly [x: number, y: number, heading: number] {
  const { points, along } = walk;
  const last = along.length - 1;
  const target = along[last]! * share;
  let k = 1;
  while (k < last && along[k]! < target) k += 1;
  const [ax, ay, bx, by] = [points[2 * k - 2]!, points[2 * k - 1]!, points[2 * k]!, points[2 * k + 1]!];
  const span = along[k]! - along[k - 1]!;
  const t = span > 0 ? Math.min(Math.max((target - along[k - 1]!) / span, 0), 1) : 1;
  const [dx, dy] = [bx - ax, by - ay];
  const heading = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : PI) : dy >= 0 ? HALF_PI : -HALF_PI;
  return [ax + dx * t, ay + dy * t, heading];
}

/** Every citizen on foot, in slot order. */
export function forEachWalker(w: World, visit: WalkerVisitor): void {
  const c = w.citizens;
  const walks = walksOf.get(w) ?? new Map<number, Walk>();
  walksOf.set(w, walks);
  pass += 1;
  if (c.onFootCount > 0) {
    const now = gameSecond(w);
    for (let slot = 0; slot < c.highWater; slot++) {
      if (c.alive[slot] !== 1 || c.onFoot[slot] !== 1) continue;
      const startSec = c.walkStartSec[slot]!;
      const [toX, toY] = [c.destX[slot]!, c.destY[slot]!];
      let walk = walks.get(slot);
      if (walk === undefined || walk.startSec !== startSec || walk.toX !== toX || walk.toY !== toY) {
        walk = buildWalk(w, { x: c.walkFromX[slot]!, y: c.walkFromY[slot]! }, { x: toX, y: toY }, startSec);
        walks.set(slot, walk);
      }
      walk.seen = pass;
      const arriveSec = c.nextAt[slot]! * 60;
      const share = arriveSec > startSec ? Math.min(Math.max((now - startSec) / (arriveSec - startSec), 0), 1) : 1;
      const [x, y, heading] = poseAlong(walk, share);
      const at = tileFToWorld(w.mapConfig, x, y);
      visit(slot, c.generation[slot]!, at.x, at.y, heading);
    }
  }
  for (const [slot, walk] of walks) if (walk.seen !== pass) walks.delete(slot);
}
