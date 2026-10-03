import {describe, expect, it} from 'vitest';
import {
  buildRoadGraph,
  findRoadPath,
  hasRoadOverlap,
  nearestRoadAccess,
  roadContour,
  roadLength,
} from '../src/region/model/roads';
import {pointInPolygon} from '../src/region/model/geometry';
import type {Point, Road} from '../src/region/model/types';

const p = (x: number, z: number): Point => ({x, z});
const road = (id: string, ...points: Point[]): Road => ({id, points});

describe('regional road topology', () => {
  it('routes through an X crossing and has bidirectional offset edges', () => {
    const graph = buildRoadGraph([
      road('a', p(-100, -50), p(-100, 50)),
      road('b', p(-150, 0), p(-50, 0)),
    ]);

    expect(findRoadPath(graph, p(-100, -50), p(-50, 0))).toEqual([
      p(-100, -50),
      p(-100, 0),
      p(-50, 0),
    ]);
    expect(findRoadPath(graph, p(-50, 0), p(-100, -50))).toEqual([
      p(-50, 0),
      p(-100, 0),
      p(-100, -50),
    ]);
    expect(graph.edges).toHaveLength(8);
    expect(
      graph.edges.some(
        e => e.roadId === 'a' && e.startOffset === 0 && e.endOffset === 0.5,
      ),
    ).toBe(true);
  });
  it('joins diagonal X and T intersections without grid assumptions', () => {
    const graph = buildRoadGraph([
      road('a', p(0, 0), p(100, 100)),
      road('b', p(0, 100), p(100, 0)),
      road('c', p(75, 75), p(110, 75)),
    ]);

    expect(findRoadPath(graph, p(0, 100), p(110, 75))).toEqual([
      p(0, 100),
      p(50, 50),
      p(75, 75),
      p(110, 75),
    ]);
  });
  it('does not connect an intersection beyond a long segment endpoint', () => {
    const graph = buildRoadGraph([
      road('a', p(0, 0), p(1000, 0)),
      road('b', p(1000.5, -100), p(1000.5, 100)),
    ]);

    expect(findRoadPath(graph, p(0, 0), p(1000.5, 100))).toBeNull();
    expect(graph.nodes).toHaveLength(4);
  });
  it('preserves polyline bends and attaches endpoints inside road segments', () => {
    const graph = buildRoadGraph([road('a', p(0, 0), p(100, 0), p(100, 100))]);

    expect(findRoadPath(graph, p(20, 0), p(100, 70))).toEqual([
      p(20, 0),
      p(100, 0),
      p(100, 70),
    ]);
    expect(findRoadPath(graph, p(20, 0), p(80, 0))).toEqual([
      p(20, 0),
      p(80, 0),
    ]);
    expect(graph.nodes).toHaveLength(3);
  });
  it('returns null for disconnected or off-road points', () => {
    const graph = buildRoadGraph([
      road('a', p(0, 0), p(100, 0)),
      road('b', p(0, 50), p(100, 50)),
    ]);

    expect(findRoadPath(graph, p(0, 0), p(100, 50))).toBeNull();
    expect(findRoadPath(graph, p(50, 5), p(100, 0))).toBeNull();
  });
  it('chooses the shortest path and deterministic ties independent of input order', () => {
    const roads = [
      road('a', p(0, 0), p(50, 30), p(100, 0)),
      road('b', p(0, 0), p(50, -30), p(100, 0)),
      road('c', p(0, 0), p(50, 50), p(100, 0)),
    ];
    const graph = buildRoadGraph(roads);

    expect(findRoadPath(graph, p(0, 0), p(100, 0))).toEqual([
      p(0, 0),
      p(50, -30),
      p(100, 0),
    ]);
    expect(buildRoadGraph([...roads].reverse())).toEqual(graph);
  });
  it('ignores zero length segments and joins collinear touching endpoints', () => {
    const graph = buildRoadGraph([
      road('a', p(0, 0), p(0, 0), p(50, 0)),
      road('b', p(50, 0), p(100, 0)),
    ]);

    expect(findRoadPath(graph, p(0, 0), p(100, 0))).toEqual([
      p(0, 0),
      p(50, 0),
      p(100, 0),
    ]);
    expect(graph.edges.every(e => e.length > 0)).toBe(true);
  });
  it('calculates true polyline length and nearest access with deterministic ties', () => {
    const roads = [
      road('b', p(0, 0), p(100, 0)),
      road('a', p(0, 10), p(100, 10)),
    ];

    expect(roadLength([p(0, 0), p(30, 40), p(30, 90)])).toBe(100);
    expect(nearestRoadAccess(roads, p(25, 5), 5)).toEqual({
      roadId: 'a',
      segment: 0,
      offset: 0.25,
    });
    expect(nearestRoadAccess(roads, p(25, 30), 5)).toBeNull();
  });
  it('rejects collinear overlap including self overlap but allows crossings and touching', () => {
    const roads = [road('a', p(0, 0), p(100, 0))];

    expect(hasRoadOverlap(roads, [p(20, 0), p(120, 0)])).toBe(true);
    expect(hasRoadOverlap(roads, [p(100, 0), p(120, 0)])).toBe(false);
    expect(hasRoadOverlap(roads, [p(50, -20), p(50, 20)])).toBe(false);
    expect(hasRoadOverlap([], [p(0, 0), p(100, 0), p(20, 0)])).toBe(true);
  });
  it('follows diagonal and bent sides with miter joins rather than covering empty corners', () => {
    expect(roadContour([p(0, 0), p(100, 0), p(100, 100)], 10)).toEqual([
      p(0, 5),
      p(95, 5),
      p(95, 100),
      p(105, 100),
      p(105, -5),
      p(0, -5),
    ]);
    const diagonal = roadContour([p(0, 0), p(100, 100)], 10);

    expect(pointInPolygon(p(50, 50), diagonal)).toBe(true);
    expect(pointInPolygon(p(0, 100), diagonal)).toBe(false);
    expect(roadContour([p(0, 0), p(0, 0)], 10)).toEqual([]);
  });
});
