import type {HarborNavigation} from './harbor';
import {
  containsPoint,
  isDryFootprint,
  pointInPolygon,
  projectSegment,
} from '../region/model/geometry';
import type {Point, Terrain} from '../region/model/types';
import type {NativeInfrastructurePlacement} from './nativeInfrastructurePlacement';

interface PortFrame {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

function portWorldPoint(point: Point, frame: PortFrame): Point {
  const c = Math.cos(frame.yaw);
  const s = Math.sin(frame.yaw);

  return {
    x: frame.x + c * point.x + s * point.z,
    z: frame.z - s * point.x + c * point.z,
  };
}

function portLocalPose(
  point: Point & {dx: number; dz: number},
  frame: PortFrame,
) {
  const c = Math.cos(frame.yaw);
  const s = Math.sin(frame.yaw);
  const x = point.x - frame.x;
  const z = point.z - frame.z;

  return {x: c * x - s * z, z: s * x + c * z};
}

function portFootprint(port: {
  frame: PortFrame;
  id: string;
  shipEntryX: number;
  shipExitX: number;
  truckIds: readonly number[];
}) {
  const corners = (minX: number, minZ: number, maxX: number, maxZ: number) =>
    [
      {x: minX, z: minZ},
      {x: maxX, z: minZ},
      {x: maxX, z: maxZ},
      {x: minX, z: maxZ},
    ].map(point => portWorldPoint(point, port.frame));

  return {land: corners(47, 55, 123, 123), quay: corners(47, 123, 123, 147)};
}

const HULL_RADIUS = Math.hypot(15, 3.1) + 0.25;
const GRID_STEP = 32;
const SAMPLE_STEP = 4;

export const HARBOR_SHIP_SPEED = 230 / 18;

const onBoundary = (point: Point, terrain: Terrain) => {
  const {minX, maxX, minZ, maxZ} = terrain.bounds;

  return (
    Math.min(
      Math.abs(point.x - minX),
      Math.abs(point.x - maxX),
      Math.abs(point.z - minZ),
      Math.abs(point.z - maxZ),
    ) < 0.001
  );
};

/** Conservative full-hull clearance. Water may continue beyond an actual region boundary. */
export function shipCenterOnWater(
  terrain: Terrain,
  point: Point,
  margin = 0,
): boolean {
  if (!containsPoint(terrain.bounds, point)) {
    return false;
  }

  return terrain.water.some(
    polygon =>
      pointInPolygon(point, polygon) &&
      polygon.every((a, i) => {
        const b = polygon[(i + 1) % polygon.length]!;

        if (
          [terrain.bounds.minX, terrain.bounds.maxX].some(
            edge =>
              Math.abs(a.x - edge) < 0.001 && Math.abs(b.x - edge) < 0.001,
          ) ||
          [terrain.bounds.minZ, terrain.bounds.maxZ].some(
            edge =>
              Math.abs(a.z - edge) < 0.001 && Math.abs(b.z - edge) < 0.001,
          )
        ) {
          return true;
        }

        return projectSegment(point, a, b).distance >= HULL_RADIUS + margin;
      }),
  );
}

function clearSegment(terrain: Terrain, a: Point, b: Point): boolean {
  const steps = Math.max(
    1,
    Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / SAMPLE_STEP),
  );

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;

    if (
      !shipCenterOnWater(
        terrain,
        {x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t},
        SAMPLE_STEP / 2,
      )
    ) {
      return false;
    }
  }

  return true;
}

interface NavigationGrid {
  points: Point[];
  previous: Int32Array;
  width: number;
  height: number;
}
const cache = new WeakMap<Terrain, NavigationGrid>();
const geometries = new Map<string, NavigationGrid>();

