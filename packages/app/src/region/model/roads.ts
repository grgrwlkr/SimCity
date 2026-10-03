import {
  distance,
  EPSILON,
  normalizePoint,
  projectSegment,
  segmentIntersection,
} from './geometry';
import type {Point, Road, RoadAccess} from './types';

export interface RoadNode {
  readonly id: string;
  readonly point: Point;
}
export interface RoadEdge {
  readonly from: string;
  readonly to: string;
  readonly roadId: string;
  readonly segment: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly length: number;
}
export interface RoadGraph {
  readonly nodes: readonly RoadNode[];
  readonly edges: readonly RoadEdge[];
}
interface Segment {
  readonly roadId: string;
  readonly index: number;
  readonly a: Point;
  readonly b: Point;
}
const compareIds = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
// Endpoint quantization to centimeters can move a diagonal projection by up to sqrt(2)/2 cm.
const CONNECTION_TOLERANCE = 0.008;

function pointId(point: Point): string {
  const p = normalizePoint(point);

  return `${p.x},${p.z}`;
}

function segments(roads: readonly Road[]): Segment[] {
  return [...roads]
    .sort((a, b) => compareIds(a.id, b.id))
    .flatMap(road =>
      road.points.slice(1).flatMap((b, index) => {
        const a = road.points[index]!;

        return distance(a, b) > EPSILON ? [{roadId: road.id, index, a, b}] : [];
      }),
    );
}

export function buildRoadGraph(roads: readonly Road[]): RoadGraph {
  const source = segments(roads);
  const nodes = new Map<string, RoadNode>();
  const edges: RoadEdge[] = [];

  for (const segment of source) {
    const cuts = new Map<string, Point>();
    const addCut = (point: Point): void => {
      const normalized = normalizePoint(point);

      cuts.set(pointId(normalized), normalized);
    };

    addCut(segment.a);
    addCut(segment.b);

    for (const other of source) {
      if (other === segment) {
        continue;
      }

      const crossing = segmentIntersection(
        segment.a,
        segment.b,
        other.a,
        other.b,
      );

      if (crossing) {
        addCut(crossing);
      }

      // Parallel touching endpoints still share a node.
      for (const endpoint of [other.a, other.b]) {
        if (
          projectSegment(endpoint, segment.a, segment.b).distance <=
          CONNECTION_TOLERANCE
        ) {
          addCut(endpoint);
        }
      }
    }

    const ordered = [...cuts.values()].sort(
      (a, b) =>
        projectSegment(a, segment.a, segment.b).t -
        projectSegment(b, segment.a, segment.b).t,
    );

    for (const point of ordered) {
      nodes.set(pointId(point), {id: pointId(point), point});
    }

    for (let i = 1; i < ordered.length; i++) {
      const a = ordered[i - 1]!;
      const b = ordered[i]!;
      const length = distance(a, b);

      if (length <= EPSILON) {
        continue;
      }

      const edge = {
        from: pointId(a),
        to: pointId(b),
        roadId: segment.roadId,
        segment: segment.index,
        startOffset: projectSegment(a, segment.a, segment.b).t,
        endOffset: projectSegment(b, segment.a, segment.b).t,
        length,
      };

      edges.push(edge, {
        ...edge,
        from: edge.to,
        to: edge.from,
        startOffset: edge.endOffset,
        endOffset: edge.startOffset,
      });
    }
  }

  edges.sort(
    (a, b) =>
      compareIds(a.from, b.from) ||
      compareIds(a.to, b.to) ||
      compareIds(a.roadId, b.roadId) ||
      a.segment - b.segment,
  );

  return {
    nodes: [...nodes.values()].sort((a, b) => compareIds(a.id, b.id)),
    edges,
  };
}

export interface RoadPath {
  readonly points: readonly Point[];
  readonly roadIds: readonly string[];
}

export function findRoadPath(
  graph: RoadGraph,
  from: Point,
  to: Point,
): readonly Point[] | null {
  return findRoadPathDetails(graph, from, to)?.points ?? null;
}

