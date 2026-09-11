// Stage 1b gate: on the Rust test city, the TS turn-lane marks, road and region graphs and 200
// road-A* paths equal what Rust computes (fixture from examples/dump_routes.rs).
import { describe, expect, it } from 'vitest';
import { runFixedTick } from '../../src/app';
import { detectIntersections } from '../../src/intersections/index';
import { TrafficOccupancy } from '../../src/traffic/occupancy';
import { PathCache, findRoadPathCached, type PathfindingCtx } from '../../src/transport/pathfinding';
import { createWorld, type World } from '../../src/world';
import fixture from '../fixtures/road-routes.json';

const LAYER_ORDER = [
  'height',
  'water',
  'terrain',
  'roadKind',
  'roadDir',
  'roadLane',
  'roadFlow',
  'laneType',
  'zone',
  'density',
  'building',
] as const;

function hexToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function loadTestCity(): World {
  const w = createWorld({ mapWidth: fixture.width, mapHeight: fixture.height });
  const layers = w.grid.layers();
  LAYER_ORDER.forEach((name, i) => layers[i]!.set(hexToBytes(fixture.rawGrid[name])));
  w.appState = 'InGame';
  w.graphVersion = fixture.graphVersion;
  w.intersections.trafficLightKeys = new Set(fixture.trafficLightKeys);
  // detect_intersections ran in Update before the fixed tick in Rust.
  detectIntersections(w);
  runFixedTick(w);
  return w;
}

describe('road A* parity with Rust on the test city', () => {
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
