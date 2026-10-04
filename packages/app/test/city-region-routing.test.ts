import {describe, expect, it} from 'vitest';
import {RegionRouting, NoNativeRoute} from '../src/city/life/regionRouting';
import {sampleLaneRoute} from '../src/city/trafficRoutes';
import {nearestRoadAccess} from '../src/region/model/roads';

describe('native authored geometry', () => {
  it('walks on actual sidewalks at arbitrary angles and has explicit graph access', () => {
    const roads = [
      {
        id: 'diagonal',
        points: [
          {x: 0, z: 0},
          {x: 100, z: 60},
          {x: 170, z: -20},
        ],
      },
    ];
    const routing = new RegionRouting(
      {seed: 'graph', blocks: [], buildings: []},
      roads,
    );
    const from = routing.access({x: 20, z: 24}, []);
    const to = routing.access({x: 163, z: -6}, []);
    const walk = routing.walk(from, to);

    expect(from.kind).toBe('graph');
    expect('a' in from).toBe(false);
    expect('nextColumn' in routing.roadAccess({x: 20, z: 12}, 1)).toBe(false);
    expect(
      walk.every(point => Number.isFinite(point.x) && Number.isFinite(point.z)),
    ).toBe(true);
    expect(
      walk
        .slice(1, -1)
        .every(point => nearestRoadAccess(roads, point, 4) === null),
    ).toBe(true);
  });

  it('takes a legal forward loop instead of changing lane direction to reach a point behind', () => {
    const roads = [
      {
        id: 'loop',
        points: [
          {x: 0, z: 0},
          {x: 100, z: 0},
          {x: 100, z: 100},
          {x: 0, z: 100},
          {x: 0, z: 0},
        ],
      },
    ];
    const routing = new RegionRouting(
      {seed: 'loop', blocks: [], buildings: []},
      roads,
    );
    const from = routing.roadAccess({x: 40, z: 2}, 1);
    const to = routing.roadAccess({x: 20, z: 2}, 1);
    const route = routing.drive(from, to);

    expect(route.length).toBeGreaterThan(300);
    expect(sampleLaneRoute(route, 0)).toMatchObject({
      x: 40,
      z: 2,
      dx: 1,
      dz: 0,
    });
    const end = sampleLaneRoute(route, route.length);

    expect(end.x).toBeCloseTo(20, 8);
    expect(end).toMatchObject({z: 2, dx: 1, dz: 0});
    expect(
      route.segments.some(segment => segment.kind === 'line' && segment.dx < 0),
    ).toBe(true);
  });

  it('reports disconnected road access without hidden grid indices or fallback routes', () => {
    const routing = new RegionRouting(
      {seed: 'empty', blocks: [], buildings: []},
      [],
    );

    expect(() => routing.access({x: 0, z: 0}, [])).toThrow(NoNativeRoute);
    expect(() => routing.roadAccess({x: 0, z: 0}, 1)).toThrow(NoNativeRoute);
    expect(routing.isOnRoad({x: 0, z: 0})).toBe(false);
  });
});
