import {CITY_GRID} from './cityGrid';

export const CITY_ROAD_CENTERS = CITY_GRID.roads;
export const CITY_ROAD_WIDTH = 8;
const LANE_OFFSET = CITY_ROAD_WIDTH / 4;
// Parallel circular turns: the inner/right turn is 4 units, the outer/left turn is 8.
// This also keeps the long truck's full footprint inside the junction's asphalt.
const CENTER_TURN_RADIUS = 6;

type Segment =
  | {
      kind: 'line';
      x: number;
      z: number;
      dx: number;
      dz: number;
      length: number;
      backwards?: boolean;
      y?: number;
      endY?: number;
    }
  | {
      kind: 'arc';
      x: number;
      z: number;
      radius: number;
      angle: number;
      length: number;
      turn?: 1 | -1;
      backwards?: boolean;
    };

interface RoadRectangle {
  west: number;
  east: number;
  north: number;
  south: number;
}
export interface LaneRoute {
  readonly direction: 1 | -1;
  readonly length: number;
  readonly segments: readonly Segment[];
  readonly closed?: boolean;
}
export interface LanePose {
  x: number;
  z: number;
  dx: number;
  dz: number;
  y?: number;
}

export function createLaneRoute(
  roads: RoadRectangle,
  direction: 1 | -1,
): LaneRoute {
  // In the X/Z ground plane, +X travel keeps to +Z and +Z travel keeps to -X.
  // Clockwise circuits therefore use the inside lane; counterclockwise circuits use the outside.
  const inset = direction * LANE_OFFSET;
  const west = roads.west + inset;
  const east = roads.east - inset;
  const north = roads.north + inset;
  const south = roads.south - inset;
  const radius = CENTER_TURN_RADIUS - inset;
  const width = east - west - 2 * radius;
  const depth = south - north - 2 * radius;
  const line = (
    x: number,
    z: number,
    dx: number,
    dz: number,
    length: number,
  ): Segment => ({
    kind: 'line',
    x,
    z,
    dx,
    dz,
    length,
  });
  const arc = (x: number, z: number, angle: number): Segment => ({
    kind: 'arc',
    x,
    z,
    angle,
    radius,
    length: (Math.PI * radius) / 2,
  });
  const segments = [
    line(west + radius, north, 1, 0, width),
    arc(east - radius, north + radius, -Math.PI / 2),
    line(east, north + radius, 0, 1, depth),
    arc(east - radius, south - radius, 0),
    line(east - radius, south, -1, 0, width),
    arc(west + radius, south - radius, Math.PI / 2),
    line(west, south - radius, 0, -1, depth),
    arc(west + radius, north + radius, Math.PI),
  ];

  return {
    direction,
    segments,
    length: segments.reduce((sum, segment) => sum + segment.length, 0),
  };
}

export function createTrafficRoutes(roads = CITY_ROAD_CENTERS): LaneRoute[] {
  const first = roads[0]!;
  const last = roads[roads.length - 1]!;
  const routes: LaneRoute[] = [];

  for (const horizontal of [true, false]) {
    for (let i = 0; i < roads.length - 1; i++) {
      const low = roads[i]!;
      const high = roads[i + 1]!;
      const bounds = horizontal
        ? {west: first, east: last, north: low, south: high}
        : {west: low, east: high, north: first, south: last};

      for (const direction of [1, -1] as const) {
        routes.push(createLaneRoute(bounds, direction));
      }
    }
  }

  return routes;
}

/** Distance is measured along the actual lane, so speed does not change on a turn. */
export function sampleLaneRoute(route: LaneRoute, distance: number): LanePose {
  let along =
    route.closed === false
      ? Math.max(0, Math.min(distance, route.length))
      : (((distance * route.direction) % route.length) + route.length) %
        route.length;
  let segment = route.segments[0]!;

  for (let i = 0; i < route.segments.length; i++) {
    segment = route.segments[i]!;

    if (along < segment.length || i === route.segments.length - 1) {
      break;
    }

    along -= segment.length;
  }

  if (segment.kind === 'line') {
    return {
      x: segment.x + segment.dx * along,
      z: segment.z + segment.dz * along,
      dx: segment.dx * route.direction * (segment.backwards ? -1 : 1),
      dz: segment.dz * route.direction * (segment.backwards ? -1 : 1),
      ...(segment.y === undefined
        ? {}
        : {
            y:
              segment.y +
              (((segment.endY ?? segment.y) - segment.y) * along) /
                segment.length,
          }),
    };
  }

  const turn = segment.turn ?? 1;
  const facing = route.direction * turn * (segment.backwards ? -1 : 1);
  const angle = segment.angle + (turn * along) / segment.radius;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);

  return {
    x: segment.x + cos * segment.radius,
    z: segment.z + sin * segment.radius,
    dx: -sin * facing,
    dz: cos * facing,
  };
}
