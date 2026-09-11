// A lit two-lane cross fed with lanelet-routed waves: the stage 2b gate scenario (examples/dump_signalized.rs)
// and the live view (`?scenario=signalized`).
import type { RoadDir, TilePos } from '../commands';
import { detectIntersections } from '../intersections/index';
import { bumpVersion } from '../map/dirty';
import { tileKey, type MapGrid } from '../map/grid';
import { TrafficOccupancy } from '../traffic/occupancy';
import { refSlot, spawnVehicle } from '../traffic/vehicles';
import { findRoute, type Route } from '../transport/lanelet/pathfinding';
import type { World } from '../world';

export const SIGNALIZED_CROSS = { lo: 20, hi: 60, box: { x: 40, y: 40 }, spawnEvery: 50 } as const;
const FACTORS = [0.8, 1.0, 1.2, 0.9].map(Math.fround);

/**
 * Right-hand traffic as the road tool paints it: rows 40 (East) and 41 (West), columns 41 (North)
 * and 40 (South), a 2×2 box where they cross.
 */
export function buildSignalizedCross(grid: MapGrid, lo: number = SIGNALIZED_CROSS.lo, hi: number = SIGNALIZED_CROSS.hi): void {
  const road = (x: number, y: number, dir: RoadDir, lane: number) => {
    const cell = grid.get({ x, y });
    if (cell === undefined) return;
    grid.set({ x, y }, { ...cell, water: false, road: { kind: 'TwoLane', dir, lane, flow: { kind: 'TwoWay' }, laneType: 'Regular' } });
  };
  for (let i = lo; i <= hi; i++) {
    if (i === 40 || i === 41) continue;
    road(i, 40, 'East', 0);
    road(i, 41, 'West', 1);
    road(41, i, 'North', 0);
    road(40, i, 'South', 1);
  }
  for (const [x, y] of [
    [40, 40],
    [41, 40],
    [40, 41],
    [41, 41],
  ] as const) {
    road(x, y, 'None', 0);
  }
}

/**
 * Per approach (East, West, North, South entry) the routes to the three exits that are not a U-turn,
 * from the lanelet planner without jitter. Needs the lanelets of the current graph.
 */
export function signalizedCrossRoutes(w: World, lo: number = SIGNALIZED_CROSS.lo, hi: number = SIGNALIZED_CROSS.hi): Route[][] {
  const ends: ReadonlyArray<readonly [entry: TilePos, exit: TilePos, opposite: number]> = [
    [{ x: lo, y: 40 }, { x: hi, y: 40 }, 1],
    [{ x: hi, y: 41 }, { x: lo, y: 41 }, 0],
    [{ x: 41, y: lo }, { x: 41, y: hi }, 3],
    [{ x: 40, y: hi }, { x: 40, y: lo }, 2],
  ];
  const ctx = { grid: w.grid, traffic: new TrafficOccupancy(), cfg: w.pathfindingConfig, jitterSeed: 0n };
  const laneAt = (tile: TilePos) => {
    const id = w.laneGraph.posToId.get(tileKey(tile));
    if (id === undefined) throw new Error(`signalized cross: no lane at (${tile.x},${tile.y})`);
    return id;
  };
  return ends.map(([entry, , opposite]) =>
    [0, 1, 2, 3].filter((g) => g !== opposite).map((g) => findRoute(w.laneGraph, w.laneletGraph, ctx, laneAt(entry), laneAt(ends[g]![1]))),
  );
}

/** One vehicle per approach, the maneuver rotating with the wave, each with its lanelet plan. */
export function spawnSignalizedWave(w: World, routes: readonly Route[][], wave: number): number[] {
  const v = w.vehicles;
  return routes.map((set, s) => {
    const route = set[(wave + s) % 3]!;
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

  constructor(
    w: World,
    private readonly spawnEvery: number = SIGNALIZED_CROSS.spawnEvery,
  ) {
    buildSignalizedCross(w.grid);
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
      this.routes = signalizedCrossRoutes(w);
      this.nextWaveTick = w.tick;
    }
    if (w.tick < this.nextWaveTick) return;
    this.spawned += spawnSignalizedWave(w, this.routes, this.wave).length;
    this.wave += 1;
    this.nextWaveTick += this.spawnEvery;
  }
}
