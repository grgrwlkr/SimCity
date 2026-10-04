import {afterEach, describe, expect, it, vi} from 'vitest';
import {RegionRouting} from '../src/city/life/regionRouting';
import * as geometry from '../src/region/model/geometry';
import type {Road} from '../src/region/model/types';
import type {Point} from '../src/city/life/types';

const layout = {seed: 'spatial-routing', blocks: [], buildings: []};

function linearOnRoad(roads: readonly Road[], point: Point): boolean {
  return roads.some(road =>
    road.points
      .slice(1)
      .some(
        (b, index) =>
          geometry.projectSegment(point, road.points[index]!, b).distance < 4,
      ),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('native authored road spatial queries', () => {
  it('keeps exact road/end-cap boundaries while avoiding projections onto distant segments', () => {
    const roads = Array.from({length: 200}, (_, index) => ({
      id: `road-${index}`,
      points: [
        {x: index * 64, z: -20},
        {x: index * 64, z: 20},
      ],
    }));
    const routing = new RegionRouting(layout, roads);
    const projection = vi.spyOn(geometry, 'projectSegment');

    expect(routing.isOnRoad({x: 199 * 64 + 2, z: 0})).toBe(true);
    expect(projection.mock.calls.length).toBeLessThan(4);
    expect(routing.isOnRoad({x: 199 * 64 + 4, z: 0})).toBe(false);
    expect(routing.isOnRoad({x: 199 * 64, z: 24})).toBe(false);
    expect(routing.isOnRoad({x: 199 * 64, z: 24 - 1e-9})).toBe(true);
  });

  it('matches the original exact predicate across negative coordinates, diagonals and cell edges', () => {
    const roads = [
      {
        id: 'negative',
        points: [
          {x: -256, z: -128},
          {x: -64, z: 64},
          {x: 192, z: 63.9},
        ],
      },
      {
        id: 'vertical',
        points: [
          {x: 64, z: -200},
          {x: 64, z: 200},
        ],
      },
      {
        id: 'long-diagonal',
        points: [
          {x: -1900, z: 1900},
          {x: 1900, z: -1900},
        ],
      },
    ];
    const routing = new RegionRouting(layout, roads);
    const points = [
      -256, -132, -128, -68, -64, -60, -4, 0, 4, 60, 63.9, 64, 68, 128, 192,
      256,
    ];

    for (const x of points) {
      for (const z of points) {
        expect(routing.isOnRoad({x, z}), `${x}/${z}`).toBe(
          linearOnRoad(roads, {x, z}),
        );
      }
    }
  });

  it('invalidates old candidates when a road is moved, removed or newly registered', () => {
    const routing = new RegionRouting(layout, [
      {
        id: 'a',
        points: [
          {x: 0, z: 0},
          {x: 100, z: 0},
        ],
      },
    ]);

    expect(routing.isOnRoad({x: 30, z: 0})).toBe(true);
    routing.update(layout, [
      {
        id: 'a',
        points: [
          {x: -100, z: -100},
          {x: -10, z: -100},
        ],
      },
    ]);
    expect(routing.isOnRoad({x: 30, z: 0})).toBe(false);
    expect(routing.isOnRoad({x: -50, z: -100})).toBe(true);
    routing.update(layout, []);
    expect(routing.isOnRoad({x: -50, z: -100})).toBe(false);
  });

  it('retains exact behavior for finite geometry outside the bounded index range', () => {
    const roads = [
      {
        id: 'remote',
        points: [
          {x: 1e20, z: 1e20},
          {x: 1e20, z: 1e20},
        ],
      },
    ];
    const routing = new RegionRouting(layout, roads);

    expect(routing.isOnRoad({x: 1e20, z: 1e20})).toBe(
      linearOnRoad(roads, {x: 1e20, z: 1e20}),
    );
    expect(routing.isOnRoad({x: 0, z: 0})).toBe(false);
  });
});
