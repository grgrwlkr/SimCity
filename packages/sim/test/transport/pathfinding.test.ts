// Ported from crates/simcity_sim/src/game/transport/tests.rs and map/tests.rs (road-A*).
import { describe, expect, it } from 'vitest';
import type { TilePos } from '../../src/commands';
import { IntersectionIndex } from '../../src/intersections/index';
import { MapGrid } from '../../src/map/grid';
import { TrafficOccupancy } from '../../src/traffic/occupancy';
import { PathCache, defaultPathfindingConfig, findRoadPathCached, type PathfindingCtx } from '../../src/transport/pathfinding';
import { RoadGraph, rebuildRoadGraphInner } from '../../src/transport/roadGraph';
import { oracleCrossingGrid, setRoad } from './helpers';

function context(grid: MapGrid, traffic?: TrafficOccupancy): PathfindingCtx {
  const graph = new RoadGraph();
  rebuildRoadGraphInner(grid, 1, graph);
  const occupancy = traffic ?? new TrafficOccupancy();
  occupancy.ensureLen(grid.len());
  return {
    timeNowSec: 0,
    cfg: defaultPathfindingConfig(),
    cache: new PathCache(),
    graph,
    regions: null,
    traffic: occupancy,
    grid,
    intersections: new IntersectionIndex(),
  };
}

const hasStep = (path: readonly TilePos[], a: TilePos, b: TilePos) =>
  path.some((p, i) => i + 1 < path.length && p.x === a.x && p.y === a.y && path[i + 1]!.x === b.x && path[i + 1]!.y === b.y);

describe('road A*', () => {
  it('roadPathSmokeTestOnSimpleLine', () => {
    const grid = new MapGrid(5, 5);
    for (let x = 0; x < 5; x++) setRoad(grid, { x, y: 2 }, { dir: 'East' });

    const path = findRoadPathCached(context(grid), { x: 0, y: 2 }, { x: 4, y: 2 });
    expect(path.length, 'minimal length for a straight line is 5 tiles').toBe(5);
    expect(path[0]).toEqual({ x: 0, y: 2 });
    expect(path.at(-1)).toEqual({ x: 4, y: 2 });
  });

  it('congestionAffectsRouteChoiceBetweenParallelLanes', () => {
    const grid = new MapGrid(4, 2);
    for (let x = 0; x < 4; x++) {
      setRoad(grid, { x, y: 0 }, { kind: 'FourLane', dir: 'East', lane: 0 });
      setRoad(grid, { x, y: 1 }, { kind: 'FourLane', dir: 'East', lane: 1 });
    }
    const traffic = new TrafficOccupancy();
    traffic.ensureLen(grid.len());
    traffic.perTickVehicles[grid.idx({ x: 1, y: 0 })!] = 6;
    traffic.perTickVehicles[grid.idx({ x: 2, y: 0 })!] = 6;

    const start = { x: 0, y: 0 };
    const goal = { x: 3, y: 0 };
    const path = findRoadPathCached(context(grid, traffic), start, goal);
    expect(path[0]).toEqual(start);
    expect(path.at(-1)).toEqual(goal);
    expect(path.some((p) => p.y === 1), 'Expected path to use the alternate lane due to congestion').toBe(true);
    expect(path.some((p) => p.x === 1 && p.y === 0), 'Expected path to avoid congested tile (1,0)').toBe(false);
    expect(path.some((p) => p.x === 2 && p.y === 0), 'Expected path to avoid congested tile (2,0)').toBe(false);
  });

  /** East approach on row 4, U-turn through the box, back West on row 5: the legal П crosses on column 5. */
  it('roadAstarFarColumnPUturnStillRoutesAndAvoidsOncomingBoxHalf', () => {
    const grid = oracleCrossingGrid();
    const start = { x: 2, y: 4 };
    const goal = { x: 2, y: 5 };
    const path = findRoadPathCached(context(grid), start, goal);
    expect(path[0], 'П U-turn must route').toEqual(start);
    expect(path.at(-1)).toEqual(goal);
    expect(hasStep(path, { x: 4, y: 4 }, { x: 4, y: 5 }), 'the U-turn must not edge-hug North on column 4').toBe(false);
    expect(hasStep(path, { x: 5, y: 4 }, { x: 5, y: 5 }), 'the U-turn must cross on the northbound column 5').toBe(true);
  });
});