function navigationGrid(terrain: Terrain): NavigationGrid {
  const existing = cache.get(terrain);

  if (existing) {
    return existing;
  }

  const signature = JSON.stringify([terrain.bounds, terrain.water]);
  const shared = geometries.get(signature);

  if (shared) {
    cache.set(terrain, shared);

    return shared;
  }

  const {minX, maxX, minZ, maxZ} = terrain.bounds;
  const width = Math.ceil((maxX - minX) / GRID_STEP) + 1;
  const height = Math.ceil((maxZ - minZ) / GRID_STEP) + 1;
  const points = Array.from({length: width * height}, (_, index) => ({
    x: Math.min(maxX, minX + (index % width) * GRID_STEP),
    z: Math.min(maxZ, minZ + Math.floor(index / width) * GRID_STEP),
  }));
  const wet = points.map(p => shipCenterOnWater(terrain, p));
  const previous = new Int32Array(points.length).fill(-2);
  const queue: number[] = [];

  for (let i = 0; i < points.length; i++) {
    if (wet[i] && onBoundary(points[i]!, terrain)) {
      previous[i] = -1;
      queue.push(i);
    }
  }

  for (let head = 0; head < queue.length; head++) {
    const index = queue[head]!;
    const x = index % width;
    const z = Math.floor(index / width);

    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ]) {
      const nx = x + dx!;
      const nz = z + dz!;

      if (nx < 0 || nx >= width || nz < 0 || nz >= height) {
        continue;
      }

      const next = nz * width + nx;

      if (
        !wet[next] ||
        previous[next] !== -2 ||
        !clearSegment(terrain, points[index]!, points[next]!)
      ) {
        continue;
      }

      previous[next] = index;
      queue.push(next);
    }
  }

  const grid = {points, previous, width, height};

  cache.set(terrain, grid);

  if (geometries.size >= 4) {
    geometries.delete(geometries.keys().next().value!);
  }

  geometries.set(signature, grid);

  return grid;
}

function pathToBoundary(terrain: Terrain, start: Point): Point[] | null {
  const grid = navigationGrid(terrain);
  let closest = -1;
  let distance = Infinity;

  for (let i = 0; i < grid.points.length; i++) {
    if (grid.previous[i] === -2) {
      continue;
    }

    const p = grid.points[i]!;
    const d = Math.hypot(p.x - start.x, p.z - start.z);

    if (d < distance && d <= GRID_STEP * 2 && clearSegment(terrain, start, p)) {
      closest = i;
      distance = d;
    }
  }

  if (closest < 0) {
    return null;
  }

  const points = [start];

  for (let cursor = closest; cursor >= 0; cursor = grid.previous[cursor]!) {
    points.push(grid.points[cursor]!);
  }

  // Remove grid zigzags only when the entire hull still clears the coast.
  const simplified = [points[0]!];

  for (let i = 0; i < points.length - 1;) {
    let next = points.length - 1;

    while (next > i + 1 && !clearSegment(terrain, points[i]!, points[next]!)) {
      next--;
    }

    simplified.push(points[next]!);
    i = next;
  }

  const rounded: Point[] = [simplified[0]!];

  for (let i = 1; i < simplified.length - 1; i++) {
    const a = simplified[i - 1]!;
    const b = simplified[i]!;
    const c = simplified[i + 1]!;
    const before = Math.hypot(b.x - a.x, b.z - a.z);
    const after = Math.hypot(c.x - b.x, c.z - b.z);
    const radius = Math.min(20, before / 4, after / 4);
    const entry = {
      x: b.x + ((a.x - b.x) * radius) / before,
      z: b.z + ((a.z - b.z) * radius) / before,
    };
    const exit = {
      x: b.x + ((c.x - b.x) * radius) / after,
      z: b.z + ((c.z - b.z) * radius) / after,
    };

    rounded.push(entry);

    for (let step = 1; step <= 20; step++) {
      const t = step / 20;
      const q = 1 - t;

      rounded.push({
        x: q * q * entry.x + 2 * q * t * b.x + t * t * exit.x,
        z: q * q * entry.z + 2 * q * t * b.z + t * t * exit.z,
      });
    }
  }

  rounded.push(simplified.at(-1)!);

  return rounded.slice(1).every((p, i) => clearSegment(terrain, rounded[i]!, p))
    ? rounded
    : simplified;
}

