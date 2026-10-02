// Stage 1b gate, now TS route pins on the test city: the turn-lane marks, road and region graphs and 200 road-A*
// paths stay what they were when they matched Rust (values frozen from examples/dump_routes.rs in road-routes.json).
import { describe, expect, it } from 'vitest';
import { TrafficOccupancy } from '../../src/traffic/occupancy';
import { PathCache, findRoadPathCached, type PathfindingCtx } from '../../src/transport/pathfinding';
import fixture from '../fixtures/road-routes.json';
import { hex, loadTestCity } from '../testCity';

describe('road A* route pins on the test city', () => {
  const w = loadTestCity();

  it('turnLaneMarksMatchRust', () => {
    expect(hex(w.grid.laneType)).toBe(fixture.laneTypeAfterHex);
  });

  it('roadGraphMatchesRust', () => {
    expect(hex(w.roadGraph.edges)).toBe(fixture.roadEdgesHex);
  });

  it('regionGraphMatchesRust', () => {
    expect(hex(w.regionGraph.edges)).toBe(fixture.regionEdgesHex);
  });

  it('roadAStarMatchesRustOnTestCity', () => {
    const ctx: PathfindingCtx = {
      timeNowSec: 0,
      cfg: w.pathfindingConfig,
      cache: new PathCache(),
      graph: w.roadGraph,
      regions: w.regionGraph,
      traffic: new TrafficOccupancy(),
      grid: w.grid,
      intersections: w.intersections,
    };
    let routed = 0;
    fixture.routes.forEach((route, i) => {
      const start = { x: route.start[0]!, y: route.start[1]! };
      const goal = { x: route.goal[0]!, y: route.goal[1]! };
      const path = findRoadPathCached(ctx, start, goal).flatMap((p) => [p.x, p.y]);
      expect(path, `pair ${i}: (${start.x},${start.y}) -> (${goal.x},${goal.y})`).toEqual(route.path);
      if (route.path.length > 2) routed++;
    });
    expect(routed, 'the fixture must exercise real routes, not only unreachable pairs').toBeGreaterThan(100);
  });
});
