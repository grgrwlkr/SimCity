// Grid fixtures shared by the transport tests, each a port of the Rust test helper of the same name.
import type { LaneType, RoadDir, RoadFlow, RoadKind, TilePos } from '../../src/commands';
import { MapGrid } from '../../src/map/grid';
import type { World } from '../../src/world';

export interface RoadSpec {
  readonly kind?: RoadKind;
  readonly dir: RoadDir;
  readonly lane?: number;
  readonly flow?: RoadFlow;
  readonly laneType?: LaneType;
}

export const TWO_WAY: RoadFlow = { kind: 'TwoWay' };
export const oneWay = (dir: RoadDir): RoadFlow => ({ kind: 'OneWay', dir });

/** Put a dry road tile at `pos`, keeping the rest of the cell. */
export function setRoad(grid: MapGrid, pos: TilePos, spec: RoadSpec): void {
  const cell = grid.get(pos);
  if (cell === undefined) return;
  grid.set(pos, {
    ...cell,
    water: false,
    road: {
      kind: spec.kind ?? 'TwoLane',
      dir: spec.dir,
      lane: spec.lane ?? 0,
      flow: spec.flow ?? TWO_WAY,
      laneType: spec.laneType ?? 'Regular',
    },
  });
}

/** Copy every layer of `grid` into the world's grid (same size). */
export function loadGrid(w: World, grid: MapGrid): void {
  const source = grid.layers();
  w.grid.layers().forEach((layer, i) => layer.set(source[i]!));
}

/**
 * transport/tests.rs `four_lane_turn_intersection_grid`: a 2x2 FourLane cluster in a 5x5 grid,
 * two northbound approaches (2,1) rightmost and (3,1) leftmost, and only a West exit — a must-turn T.
 */
export function fourLaneTurnIntersectionGrid(): MapGrid {
  const grid = new MapGrid(5, 5);
  setRoad(grid, { x: 2, y: 1 }, { kind: 'FourLane', dir: 'North', lane: 0 });
  setRoad(grid, { x: 3, y: 1 }, { kind: 'FourLane', dir: 'North', lane: 1 });
  for (const pos of [
    { x: 2, y: 2 },
    { x: 3, y: 2 },
    { x: 2, y: 3 },
    { x: 3, y: 3 },
  ]) {
    setRoad(grid, pos, { kind: 'FourLane', dir: 'None' });
  }
  setRoad(grid, { x: 1, y: 3 }, { kind: 'TwoLane', dir: 'West' });
  return grid;
}

/**
 * transport/tests.rs `oracle_crossing_grid` (and the crossing of route_oncoming_pins.rs): a 2x2 box
 * at (4,4)-(5,5); column 4 southbound, column 5 northbound, row 4 eastbound, row 5 westbound.
 */
export function oracleCrossingGrid(): MapGrid {
  const grid = new MapGrid(10, 10);
  for (const [x, y] of [
    [4, 4],
    [4, 5],
    [5, 4],
    [5, 5],
  ] as const) {
    setRoad(grid, { x, y }, { kind: 'FourLane', dir: 'None' });
  }
  for (const y of [0, 1, 2, 3, 6, 7, 8, 9]) {
    setRoad(grid, { x: 4, y }, { kind: 'FourLane', dir: 'South' });
    setRoad(grid, { x: 5, y }, { kind: 'FourLane', dir: 'North' });
  }
  for (const x of [0, 1, 2, 3, 6, 7, 8, 9]) {
    setRoad(grid, { x, y: 4 }, { kind: 'FourLane', dir: 'East' });
    setRoad(grid, { x, y: 5 }, { kind: 'FourLane', dir: 'West' });
  }
  return grid;
}

/**
 * transport/tests.rs `build_two_way_vertical_spur`: column `nx` northbound, column `sx` southbound
 * over y=1..=4 with nothing at y=5, so (nx,4) is a physical dead end. `northFlow` applies to column `nx`.
 */
export function buildTwoWayVerticalSpur(nx: number, sx: number, northFlow: RoadFlow): MapGrid {
  const grid = new MapGrid(8, 8);
  for (let y = 1; y <= 4; y++) {
    setRoad(grid, { x: nx, y }, { dir: 'North', flow: northFlow });
    setRoad(grid, { x: sx, y }, { dir: 'South' });
  }
  return grid;
}