/** Adds navigation to the original port, not a second harbor state machine. */
export function planPortNavigation(
  terrain: Terrain,
  frame: PortFrame,
): HarborNavigation | null {
  const world = (p: Point) => portWorldPoint(p, frame);
  const local = (p: Point) => {
    const result = portLocalPose({...p, dx: 1, dz: 0}, frame);

    return {x: result.x, z: result.z};
  };
  const approach = {x: 37, z: 151};
  const departure = {x: 139, z: 151};

  if (!clearSegment(terrain, world(approach), world(departure))) {
    return null;
  }

  const footprint = portFootprint({
    id: 'placement',
    frame,
    shipEntryX: -158,
    shipExitX: 160,
    truckIds: [0, 1, 2, 3],
  });

  if (
    !isDryFootprint(terrain, footprint.land) ||
    !footprint.quay.every(p => containsPoint(terrain.bounds, p))
  ) {
    return null;
  }

  const incoming = pathToBoundary(terrain, world(approach));
  const outgoing = pathToBoundary(terrain, world(departure));

  if (!incoming || !outgoing) {
    return null;
  }

  const arrive = incoming.reverse().map(local);
  const depart = outgoing.map(local);

  return {
    speed: HARBOR_SHIP_SPEED,
    arrivals: [
      [...arrive, {x: 72, z: 151}],
      [...arrive, {x: 104, z: 151}],
    ],
    departures: [
      [{x: 72, z: 151}, ...depart],
      [{x: 104, z: 151}, ...depart],
    ],
  };
}

export function portNavigationOnWater(
  terrain: Terrain,
  frame: PortFrame,
  navigation: HarborNavigation,
): boolean {
  if (
    !Number.isFinite(navigation.speed) ||
    navigation.speed !== HARBOR_SHIP_SPEED
  ) {
    return false;
  }

  for (const [index, points] of [
    ...navigation.arrivals,
    ...navigation.departures,
  ].entries()) {
    if (points.length < 2) {
      return false;
    }

    const boundary = portWorldPoint(
      index < 2 ? points[0]! : points.at(-1)!,
      frame,
    );

    if (!onBoundary(boundary, terrain)) {
      return false;
    }

    const berth = index % 2 === 0 ? 72 : 104;
    const endpoint = index < 2 ? points.at(-1)! : points[0]!;

    if (Math.hypot(endpoint.x - berth, endpoint.z - 151) > 0.001) {
      return false;
    }

    for (let i = 1; i < points.length; i++) {
      if (
        !clearSegment(
          terrain,
          portWorldPoint(points[i - 1]!, frame),
          portWorldPoint(points[i]!, frame),
        )
      ) {
        return false;
      }
    }
  }

  return true;
}

function frameForPlacement(
  placement: NativeInfrastructurePlacement,
): PortFrame {
  const source = placement.source ?? {x: 85, z: 135};
  const c = Math.cos(placement.yaw);
  const s = Math.sin(placement.yaw);

  return {
    x: placement.center.x - c * source.x - s * source.z,
    y: 0,
    z: placement.center.z + s * source.x - c * source.z,
    yaw: placement.yaw,
  };
}

export function nativePortNavigation(
  terrain: Terrain,
  placement: NativeInfrastructurePlacement,
): HarborNavigation | null {
  return planPortNavigation(terrain, frameForPlacement(placement));
}

export function nativePortPlacementError(
  placement: NativeInfrastructurePlacement,
  terrain: Terrain,
): string | null {
  if (
    ![placement.center.x, placement.center.z, placement.yaw].every(
      Number.isFinite,
    )
  ) {
    return 'Некорректное положение порта.';
  }

  const frame = frameForPlacement(placement);
  const footprint = portFootprint({
    frame,
    id: placement.id,
    shipEntryX: -158,
    shipExitX: 160,
    truckIds: [0, 1, 2, 3],
  });

  if (!isDryFootprint(terrain, footprint.land)) {
    return 'Склады и подъезды порта должны целиком находиться на суше.';
  }
  if (!footprint.quay.every(point => containsPoint(terrain.bounds, point))) {
    return 'Причалы выходят за границу региона.';
  }

  const navigation = planPortNavigation(terrain, frame);

  return navigation && portNavigationOnWater(terrain, frame, navigation)
    ? null
    : 'Нет водного пути до границы региона для целого корабля.';
}
