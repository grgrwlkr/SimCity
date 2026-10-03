import type {Bounds, Point, Terrain} from './types';

export const EPSILON = 0.001;

export function validPoint(p: Point): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.z);
}

export function normalizePoint(p: Point): Point {
  const x = Math.round(p.x * 100);
  const z = Math.round(p.z * 100);

  return {x: x === 0 ? 0 : x / 100, z: z === 0 ? 0 : z / 100};
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function projectSegment(
  p: Point,
  a: Point,
  b: Point,
): {point: Point; t: number; distance: number} {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length2 = dx * dx + dz * dz;
  const t =
    length2 > 0
      ? Math.max(
          0,
          Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2),
        )
      : 0;
  const point = {x: a.x + dx * t, z: a.z + dz * t};

  return {point, t, distance: distance(p, point)};
}

export function segmentIntersection(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): Point | null {
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const sx = d.x - c.x;
  const sz = d.z - c.z;
  const cross = rx * sz - rz * sx;

  if (Math.abs(cross) < EPSILON) {
    return null;
  }

  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / cross;
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / cross;
  const toleranceT = EPSILON / Math.max(distance(a, b), EPSILON);
  const toleranceU = EPSILON / Math.max(distance(c, d), EPSILON);

  return t >= -toleranceT &&
    t <= 1 + toleranceT &&
    u >= -toleranceU &&
    u <= 1 + toleranceU
    ? normalizePoint({x: a.x + t * rx, z: a.z + t * rz})
    : null;
}

export function polygonsOverlap(
  a: readonly Point[],
  b: readonly Point[],
): boolean {
  if (a.some(p => pointInPolygon(p, b)) || b.some(p => pointInPolygon(p, a))) {
    return true;
  }

  return a.some((p, i) =>
    b.some(
      (q, j) =>
        segmentIntersection(
          p,
          a[(i + 1) % a.length]!,
          q,
          b[(j + 1) % b.length]!,
        ) !== null,
    ),
  );
}

/** Convex building footprints may share edges; only intersecting interiors occupy land. */
export function convexInteriorsOverlap(
  a: readonly Point[],
  b: readonly Point[],
): boolean {
  if (a.length < 3 || b.length < 3) {
    return false;
  }

  for (const polygon of [a, b]) {
    for (let index = 0; index < polygon.length; index++) {
      const start = polygon[index]!;
      const end = polygon[(index + 1) % polygon.length]!;
      const length = distance(start, end);

      if (length <= EPSILON) {
        continue;
      }

      const axis = {
        x: -(end.z - start.z) / length,
        z: (end.x - start.x) / length,
      };
      const project = (point: Point) => point.x * axis.x + point.z * axis.z;
      const pa = a.map(project);
      const pb = b.map(project);
      const overlap =
        Math.min(Math.max(...pa), Math.max(...pb)) -
        Math.max(Math.min(...pa), Math.min(...pb));

      if (overlap <= EPSILON) {
        return false;
      }
    }
  }

  return true;
}

export function rectangle(
  center: Point,
  width: number,
  depth: number,
  heading = 0,
): Point[] {
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);

  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([x, z]) => {
    const dx = (x! * width) / 2;
    const dz = (z! * depth) / 2;

    return normalizePoint({
      x: center.x + cos * dx + sin * dz,
      z: center.z - sin * dx + cos * dz,
    });
  });
}

export function containsPoint(b: Bounds, p: Point): boolean {
  return (
    validPoint(p) &&
    p.x >= b.minX - EPSILON &&
    p.x <= b.maxX + EPSILON &&
    p.z >= b.minZ - EPSILON &&
    p.z <= b.maxZ + EPSILON
  );
}

export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
  if (
    polygon.some(
      (a, i) =>
        projectSegment(p, a, polygon[(i + 1) % polygon.length]!).distance <
        EPSILON,
    )
  ) {
    return true;
  }

  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;

    if (
      a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
    ) {
      inside = !inside;
    }
  }

  return inside;
}

export function isDryFootprint(
  terrain: Terrain,
  contour: readonly Point[],
): boolean {
  return (
    contour.length >= 3 &&
    contour.every(p => containsPoint(terrain.bounds, p)) &&
    !terrain.water.some(w => polygonsOverlap(contour, w))
  );
}
