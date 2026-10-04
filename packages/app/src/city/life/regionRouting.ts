import type {Road} from '../../region/model/types';
import {
  buildRoadGraph,
  findRoadPath,
  nearestRoadAccess,
} from '../../region/model/roads';
import {projectSegment} from '../../region/model/geometry';
import type {CityLayout} from '../generator';
import type {JunctionBounds} from '../trafficFlow';
import type {LaneRoute} from '../trafficRoutes';
import {distance, RouteBuilder} from './network';
import {CURB_PARKING} from './streetParking';
import type {
  GraphRoadAccess,
  GraphWalkAccess,
  LifeProfile,
  ParkingFacility,
  ParkingSlot,
  PlannedDrive,
  Point,
  RoadAccess,
  WalkAccess,
} from './types';

export class NoNativeRoute extends Error {
  constructor() {
    super('Нет связанного маршрута по авторской дорожной сети');
  }
}

function offsetPath(points: readonly Point[], offset: number): Point[] {
  return points.map((point, index) => {
    const before = points[Math.max(0, index - 1)]!;
    const after = points[Math.min(points.length - 1, index + 1)]!;
    const incoming = index
      ? {x: point.x - before.x, z: point.z - before.z}
      : {x: after.x - point.x, z: after.z - point.z};
    const outgoing =
      index < points.length - 1
        ? {x: after.x - point.x, z: after.z - point.z}
        : incoming;
    const firstLength = Math.hypot(incoming.x, incoming.z);
    const lastLength = Math.hypot(outgoing.x, outgoing.z);

    if (firstLength < 1e-7 || lastLength < 1e-7) {
      return {...point};
    }

    const a = {x: -incoming.z / firstLength, z: incoming.x / firstLength};
    const b = {x: -outgoing.z / lastLength, z: outgoing.x / lastLength};
    const denominator = 1 + a.x * b.x + a.z * b.z;
    const scale = denominator > 0.15 ? offset / denominator : offset / 2;

    return {
      x: point.x + (a.x + b.x) * scale,
      z: point.z + (a.z + b.z) * scale,
      y: 0.91,
    };
  });
}

/** Authored geometry only: no residents, vehicles, schedules or independent clock. */
export class RegionRouting {
  readonly roads: readonly number[] = [];
  private graph;
  private readonly junctionKeys: string[];

  constructor(
    public layout: CityLayout,
    private source: readonly Road[],
    junctionKeys: readonly string[] = [],
  ) {
    this.graph = buildRoadGraph(source);
    this.junctionKeys = [...junctionKeys];
  }

  update(
    layout: CityLayout,
    roads: readonly Road[],
    keys?: readonly string[],
  ): void {
    this.layout = layout;
    this.source = roads;
    this.graph = buildRoadGraph(roads);

    if (keys) {
      this.junctionKeys.splice(0, this.junctionKeys.length, ...keys);
    }
  }

  validateProfile(profile: LifeProfile): void {
    const ids = new Set<string>();
    const walk = (access: WalkAccess): void => {
      if (
        !('kind' in access) ||
        access.kind !== 'graph' ||
        !Array.isArray(access.chain) ||
        !access.chain.length ||
        (access.side !== 1 && access.side !== -1)
      ) {
        throw new Error('Некорректный доступ к авторскому месту');
      }

      const value = this.segment(access);
      const expected = {
        x:
          value.center.x - value.dz * access.side * CURB_PARKING.sidewalkOffset,
        z:
          value.center.z + value.dx * access.side * CURB_PARKING.sidewalkOffset,
      };

      if (
        distance(expected, access.chain.at(-1)!) > 0.02 ||
        access.chain.some(
          point => !Number.isFinite(point.x) || !Number.isFinite(point.z),
        )
      ) {
        throw new Error('Пешеходный доступ относится к другой дороге');
      }
    };

    for (const place of profile.places) {
      if (
        ids.has(place.id) ||
        !place.id ||
        !Number.isInteger(place.capacity) ||
        place.capacity < 0 ||
        !Number.isFinite(place.door.x) ||
        !Number.isFinite(place.door.z)
      ) {
        throw new Error('Некорректный нативный адрес');
      }

      ids.add(place.id);
      walk(place.access);

      if (place.parking !== null && !profile.facilities[place.parking]) {
        throw new Error('Нет парковки у нативного адреса');
      }
    }

    for (const [id, facility] of profile.facilities.entries()) {
      if (
        facility.id !== id ||
        !Array.isArray(facility.slots) ||
        !('kind' in facility.road) ||
        ![1, -1].includes(facility.road.direction)
      ) {
        throw new Error('Некорректная парковочная инфраструктура');
      }

      const value = this.segment(facility.road);
      const expected = {
        x: value.center.x - value.dz * facility.road.direction * 2,
        z: value.center.z + value.dx * facility.road.direction * 2,
      };

      if (
        distance(expected, facility.road.point) > 0.02 ||
        facility.slots.some(slot => profile.slots[slot]?.facility !== id)
      ) {
        throw new Error('Парковка не связана с действительной дорогой');
      }

      walk(facility.access);
    }

    for (const [id, slot] of profile.slots.entries()) {
      if (
        slot.id !== id ||
        !profile.facilities[slot.facility] ||
        !Number.isFinite(slot.position.x) ||
        !Number.isFinite(slot.position.z) ||
        !(slot.width > 0) ||
        !(slot.length > 0)
      ) {
        throw new Error('Некорректное конечное парковочное место');
      }
    }
  }

