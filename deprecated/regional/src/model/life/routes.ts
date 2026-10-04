export {polylineLane} from '../../../../../packages/app/src/region/model/pathGeometry';
import {polylineLane} from '../../../../../packages/app/src/region/model/pathGeometry';
import type {LaneRoute} from '../../../../../packages/app/src/city/trafficRoutes';
import type {JunctionBounds} from '../../../../../packages/app/src/city/trafficFlow';
import {distance} from '../../../../../packages/app/src/region/model/geometry';
import {
  buildRoadGraph,
  findRoadPathDetails,
} from '../../../../../packages/app/src/region/model/roads';
import {
  WAREHOUSE_DEPTH,
  WAREHOUSE_WIDTH,
} from '../../../../../packages/app/src/region/model/rules';
import type {
  Point,
  RoadAccess,
} from '../../../../../packages/app/src/region/model/types';
import type {
  MutableRegion,
  RegionalRoute,
  TravelMode,
} from '../../../../../packages/app/src/region/model/life/types';

export interface Place {
  id: string;
  road: Point;
  roadId: string;
  door: Point;
  heading: number;
  width: number;
  parking: number;
  entry: boolean;
}

function accessPoint(state: MutableRegion, access: RoadAccess): Point | null {
  const road = state.roads.find(r => r.id === access.roadId);
  const a = road?.points[access.segment];
  const b = road?.points[access.segment + 1];

  if (!a || !b || state.life.closingRoadIds.includes(access.roadId)) {
    return null;
  }

  return {
    x: a.x + (b.x - a.x) * access.offset,
    z: a.z + (b.z - a.z) * access.offset,
  };
}

export function resolvePlace(state: MutableRegion, id: string): Place | null {
  const entry = state.externalEntries.find(e => e.id === id);

  if (entry) {
    const road = state.roads.find(r => r.id === entry.roadId);

    if (!road || state.life.closingRoadIds.includes(road.id)) {
      return null;
    }

    const point =
      entry.endpoint === 'start' ? road.points[0] : road.points.at(-1);

    if (!point) {
      return null;
    }

    return {
      id,
      road: point,
      roadId: road.id,
      door: point,
      heading: 0,
      width: 0,
      parking: 1,
      entry: true,
    };
  }

  const building = state.life.buildings.find(
    b => b.id === id && b.stage === 'ready',
  );

  if (!building) {
    return null;
  }

  const parcel = state.parcels.find(p => p.id === building.lotId);
  const lot = parcel ?? state.warehouses.find(p => p.id === building.lotId);

  if (!lot?.access) {
    return null;
  }

  const road = accessPoint(state, lot.access);

  if (!road) {
    return null;
  }

  const depth = parcel?.depth ?? WAREHOUSE_DEPTH;

  return {
    id,
    road,
    roadId: lot.access.roadId,
    door: {
      x: lot.center.x + Math.sin(lot.heading) * (depth / 2 - 7),
      z: lot.center.z + Math.cos(lot.heading) * (depth / 2 - 7),
    },
    heading: lot.heading,
    width: parcel?.width ?? WAREHOUSE_WIDTH,
    parking: building.parking,
    entry: false,
  };
}

export function parkingPoint(place: Place, slot: number): Point {
  if (place.entry) {
    return place.road;
  }

  // Keep the central entrance path clear; the loading bay occupies the right side.
  const edge = Math.min(5.5, place.width / 2 - 2);
  const across =
    slot >= place.parking
      ? edge
      : place.parking > 2 && slot >= 2
        ? edge - (place.parking - 1 - slot) * 2.75
        : -edge + slot * 2.75;

  const forward = slot >= place.parking ? 3.5 : 4;

  return {
    x:
      place.door.x +
      Math.cos(place.heading) * across +
      Math.sin(place.heading) * forward,
    z:
      place.door.z -
      Math.sin(place.heading) * across +
      Math.cos(place.heading) * forward,
  };
}

/** Reach a bay along the clear walkway behind the parked row, then board. */
export function parkingWalkPoints(place: Place, slot: number): Point[] {
  const parked = parkingPoint(place, slot);
  const across =
    (parked.x - place.door.x) * Math.cos(place.heading) -
    (parked.z - place.door.z) * Math.sin(place.heading);
  const corner = {
    x: place.door.x + Math.cos(place.heading) * across,
    z: place.door.z - Math.sin(place.heading) * across,
  };

  return [place.door, corner, parked];
}

