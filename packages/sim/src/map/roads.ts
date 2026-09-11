// Road data helpers: port of simcity_core/src/game/roads.rs (the parts the map commands use).
import type { RoadCell, RoadDir, RoadFlow, RoadKind } from '../commands';

const LANES: Readonly<Record<RoadKind, number>> = { None: 0, TwoLane: 2, FourLane: 4, SixLane: 6 };
const BUILD_COST: Readonly<Record<RoadKind, number>> = { None: 0, TwoLane: 10, FourLane: 30, SixLane: 60 };

export interface IVec2 {
  readonly x: number;
  readonly y: number;
}

const DELTA: Readonly<Record<RoadDir, IVec2>> = {
  None: { x: 0, y: 0 },
  West: { x: -1, y: 0 },
  East: { x: 1, y: 0 },
  North: { x: 0, y: 1 },
  South: { x: 0, y: -1 },
};

const OPPOSITE: Readonly<Record<RoadDir, RoadDir>> = {
  None: 'None',
  West: 'East',
  East: 'West',
  North: 'South',
  South: 'North',
};

export function roadLanes(kind: RoadKind): number {
  return LANES[kind];
}

/** Build cost per tile. */
export function roadBuildCost(kind: RoadKind): number {
  return BUILD_COST[kind];
}

/** Build cost per lane tile, when a road occupies one tile per lane (integer division, at least 1). */
export function buildCostPerLaneTile(kind: RoadKind): number {
  return Math.max(Math.floor(BUILD_COST[kind] / Math.max(LANES[kind], 1)), 1);
}

/** Whether `to` is a strict upgrade over `from`. */
export function isUpgrade(from: RoadKind, to: RoadKind): boolean {
  return LANES[to] > LANES[from];
}

export function dirDelta(dir: RoadDir): IVec2 {
  return DELTA[dir];
}

export function dirOpposite(dir: RoadDir): RoadDir {
  return OPPOSITE[dir];
}

export function roadCellNone(): RoadCell {
  return { kind: 'None', dir: 'None', lane: 0, flow: { kind: 'TwoWay' }, laneType: 'Regular' };
}

export function roadCellIsSome(cell: RoadCell): boolean {
  return cell.kind !== 'None';
}

function flowEquals(a: RoadFlow, b: RoadFlow): boolean {
  return a.kind === 'TwoWay' ? b.kind === 'TwoWay' : b.kind === 'OneWay' && a.dir === b.dir;
}

export function roadCellEquals(a: RoadCell, b: RoadCell): boolean {
  return (
    a.kind === b.kind && a.dir === b.dir && a.lane === b.lane && a.laneType === b.laneType && flowEquals(a.flow, b.flow)
  );
}