  segment(access: {roadId: string; segment: number; offset: number}): {
    a: Point;
    b: Point;
    center: Point;
    dx: number;
    dz: number;
  } {
    const road = this.source.find(road => road.id === access.roadId);
    const a = road?.points[access.segment];
    const b = road?.points[access.segment + 1];

    if (
      !a ||
      !b ||
      access.offset < 0 ||
      access.offset > 1 ||
      distance(a, b) < 1e-7
    ) {
      throw new NoNativeRoute();
    }

    const length = distance(a, b);

    return {
      a,
      b,
      center: {
        x: a.x + (b.x - a.x) * access.offset,
        z: a.z + (b.z - a.z) * access.offset,
      },
      dx: (b.x - a.x) / length,
      dz: (b.z - a.z) / length,
    };
  }

  roadAccess(
    point: Point,
    direction: 1 | -1,
    maximumDistance = 30,
  ): GraphRoadAccess {
    const near = nearestRoadAccess(this.source, point, maximumDistance);

    if (!near) {
      throw new NoNativeRoute();
    }

    const {center, dx, dz} = this.segment(near);

    return {
      kind: 'graph',
      ...near,
      direction,
      point: {
        x: center.x - dz * direction * 2,
        z: center.z + dx * direction * 2,
        y: 0.91,
      },
    };
  }

  access(point: Point, chain: Point[]): GraphWalkAccess {
    const anchor = chain.at(-1) ?? point;
    const near = nearestRoadAccess(this.source, anchor, 50);

    if (!near) {
      throw new NoNativeRoute();
    }

    const {center, dx, dz} = this.segment(near);
    const side =
      (anchor.x - center.x) * -dz + (anchor.z - center.z) * dx >= 0 ? 1 : -1;
    const sidewalk = {
      x: center.x - dz * side * CURB_PARKING.sidewalkOffset,
      z: center.z + dx * side * CURB_PARKING.sidewalkOffset,
      y: 1.07,
    };

    return {
      kind: 'graph',
      ...near,
      side,
      point,
      chain: [point, ...chain, sidewalk].filter(
        (value, index, all) =>
          !index || distance(value, all[index - 1]!) > 1e-7,
      ),
    };
  }

  walk(from: WalkAccess, to: WalkAccess): Point[] {
    if (!('kind' in from) || !('kind' in to)) {
      throw new NoNativeRoute();
    }

    const first = this.segment(from);
    const last = this.segment(to);
    const path = findRoadPath(this.graph, first.center, last.center);

    if (!path) {
      throw new NoNativeRoute();
    }
    if (path.length === 1) {
      return [...from.chain, ...[...to.chain].reverse()];
    }

    const firstDirection =
      (path[1]!.x - path[0]!.x) * first.dx +
        (path[1]!.z - path[0]!.z) * first.dz >=
      0
        ? 1
        : -1;
    const sidewalk = offsetPath(
      path,
      from.side * firstDirection * CURB_PARKING.sidewalkOffset,
    ).map(point => ({...point, y: 1.07}));

    // Opposite-side destinations cross at their actual access, never through a fabricated grid node.
    return [...from.chain, ...sidewalk, ...[...to.chain].reverse()].filter(
      (point, index, all) => !index || distance(point, all[index - 1]!) > 1e-7,
    );
  }