export function findRoadPathDetails(
  graph: RoadGraph,
  from: Point,
  to: Point,
): RoadPath | null {
  const nodes = new Map(graph.nodes.map(node => [node.id, node.point]));
  const queries = [normalizePoint(from), normalizePoint(to)];
  const adjacency = new Map<
    string,
    Array<{to: string; length: number; roadId: string}>
  >();

  for (const edge of graph.edges) {
    const a = nodes.get(edge.from)!;
    const b = nodes.get(edge.to)!;
    const cuts = [
      {point: a, t: 0},
      {point: b, t: 1},
    ];

    for (const point of queries) {
      const projection = projectSegment(point, a, b);

      if (projection.distance <= CONNECTION_TOLERANCE) {
        nodes.set(pointId(point), point);
        cuts.push({point, t: projection.t});
      }
    }

    cuts.sort((first, second) => first.t - second.t);

    for (let i = 1; i < cuts.length; i++) {
      const start = cuts[i - 1]!.point;
      const end = cuts[i]!.point;

      if (pointId(start) === pointId(end)) {
        continue;
      }

      const id = pointId(start);
      const outgoing = adjacency.get(id) ?? [];

      outgoing.push({
        to: pointId(end),
        length: distance(start, end),
        roadId: edge.roadId,
      });
      adjacency.set(id, outgoing);
    }
  }

  const startId = pointId(queries[0]!);
  const endId = pointId(queries[1]!);

  if (!nodes.has(startId) || !nodes.has(endId)) {
    return null;
  }

  const distances = new Map<string, number>([[startId, 0]]);
  const previous = new Map<string, {from: string; roadId: string}>();
  const unsettled = new Set([startId]);
  const settled = new Set<string>();

  while (unsettled.size > 0) {
    const current = [...unsettled].sort(
      (a, b) => distances.get(a)! - distances.get(b)! || compareIds(a, b),
    )[0]!;

    unsettled.delete(current);
    settled.add(current);

    if (current === endId) {
      const path = [nodes.get(current)!];
      const roadIds: string[] = [];
      let cursor = current;

      while (previous.has(cursor)) {
        const prior = previous.get(cursor)!;

        roadIds.push(prior.roadId);
        cursor = prior.from;
        path.push(nodes.get(cursor)!);
      }

      return {points: path.reverse(), roadIds: [...new Set(roadIds.reverse())]};
    }

    const outgoing = [...(adjacency.get(current) ?? [])].sort((a, b) =>
      compareIds(a.to, b.to),
    );

    for (const edge of outgoing) {
      if (settled.has(edge.to)) {
        continue;
      }

      const candidate = distances.get(current)! + edge.length;

      if (candidate < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, candidate);
        previous.set(edge.to, {from: current, roadId: edge.roadId});
        unsettled.add(edge.to);
      }
    }
  }

  return null;
}

export function roadLength(points: readonly Point[]): number {
  return points
    .slice(1)
    .reduce((total, point, i) => total + distance(points[i]!, point), 0);
}

export function nearestRoadAccess(
  roads: readonly Road[],
  point: Point,
  maximumDistance: number,
): RoadAccess | null {
  let closest: RoadAccess | null = null;
  let bestDistance = maximumDistance;

  for (const segment of segments(roads)) {
    const projection = projectSegment(point, segment.a, segment.b);

    if (
      projection.distance <= maximumDistance &&
      (closest === null || projection.distance < bestDistance)
    ) {
      bestDistance = projection.distance;
      closest = {
        roadId: segment.roadId,
        segment: segment.index,
        offset: projection.t,
      };
    }
  }

  return closest;
}

function collinearOverlap(first: Segment, second: Segment): boolean {
  const dx = first.b.x - first.a.x;
  const dz = first.b.z - first.a.z;
  const length = distance(first.a, first.b);
  const perpendicularDistance = (p: Point): number =>
    Math.abs((p.x - first.a.x) * dz - (p.z - first.a.z) * dx) / length;

  if (
    perpendicularDistance(second.a) > EPSILON ||
    perpendicularDistance(second.b) > EPSILON
  ) {
    return false;
  }

  const offset = (p: Point): number =>
    ((p.x - first.a.x) * dx + (p.z - first.a.z) * dz) / length;
  const a = offset(second.a);
  const b = offset(second.b);

  return (
    Math.min(length, Math.max(a, b)) - Math.max(0, Math.min(a, b)) > EPSILON
  );
}

export function hasRoadOverlap(
  existing: readonly Road[],
  points: readonly Point[],
): boolean {
  const candidate = segments([{id: '', points}]);
  const prior = segments(existing);

  return candidate.some(
    (segment, index) =>
      prior.some(other => collinearOverlap(segment, other)) ||
      candidate
        .slice(index + 1)
        .some(other => collinearOverlap(segment, other)),
  );
}

export function roadContour(
  points: readonly Point[],
  width: number,
): readonly Point[] {
  const clean = points.filter(
    (point, i) => i === 0 || distance(point, points[i - 1]!) > EPSILON,
  );

  if (clean.length < 2 || !Number.isFinite(width) || width <= 0) {
    return [];
  }

  const normals = clean.slice(1).map((b, i) => {
    const a = clean[i]!;
    const length = distance(a, b);

    return {x: -(b.z - a.z) / length, z: (b.x - a.x) / length};
  });
  const side = (sign: number): Point[] =>
    clean.map((point, i) => {
      const before = normals[Math.max(0, i - 1)]!;
      const after = normals[Math.min(i, normals.length - 1)]!;
      const sum = {x: before.x + after.x, z: before.z + after.z};
      const denominator = sum.x * after.x + sum.z * after.z;
      // Reversing on the same segment is rejected as overlap by the command boundary.
      const scale =
        Math.abs(denominator) > EPSILON ? (sign * width) / 2 / denominator : 0;

      return normalizePoint({
        x: point.x + sum.x * scale,
        z: point.z + sum.z * scale,
      });
    });

  return [...side(1), ...side(-1).reverse()];
}
