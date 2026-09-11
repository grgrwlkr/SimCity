// Grid fixtures for the lanelet tests, each a port of the Rust test helper of the same name.
import type { RoadDir, TilePos } from '../../src/commands';
import { IntersectionIndex, buildIntersectionClusters } from '../../src/intersections/index';
import { MapGrid } from '../../src/map/grid';
import { buildLaneGraphInner, type LaneGraph } from '../../src/transport/laneGraph';
import {
  TileSet,
  buildLaneletGraphInner,
  type LaneletConflictMatrices,
} from '../../src/transport/lanelet/build';
import type { LaneletGraph } from '../../src/transport/lanelet/graph';
import { defaultTrafficConfig } from '../../src/traffic/config';
import { setRoad } from '../transport/helpers';

export const t = (x: number, y: number): TilePos => ({ x, y });

/** `IntersectionIndex` for `grid` at version 1, clusters found by flood fill. */
export function indexFor(grid: MapGrid): IntersectionIndex {
  const index = new IntersectionIndex();
  const { clusters, tileToIntersection } = buildIntersectionClusters(grid);
  index.version = 1;
  index.clusters = clusters;
  index.tileToIntersection = tileToIntersection;
  return index;
}

export interface Built {
  readonly grid: MapGrid;
  readonly lanes: LaneGraph;
  readonly graph: LaneletGraph;
  readonly matrices: LaneletConflictMatrices;
}

/** Runs `build_lanelet_graph` once at graph version 1 with the default traffic config. */
export function buildLanelets(grid: MapGrid): Built {
  const lanes = buildLaneGraphInner(grid, 1);
  const { graph, matrices } = buildLaneletGraphInner(grid, indexFor(grid), lanes, 1, defaultTrafficConfig());
  return { grid, lanes, graph, matrices };
}

/** build.rs `build_cross_grid`: 9x9, a 2x2 box at (4,4)-(5,5), one lane per direction. */
export function buildCrossGrid(): MapGrid {
  const grid = new MapGrid(9, 9);
  for (const [x, y] of [
    [4, 4],
    [4, 5],
    [5, 4],
    [5, 5],
  ] as const) {
    setRoad(grid, t(x, y), { dir: 'None' });
  }
  const put = (x: number, y: number, dir: RoadDir) => setRoad(grid, t(x, y), { dir });
  for (let x = 0; x < 4; x++) put(x, 4, 'East');
  for (let x = 6; x < 9; x++) put(x, 4, 'East');
  for (let x = 6; x < 9; x++) put(x, 5, 'West');
  for (let x = 0; x < 4; x++) put(x, 5, 'West');
  for (let y = 0; y < 4; y++) put(4, y, 'North');
  for (let y = 6; y < 9; y++) put(4, y, 'North');
  for (let y = 6; y < 9; y++) put(5, y, 'South');
  for (let y = 0; y < 4; y++) put(5, y, 'South');
  return grid;
}

/** build.rs `build_two_lane_cross_grid`: 12x12, a 4x4 box at 4..=7, two lane tiles per direction. */
export function buildTwoLaneCrossGrid(): MapGrid {
  const grid = new MapGrid(12, 12);
  for (let x = 4; x <= 7; x++) for (let y = 4; y <= 7; y++) setRoad(grid, t(x, y), { dir: 'None' });
  const put = (x: number, y: number, dir: RoadDir) => setRoad(grid, t(x, y), { dir });
  for (const y of [4, 5]) {
    for (let x = 0; x < 4; x++) put(x, y, 'East');
    for (let x = 8; x < 12; x++) put(x, y, 'East');
  }
  for (const y of [6, 7]) {
    for (let x = 8; x < 12; x++) put(x, y, 'West');
    for (let x = 0; x < 4; x++) put(x, y, 'West');
  }
  for (const x of [4, 5]) {
    for (let y = 0; y < 4; y++) put(x, y, 'North');
    for (let y = 8; y < 12; y++) put(x, y, 'North');
  }
  for (const x of [6, 7]) {
    for (let y = 8; y < 12; y++) put(x, y, 'South');
    for (let y = 0; y < 4; y++) put(x, y, 'South');
  }
  return grid;
}

/** Rectangular box `x in x0..=x1`, `y in y0..=y1`. */
export function boxRect(x0: number, x1: number, y0: number, y1: number): TileSet {
  const tiles: TilePos[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push(t(x, y));
  return new TileSet(tiles);
}

export const box2x2 = () => boxRect(4, 5, 4, 5);
export const box3x3 = () => boxRect(4, 6, 4, 6);
export const box4x4 = () => boxRect(4, 7, 4, 7);

export function isSimple(path: readonly TilePos[]): boolean {
  return new Set(path.map((p) => `${p.x},${p.y}`)).size === path.length;
}

/** The path has a tile on every side of the center point `c`. */
export function enclosesCenter(path: readonly TilePos[], c: readonly [number, number]): boolean {
  return (
    path.some((p) => p.x < c[0]) &&
    path.some((p) => p.x + 1 > c[0]) &&
    path.some((p) => p.y < c[1]) &&
    path.some((p) => p.y + 1 > c[1])
  );
}

export function isFourAdjacent(path: readonly TilePos[]): boolean {
  for (let i = 1; i < path.length; i++) {
    if (Math.abs(path[i]!.x - path[i - 1]!.x) + Math.abs(path[i]!.y - path[i - 1]!.y) !== 1) return false;
  }
  return true;
}