  drive(from: RoadAccess, to: RoadAccess): LaneRoute {
    if (!('kind' in from) || !('kind' in to)) {
      throw new NoNativeRoute();
    }

    const first = this.segment(from);
    const last = this.segment(to);
    const path = this.drivingPath(from, to);

    if (!path || path.length < 2) {
      throw new NoNativeRoute();
    }

    const firstDot =
      (path[1]!.x - path[0]!.x) * first.dx * from.direction +
      (path[1]!.z - path[0]!.z) * first.dz * from.direction;
    const lastDot =
      (path.at(-1)!.x - path.at(-2)!.x) * last.dx * to.direction +
      (path.at(-1)!.z - path.at(-2)!.z) * last.dz * to.direction;

    if (firstDot <= 0 || lastDot <= 0) {
      throw new NoNativeRoute();
    }

    const lane = offsetPath(path, 2);

    lane[0] = from.point;
    lane[lane.length - 1] = to.point;
    const builder = new RouteBuilder(lane[0]);

    for (let index = 1; index < lane.length; index++) {
      const point = lane[index]!;

      if (index < lane.length - 1) {
        const prior = lane[index - 1]!;
        const next = lane[index + 1]!;
        const before = distance(prior, point);
        const after = distance(point, next);
        const radius = Math.min(4, before / 3, after / 3);
        const start = {
          x: point.x + ((prior.x - point.x) * radius) / before,
          z: point.z + ((prior.z - point.z) * radius) / before,
          y: 0.91,
        };
        const end = {
          x: point.x + ((next.x - point.x) * radius) / after,
          z: point.z + ((next.z - point.z) * radius) / after,
          y: 0.91,
        };

        builder.line(start).curve(point, point, end);
      } else {
        builder.line(point);
      }
    }

    return builder.route();
  }

  private drivingPath(
    from: GraphRoadAccess,
    to: GraphRoadAccess,
  ): Point[] | null {
    const first = this.segment(from);
    const last = this.segment(to);
    const key = (point: Point) => `${point.x.toFixed(2)},${point.z.toFixed(2)}`;
    const points = new Map(
      this.graph.nodes.map(node => [key(node.point), node.point]),
    );
    const queries = [first.center, last.center];
    const adjacency = new Map<
      string,
      Array<{from: string; to: string; length: number}>
    >();

    for (const edge of this.graph.edges) {
      const a = this.graph.nodes.find(node => node.id === edge.from)!.point;
      const b = this.graph.nodes.find(node => node.id === edge.to)!.point;
      const cuts = [
        {point: a, offset: 0},
        {point: b, offset: 1},
      ];

      for (const query of queries) {
        const projection = projectSegment(query, a, b);

        if (projection.distance <= 0.008) {
          cuts.push({point: query, offset: projection.t});
        }
      }

      cuts.sort((a, b) => a.offset - b.offset);

      for (let index = 1; index < cuts.length; index++) {
        const a = cuts[index - 1]!.point;
        const b = cuts[index]!.point;
        const from = key(a);
        const to = key(b);

        if (from === to) {
          continue;
        }

        points.set(from, a);
        points.set(to, b);
        const outgoing = adjacency.get(from) ?? [];

        outgoing.push({from, to, length: distance(a, b)});
        adjacency.set(from, outgoing);
      }
    }

    const start = key(first.center);
    const end = key(last.center);
    const costs = new Map<string, number>();
    const states = new Map<
      string,
      {from: string; to: string; length: number}
    >();
    const previous = new Map<string, string>();
    const unsettled = new Set<string>();
    const stateKey = (edge: {from: string; to: string}) =>
      `${edge.from}>${edge.to}`;
    const heading = (
      edge: {from: string; to: string},
      dx: number,
      dz: number,
      direction: number,
    ) => {
      const a = points.get(edge.from)!;
      const b = points.get(edge.to)!;

      return ((b.x - a.x) * dx + (b.z - a.z) * dz) * direction;
    };

    for (const edge of adjacency.get(start) ?? []) {
      if (heading(edge, first.dx, first.dz, from.direction) <= 0) {
        continue;
      }

      const id = stateKey(edge);

      states.set(id, edge);
      costs.set(id, edge.length);
      unsettled.add(id);
    }

    while (unsettled.size) {
      const id = [...unsettled].sort(
        (a, b) => costs.get(a)! - costs.get(b)! || a.localeCompare(b),
      )[0]!;

      unsettled.delete(id);
      const edge = states.get(id)!;

      if (
        edge.to === end &&
        heading(edge, last.dx, last.dz, to.direction) > 0
      ) {
        const path = [points.get(edge.to)!, points.get(edge.from)!];
        let current = id;

        while (previous.has(current)) {
          current = previous.get(current)!;
          path.push(points.get(states.get(current)!.from)!);
        }

        return path.reverse();
      }

      for (const next of adjacency.get(edge.to) ?? []) {
        if (next.to === edge.from) {
          continue;
        }

        const nextId = stateKey(next);
        const cost = costs.get(id)! + next.length;

        if (cost >= (costs.get(nextId) ?? Infinity)) {
          continue;
        }

        costs.set(nextId, cost);
        states.set(nextId, next);
        previous.set(nextId, id);
        unsettled.add(nextId);
      }
    }

    return null;
  }

