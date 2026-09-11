// Lit crosses fed with lanelet-routed waves: the live views (`?scenario=signalized`, `?scenario=signalized4`)
// and the traffic-flow measurements of stage 2.
import type { RoadDir, RoadKind, TilePos } from '../commands';
import { detectIntersections } from '../intersections/index';
import { bumpVersion } from '../map/dirty';
import { tileKey, type MapGrid } from '../map/grid';
import { dirLeft, dirOpposite, isLeftmostForDir, isRightmostForDir } from '../map/roads';
import { TrafficOccupancy } from '../traffic/occupancy';
import { refSlot, spawnVehicle } from '../traffic/vehicles';
import { findRoute, type Route } from '../transport/lanelet/pathfinding';
import type { World } from '../world';

export const SIGNALIZED_CROSS = { lo: 20, hi: 60, box: { x: 40, y: 40 } } as const;
const FACTORS = [0.8, 1.0, 1.2, 0.9].map(Math.fround);

/** `twoLane`: one lane each way meeting in a 2×2 box; `fourLane`: two lanes each way, a 4×4 box. */
export type CrossLayout = 'twoLane' | 'fourLane';
export type CrossScenarioName = 'signalizedCross' | 'signalizedCross4';
export const CROSS_LAYOUT: Readonly<Record<CrossScenarioName, CrossLayout>> = {
  signalizedCross: 'twoLane',
  signalizedCross4: 'fourLane',
};

/** Default ticks between waves per layout: the densest measured feed that still clears every car within 120 s. */
export const CROSS_SPAWN_EVERY: Readonly<Record<CrossLayout, number>> = { twoLane: 100, fourLane: 80 };

type Line = readonly [at: number, dir: RoadDir, lane: number];

/** Right-hand traffic as the road tool paints it: the row of each east-west lane, the column of each north-south one. */
const PAINT: Readonly<Record<CrossLayout, { readonly kind: RoadKind; readonly rows: readonly Line[]; readonly columns: readonly Line[] }>> = {
  twoLane: {
    kind: 'TwoLane',
    rows: [
      [40, 'East', 0],
      [41, 'West', 1],
    ],
    columns: [
      [41, 'North', 0],
      [40, 'South', 1],
    ],
  },
  fourLane: {
    kind: 'FourLane',
    rows: [
      [40, 'East', 0],
      [41, 'East', 1],
      [42, 'West', 2],
      [43, 'West', 3],
    ],
    columns: [
      [43, 'North', 0],
      [42, 'North', 1],
      [40, 'South', 3],
      [41, 'South', 2],
    ],
  },
};

/** Tiles along a side of the layout's box, which starts at `SIGNALIZED_CROSS.box`. */
export function crossBoxSize(layout: CrossLayout): number {
  return PAINT[layout].rows.length;
}

/** The layout's two roads from `lo` to `hi`, crossing in a box at `SIGNALIZED_CROSS.box`. */
export function buildSignalizedCross(
  grid: MapGrid,
  layout: CrossLayout = 'twoLane',
  lo: number = SIGNALIZED_CROSS.lo,
  hi: number = SIGNALIZED_CROSS.hi,
): void {
  const { kind, rows, columns } = PAINT[layout];
  const road = (x: number, y: number, dir: RoadDir, lane: number) => {
    const cell = grid.get({ x, y });
    if (cell === undefined) return;
    grid.set({ x, y }, { ...cell, water: false, road: { kind, dir, lane, flow: { kind: 'TwoWay' }, laneType: 'Regular' } });
  };
  const boxRows = new Set(rows.map(([y]) => y));
  const boxColumns = new Set(columns.map(([x]) => x));
  for (let i = lo; i <= hi; i++) {
    if (!boxColumns.has(i)) for (const [y, dir, lane] of rows) road(i, y, dir, lane);
    if (!boxRows.has(i)) for (const [x, dir, lane] of columns) road(x, i, dir, lane);
  }
  for (const [y] of rows) for (const [x] of columns) road(x, y, 'None', 0);
}

const APPROACHES: readonly RoadDir[] = ['East', 'West', 'North', 'South'];

interface LaneEnds {
  readonly dir: RoadDir;
  readonly entry: TilePos;
  readonly exit: TilePos;
}

/**
 * Per approach (East, West, North, South entry) its routes onto the other three roads, from the lanelet
 * planner without jitter (ПДД 8.5): straight on from every lane, a left turn from the lane by the
 * centerline, a right turn from the curb lane, each onto the matching lane. Needs the current lanelets.
 */