/** Fillet lane corners with tangent arcs, reducing radius only on short segments. */
function roundedLane(points: readonly Point[]): LaneRoute {
  const pieces: Array<LaneRoute['segments'][number]> = [];
  let cursor = points[0]!;

  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const c = points[i + 1]!;
    const before = distance(a, b);
    const after = distance(b, c);
    const u = {x: (b.x - a.x) / before, z: (b.z - a.z) / before};
    const v = {x: (c.x - b.x) / after, z: (c.z - b.z) / after};
    const cross = u.x * v.z - u.z * v.x;
    const angle = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.z * v.z)));

    if (Math.abs(cross) < 1e-6 || angle > Math.PI - 0.01) {
      pieces.push(...polylineLane([cursor, b]).segments);
      cursor = b;
      continue;
    }

    const turn = cross > 0 ? 1 : -1;
    const tangent = Math.tan(angle / 2);
    const reach = Math.min(
      (turn === 1 ? 4 : 8) * tangent,
      before * 0.45,
      after * 0.45,
    );
    const radius = reach / tangent;
    const start = {x: b.x - u.x * reach, z: b.z - u.z * reach};
    const end = {x: b.x + v.x * reach, z: b.z + v.z * reach};
    const center = {
      x: start.x - u.z * radius * turn,
      z: start.z + u.x * radius * turn,
    };

    pieces.push(...polylineLane([cursor, start]).segments);
    pieces.push({
      kind: 'arc',
      x: center.x,
      z: center.z,
      radius,
      turn,
      angle: Math.atan2(start.z - center.z, start.x - center.x),
      length: radius * angle,
    });
    cursor = end;
  }

  pieces.push(...polylineLane([cursor, points.at(-1)!]).segments);

  return {
    direction: 1,
    closed: false,
    segments: pieces,
    length: pieces.reduce((n, p) => n + p.length, 0),
  };
}

/** Offset every segment, joining turns continuously inside the road's junction. */
function offsetPath(points: readonly Point[], offset: number): Point[] {
  if (points.length < 2) {
    return [...points];
  }

  const normals = points.slice(1).map((b, i) => {
    const a = points[i]!;
    const d = distance(a, b);

    return {x: -(b.z - a.z) / d, z: (b.x - a.x) / d};
  });

  return points.map((p, i) => {
    const a = normals[Math.max(0, i - 1)]!;
    const b = normals[Math.min(i, normals.length - 1)]!;
    const denominator = 1 + a.x * b.x + a.z * b.z;
    const scale = offset / Math.max(0.5, denominator);

    return {x: p.x + (a.x + b.x) * scale, z: p.z + (a.z + b.z) * scale};
  });
}

export class RegionalRoutes {
  private revision = -1;
  private graph = buildRoadGraph([]);
  private readonly cache = new Map<string, RegionalRoute | null>();

  constructor(private readonly state: MutableRegion) {}

  junctions(): JunctionBounds[] {
    this.refresh();

    const physical = buildRoadGraph(this.state.roads);

    return physical.nodes.flatMap(node => {
      const outgoing = physical.edges.filter(edge => edge.from === node.id);

      if (new Set(outgoing.map(e => e.to)).size < 3) {
        return [];
      }

      let id = this.state.life.junctionKeys.indexOf(node.id);

      if (id < 0) {
        id = this.state.life.junctionKeys.length;
        this.state.life.junctionKeys.push(node.id);
      }

      const radius = this.state.rules.roadWidth / 2 + 2;

      return [
        {
          id,
          minX: node.point.x - radius,
          maxX: node.point.x + radius,
          minZ: node.point.z - radius,
          maxZ: node.point.z + radius,
        },
      ];
    });
  }

  route(fromId: string, toId: string, mode: TravelMode): RegionalRoute | null {
    this.refresh();
    const key = `${fromId}|${toId}|${mode}`;
    // Place readiness can change independently of roadRevision; misses are not cached.
    const cached = this.cache.get(key);

    if (cached) {
      return cached;
    }

    const from = resolvePlace(this.state, fromId);
    const to = resolvePlace(this.state, toId);

    if (!from || !to) {
      return null;
    }

    const path = findRoadPathDetails(this.graph, from.road, to.road);

    if (!path) {
      return null;
    }
    if (path.points.length < 2) {
      // Opposite frontages can share one graph query point without traversing an edge.
      if (mode !== 'walk' || fromId === toId) {
        return null;
      }

      return {
        lane: polylineLane([from.door, to.door]),
        roadIds: [...new Set([from.roadId, to.roadId])],
        roadRevision: this.state.roadRevision,
        crossings: [{from: from.door, to: to.door}],
      };
    }

    const offset =
      mode === 'walk'
        ? this.state.rules.roadWidth / 2 + 0.8
        : this.state.rules.roadWidth / 4;
    let side = 1;

    if (mode === 'walk') {
      const a = path.points[0]!;
      const b = path.points[1]!;

      side =
        -(b.z - a.z) * (from.door.x - a.x) + (b.x - a.x) * (from.door.z - a.z) <
        0
          ? -1
          : 1;
    }

    const points = offsetPath(path.points, offset * side);
    const crossings: RegionalRoute['crossings'] = [];

    if (mode === 'walk') {
      // Both street-side travel and the final crossing remain explicit in the route.
      const end = points.at(-1)!;
      const cross = {x: to.road.x * 2 - end.x, z: to.road.z * 2 - end.z};

      if (distance(to.door, cross) < distance(to.door, end)) {
        crossings.push({from: end, to: cross});
        points.push(cross);
      }

      points.unshift(from.door);
      points.push(to.door);
    }

    const route: RegionalRoute = {
      lane: mode === 'walk' ? polylineLane(points) : roundedLane(points),
      roadIds: [...path.roadIds],
      roadRevision: this.state.roadRevision,
      crossings,
    };

    this.cache.set(key, route);

    return route;
  }

  private refresh(): void {
    if (this.revision === this.state.roadRevision) {
      return;
    }

    this.graph = buildRoadGraph(
      this.state.roads.filter(
        r => !this.state.life.closingRoadIds.includes(r.id),
      ),
    );
    this.cache.clear();
    this.revision = this.state.roadRevision;
  }
}