  isOnRoad(point: Point): boolean {
    return this.source.some(road =>
      road.points
        .slice(1)
        .some(
          (b, index) =>
            projectSegment(point, road.points[index]!, b).distance < 4,
        ),
    );
  }

  departureAccess(
    facility: ParkingFacility,
    slot: ParkingSlot,
  ): GraphRoadAccess {
    if (!('kind' in facility.road)) {
      throw new NoNativeRoute();
    }

    const {dx, dz} = this.segment(facility.road);
    const shift =
      facility.kind === 'street' ? 4 : facility.kind === 'underground' ? 8 : 0;
    const start =
      facility.kind === 'street' ? slot.position : facility.road.point;
    const near = nearestRoadAccess(
      this.source,
      {
        x: start.x + dx * facility.road.direction * shift,
        z: start.z + dz * facility.road.direction * shift,
      },
      10,
    );

    if (!near || near.roadId !== facility.road.roadId) {
      throw new NoNativeRoute();
    }

    const value = this.segment(near);

    return {
      ...facility.road,
      ...near,
      point: {
        x: value.center.x - value.dz * facility.road.direction * 2,
        z: value.center.z + value.dx * facility.road.direction * 2,
        y: 0.91,
      },
    };
  }

  parkingWalkAccess(facility: ParkingFacility, slot: ParkingSlot): WalkAccess {
    return facility.kind === 'street'
      ? this.access(slot.position, [])
      : facility.access;
  }

  parkingRoute(
    facility: ParkingFacility,
    slot: ParkingSlot,
    entering: boolean,
  ): PlannedDrive {
    if (!('kind' in facility.road)) {
      throw new NoNativeRoute();
    }

    const {dx, dz} = this.segment(facility.road);
    const direction = facility.road.direction;
    const road = entering
      ? facility.road
      : this.departureAccess(facility, slot);
    const from = entering ? road.point : slot.position;
    const to = entering ? slot.position : road.point;
    const out = {x: Math.sin(facility.yaw), z: Math.cos(facility.yaw)};
    const mouth = {
      x: facility.entrance.x + out.x * 1.8,
      z: facility.entrance.z + out.z * 1.8,
      y: 0.91,
    };
    const builder = new RouteBuilder(from);

    if (facility.kind === 'private') {
      const laneControl = {
        x: road.point.x - dx * direction * 3,
        z: road.point.z - dz * direction * 3,
        y: 0.91,
      };
      const mouthControl = {
        x: mouth.x + out.x * 2,
        z: mouth.z + out.z * 2,
        y: 0.91,
      };

      if (entering) {
        builder.curve(laneControl, mouthControl, mouth, true).line(to, true);
      } else {
        builder.line(mouth).curve(mouthControl, laneControl, to);
      }
    } else {
      const first = {
        x: from.x + dx * direction * 2.6,
        z: from.z + dz * direction * 2.6,
        y: from.y ?? 0.91,
      };
      const last = {
        x: to.x - dx * direction * 2.6,
        z: to.z - dz * direction * 2.6,
        y: to.y ?? 0.91,
      };

      builder.curve(first, last, to);
    }

    return {route: builder.route(), stops: [0, builder.length]};
  }

  junctions(): JunctionBounds[] {
    const result: JunctionBounds[] = [];

    for (const node of this.graph.nodes) {
      const neighbours = new Set(
        this.graph.edges
          .filter(edge => edge.from === node.id)
          .map(edge => edge.to),
      );

      if (neighbours.size < 3) {
        continue;
      }

      let id = this.junctionKeys.indexOf(node.id);

      if (id < 0) {
        id = this.junctionKeys.length;
        this.junctionKeys.push(node.id);
      }

      result.push({
        id,
        minX: node.point.x - 6,
        maxX: node.point.x + 6,
        minZ: node.point.z - 6,
        maxZ: node.point.z + 6,
      });
    }

    return result;
  }

  savedJunctionKeys(): string[] {
    return [...this.junctionKeys];
  }
}