export function signalizedCrossRoutes(
  w: World,
  layout: CrossLayout = 'twoLane',
  lo: number = SIGNALIZED_CROSS.lo,
  hi: number = SIGNALIZED_CROSS.hi,
): Route[][] {
  const { rows, columns } = PAINT[layout];
  const lanes: LaneEnds[] = [
    ...rows.map(([y, dir]) => {
      const [from, to] = dir === 'East' ? [lo, hi] : [hi, lo];
      return { dir, entry: { x: from, y }, exit: { x: to, y } };
    }),
    ...columns.map(([x, dir]) => {
      const [from, to] = dir === 'North' ? [lo, hi] : [hi, lo];
      return { dir, entry: { x, y: from }, exit: { x, y: to } };
    }),
  ];
  const ctx = { grid: w.grid, traffic: new TrafficOccupancy(), cfg: w.pathfindingConfig, jitterSeed: 0n };
  const laneAt = (tile: TilePos) => {
    const id = w.laneGraph.posToId.get(tileKey(tile));
    if (id === undefined) throw new Error(`signalized cross: no lane at (${tile.x},${tile.y})`);
    return id;
  };
  const lanesOf = (dir: RoadDir) => lanes.filter((l) => l.dir === dir);
  const pick = (dir: RoadDir, test: typeof isLeftmostForDir) => {
    const lane = lanesOf(dir).find((l) => test(w.grid.get(l.entry)!.road));
    if (lane === undefined) throw new Error(`signalized cross: no such ${dir} lane`);
    return lane;
  };
  const route = (from: LaneEnds, to: LaneEnds) => findRoute(w.laneGraph, w.laneletGraph, ctx, laneAt(from.entry), laneAt(to.exit));
  return APPROACHES.map((dir) =>
    APPROACHES.filter((exit) => exit !== dirOpposite(dir)).flatMap((exit) => {
      if (exit === dir) return lanesOf(dir).map((lane) => route(lane, lane));
      const test = exit === dirLeft(dir) ? isLeftmostForDir : isRightmostForDir;
      return [route(pick(dir, test), pick(exit, test))];
    }),
  );
}

/** One vehicle per approach, the route rotating with the wave, each with its lanelet plan. */
export function spawnSignalizedWave(w: World, routes: readonly Route[][], wave: number): number[] {
  const v = w.vehicles;
  return routes.map((set, s) => {
    const route = set[(wave + s) % set.length]!;
    const ref = spawnVehicle(w, { route: route.tiles, speedFactor: FACTORS[(wave + s) % 4]! });
    v.laneletPlan[refSlot(v, ref)] = {
      entries: route.sidecar.map((e) => [e[0], e[1], e[2]] as const),
      builtFor: w.laneletGraph.version,
    };
    return ref;
  });
}

/** The live scenario: builds the cross and requests its light now, then feeds waves as ticks pass. */
export class SignalizedCrossScenario {
  spawned = 0;
  private routes: Route[][] | null = null;
  private nextWaveTick = 0;
  private wave = 0;
  private readonly spawnEvery: number;

  constructor(
    w: World,
    spawnEvery?: number,
    private readonly layout: CrossLayout = 'twoLane',
  ) {
    this.spawnEvery = spawnEvery ?? CROSS_SPAWN_EVERY[layout];
    buildSignalizedCross(w.grid, layout);
    // What CommandApply and GraphUpdate do after a map edit: the graphs rebuild on the next tick.
    w.graphVersion = bumpVersion(w.graphVersion);
    w.mapEditVersion = bumpVersion(w.mapEditVersion);
    w.dirty.markAll();
    w.roadDirty.markAll();
    detectIntersections(w);
    w.commands.push({ kind: 'PlaceTrafficLight', pos: SIGNALIZED_CROSS.box });
  }

  /** Call before each fixed tick: routes once the lanelets exist, then a wave whenever one is due. */
  advance(w: World): void {
    if (this.routes === null) {
      if (!w.laneletGraph.isBuiltFor(w.graphVersion, w.grid)) return;
      this.routes = signalizedCrossRoutes(w, this.layout);
      this.nextWaveTick = w.tick;
    }
    if (w.tick < this.nextWaveTick) return;
    this.spawned += spawnSignalizedWave(w, this.routes, this.wave).length;
    this.wave += 1;
    this.nextWaveTick += this.spawnEvery;
  }
}
