import { CITY_ROAD_CENTERS, type LaneRoute } from '../trafficRoutes';
import type { CityBuilding, CityLayout } from '../generator';
import type {
  LifePlace,
  LifeProfile,
  ParkingFacility,
  ParkingSlot,
  PlannedDrive,
  Point,
  RoadAccess,
  WalkAccess,
} from './types';
import { CURB_PARKING, streetParkingSegments } from './streetParking';
import { CROSSWALK_OFFSET } from '../streetCrossings';
import { gridForLayout } from '../cityGrid';

const CURB = CROSSWALK_OFFSET;
export const DIRECTIONS = [
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 0, z: -1 },
] as const;
export const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.z - a.z);
export const rightOf = (d: number) => ({ x: -DIRECTIONS[d]!.z, z: DIRECTIONS[d]!.x });
const point = (x: number, z: number, y = 1.07): Point => ({ x, z, y });
const add = (p: Point, d: Point, amount: number): Point => ({
  x: p.x + d.x * amount,
  z: p.z + d.z * amount,
  ...(p.y === undefined ? {} : { y: p.y }),
});
const same = (a: Point, b: Point) => distance(a, b) < 1e-7;
export const pathLength = (points: readonly Point[]) =>
  points.slice(1).reduce((n, p, i) => n + distance(points[i]!, p), 0);
export function sampleWalk(points: readonly Point[], along: number): Point & { dx: number; dz: number } {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      length = distance(a, b);
    if (along <= length || i === points.length - 1) {
      const t = length ? Math.min(1, Math.max(0, along / length)) : 1;
      return {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        y: (a.y ?? 1.07) + ((b.y ?? 1.07) - (a.y ?? 1.07)) * t,
        dx: length ? (b.x - a.x) / length : 0,
        dz: length ? (b.z - a.z) / length : 1,
      };
    }
    along -= length;
  }
  return { ...(points[0] ?? point(0, 0)), dx: 0, dz: 1 };
}
export class RouteBuilder {
  readonly segments: LaneRoute['segments'][number][] = [];
  length = 0;
  constructor(public cursor: Point) {}
  line(to: Point, backwards = false): this {
    const length = distance(this.cursor, to);
    if (length > 1e-7) {
      this.segments.push({
        kind: 'line',
        x: this.cursor.x,
        z: this.cursor.z,
        dx: (to.x - this.cursor.x) / length,
        dz: (to.z - this.cursor.z) / length,
        length,
        ...(backwards ? { backwards } : {}),
        y: this.cursor.y ?? 0.91,
        endY: to.y ?? 0.91,
      });
      this.length += length;
    }
    this.cursor = to;
    return this;
  }
  curve(c1: Point, c2: Point, to: Point, backwards = false): this {
    const start = this.cursor;
    for (let i = 1; i <= 20; i++) {
      const t = i / 20,
        q = 1 - t;
      this.line(
        {
          x: q ** 3 * start.x + 3 * q * q * t * c1.x + 3 * q * t * t * c2.x + t ** 3 * to.x,
          z: q ** 3 * start.z + 3 * q * q * t * c1.z + 3 * q * t * t * c2.z + t ** 3 * to.z,
          y: (start.y ?? 0.91) + ((to.y ?? 0.91) - (start.y ?? 0.91)) * t,
        },
        backwards,
      );
    }
    return this;
  }
  append(route: LaneRoute): this {
    this.segments.push(...route.segments);
    this.length += route.length;
    return this;
  }
  route(): LaneRoute {
    return { direction: 1, closed: false, segments: this.segments, length: this.length };
  }
}
function laneEnd(column: number, row: number, direction: number, before: boolean, roads: readonly number[]): Point {
  const d = DIRECTIONS[direction]!,
    r = rightOf(direction);
  return point(
    roads[column]! + d.x * (before ? -6 : 6) + r.x * 2,
    roads[row]! + d.z * (before ? -6 : 6) + r.z * 2,
    0.91,
  );
}
function turnAt(
  builder: RouteBuilder,
  column: number,
  row: number,
  from: number,
  to: number,
  roads: readonly number[],
): void {
  const end = laneEnd(column, row, to, false, roads);
  if (from === to) {
    builder.line(end);
    return;
  }
  const incoming = DIRECTIONS[from]!,
    outgoing = DIRECTIONS[to]!,
    cross = incoming.x * outgoing.z - incoming.z * outgoing.x;
  const sign = cross > 0 ? 1 : -1,
    radius = sign === 1 ? 4 : 8,
    r = rightOf(from);
  const start = laneEnd(column, row, from, true, roads),
    center = add(start, r, sign * radius);
  builder.segments.push({
    kind: 'arc',
    x: center.x,
    z: center.z,
    radius,
    angle: Math.atan2(start.z - center.z, start.x - center.x),
    turn: sign,
    length: (radius * Math.PI) / 2,
  });
  builder.length += (radius * Math.PI) / 2;
  builder.cursor = end;
}
export function roadAccess(p: Point, direction: number, roads = CITY_ROAD_CENTERS): RoadAccess {
  const d = DIRECTIONS[direction]!,
    r = rightOf(direction);
  const origin = roads[0]!,
    step = roads[1]! - origin;
  const cx = p.x - r.x * 2,
    cz = p.z - r.z * 2;
  return {
    point: { ...p, y: 0.91 },
    direction,
    nextColumn:
      d.x > 0
        ? Math.ceil((cx - origin) / step - 1e-8)
        : d.x < 0
          ? Math.floor((cx - origin) / step + 1e-8)
          : Math.round((cx - origin) / step),
    nextRow:
      d.z > 0
        ? Math.ceil((cz - origin) / step - 1e-8)
        : d.z < 0
          ? Math.floor((cz - origin) / step + 1e-8)
          : Math.round((cz - origin) / step),
  };
}
interface Edge {
  to: number;
  length: number;
  sidewalk: boolean;
}
export class LifeNetwork {
  readonly roads: readonly number[];
  readonly nodes: Point[] = [];
  private readonly edges: Edge[][] = [];
  private readonly lookup = new Map<string, number>();
  private readonly driveCache = new Map<string, LaneRoute>();
  constructor(readonly layout: CityLayout) {
    const roads = (this.roads = gridForLayout(layout).roads);
    for (const z of roads) {
      for (const x of roads) {
        const ids = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ].map(([dx, dz]) => this.node(point(x + dx! * CURB, z + dz! * CURB)));
        for (let i = 0; i < 4; i++) {
          this.connect(ids[i]!, ids[(i + 1) % 4]!);
        }
      }
    }
    const parking = streetParkingSegments(layout);
    const sidewalk = (a: number, b: number) => {
      const strip = parking.find(
        (p) =>
          (same(p.sidewalk[0]!, this.nodes[a]!) && same(p.sidewalk.at(-1)!, this.nodes[b]!)) ||
          (same(p.sidewalk[0]!, this.nodes[b]!) && same(p.sidewalk.at(-1)!, this.nodes[a]!)),
      );
      if (!strip) {
        this.connect(a, b, true);
        return;
      }
      const path = [...strip.sidewalk];
      if (!same(path[0]!, this.nodes[a]!)) {
        path.reverse();
      }
      let previous = a;
      for (const point of path.slice(1, -1)) {
        const id = this.node(point);
        this.connect(previous, id, true);
        previous = id;
      }
      this.connect(previous, b, true);
    };
    for (let row = 0; row < roads.length; row++) {
      for (let column = 0; column < roads.length; column++) {
        for (const side of [-1, 1]) {
          const x = roads[column]!,
            z = roads[row]!;
          if (column < roads.length - 1) {
            sidewalk(this.id(x + CURB, z + side * CURB), this.id(roads[column + 1]! - CURB, z + side * CURB));
          }
          if (row < roads.length - 1) {
            sidewalk(this.id(x + side * CURB, z + CURB), this.id(x + side * CURB, roads[row + 1]! - CURB));
          }
        }
      }
    }
  }
  private node(p: Point): number {
    const id = this.nodes.length;
    this.lookup.set(`${p.x.toFixed(3)}/${p.z.toFixed(3)}`, id);
    this.nodes.push(p);
    this.edges.push([]);
    return id;
  }
  private id(x: number, z: number): number {
    return this.lookup.get(`${x.toFixed(3)}/${z.toFixed(3)}`)!;
  }
  private connect(a: number, b: number, sidewalk = false): void {
    const length = distance(this.nodes[a]!, this.nodes[b]!);
    this.edges[a]!.push({ to: b, length, sidewalk });
    this.edges[b]!.push({ to: a, length, sidewalk });
  }
  access(p: Point, chain: Point[]): WalkAccess {
    const anchor = chain.at(-1) ?? p;
    let best = Infinity,
      pair = [0, 0],
      projection = anchor;
    for (let a = 0; a < this.nodes.length; a++) {
      for (const { to: b, length, sidewalk } of this.edges[a]!) {
        if (b <= a || !sidewalk) {
          continue;
        } // Attach to a sidewalk, never halfway across a road.
        const pa = this.nodes[a]!,
          pb = this.nodes[b]!;
        const t = Math.max(
          0,
          Math.min(1, ((anchor.x - pa.x) * (pb.x - pa.x) + (anchor.z - pa.z) * (pb.z - pa.z)) / length ** 2),
        );
        const projected = point(pa.x + (pb.x - pa.x) * t, pa.z + (pb.z - pa.z) * t);
        const error = distance(anchor, projected);
        if (error < best) {
          best = error;
          pair = [a, b];
          projection = projected;
        }
      }
    }
    const path = [p, ...chain];
    if (chain.length) {
      path[path.length - 1] = projection;
    } else if (!same(p, projection)) {
      path.push(projection);
    }
    return { point: p, chain: path.filter((p, i, all) => !i || !same(p, all[i - 1]!)), a: pair[0]!, b: pair[1]! };
  }
  walk(from: WalkAccess, to: WalkAccess): Point[] {
    if (same(from.point, to.point)) {
      return [from.point];
    }
    if ((from.a === to.a && from.b === to.b) || (from.a === to.b && from.b === to.a)) {
      const direct = [...from.chain, ...[...to.chain].reverse()];
      return direct.filter((p, i) => !i || !same(p, direct[i - 1]!));
    }
    const dist = new Float64Array(this.nodes.length).fill(Infinity),
      prev = new Int32Array(this.nodes.length).fill(-1),
      done = new Uint8Array(this.nodes.length);
    const anchor = from.chain.at(-1)!;
    for (const id of [from.a, from.b]) {
      dist[id] = distance(anchor, this.nodes[id]!);
    }
    for (let step = 0; step < this.nodes.length; step++) {
      let at = -1,
        best = Infinity;
      for (let i = 0; i < dist.length; i++) {
        if (!done[i] && dist[i]! < best) {
          at = i;
          best = dist[i]!;
        }
      }
      if (at < 0) {
        break;
      }
      done[at] = 1;
      for (const edge of this.edges[at]!) {
        if (best + edge.length < dist[edge.to]!) {
          dist[edge.to] = best + edge.length;
          prev[edge.to] = at;
        }
      }
    }
    const end = to.chain.at(-1)!;
    let at =
      dist[to.a]! + distance(end, this.nodes[to.a]!) < dist[to.b]! + distance(end, this.nodes[to.b]!) ? to.a : to.b;
    const path: Point[] = [];
    while (at >= 0) {
      path.push(this.nodes[at]!);
      at = prev[at]!;
    }
    const result = [...from.chain, ...path.reverse(), ...[...to.chain].reverse()];
    return result.filter((p, i) => !i || !same(p, result[i - 1]!));
  }
  drive(from: RoadAccess, to: RoadAccess): LaneRoute {
    const roads = this.roads,
      width = roads.length;
    const key = JSON.stringify([from, to]),
      cached = this.driveCache.get(key);
    if (cached) {
      return cached;
    }
    const d = DIRECTIONS[from.direction]!;
    if (
      from.direction === to.direction &&
      from.nextColumn === to.nextColumn &&
      from.nextRow === to.nextRow &&
      (to.point.x - from.point.x) * d.x + (to.point.z - from.point.z) * d.z >= 0
    ) {
      return new RouteBuilder(from.point).line(to.point).route();
    }
    const count = width * width * 4,
      costs = new Float64Array(count).fill(Infinity),
      prev = new Int32Array(count).fill(-1),
      done = new Uint8Array(count);
    const keyOf = (c: number, r: number, dir: number) => (r * width + c) * 4 + dir;
    const targetDir = DIRECTIONS[to.direction]!,
      endC = to.nextColumn - targetDir.x,
      endR = to.nextRow - targetDir.z;
    const legal = (c: number, r: number, dir: number) =>
      (c === endC && r === endR && dir === to.direction) ||
      (c + DIRECTIONS[dir]!.x >= 0 &&
        c + DIRECTIONS[dir]!.x < width &&
        r + DIRECTIONS[dir]!.z >= 0 &&
        r + DIRECTIONS[dir]!.z < width);
    const target = keyOf(endC, endR, to.direction);
    for (const out of [from.direction, (from.direction + 1) % 4, (from.direction + 3) % 4]) {
      if (!legal(from.nextColumn, from.nextRow, out)) {
        continue;
      }
      const builder = new RouteBuilder(from.point).line(
        laneEnd(from.nextColumn, from.nextRow, from.direction, true, roads),
      );
      turnAt(builder, from.nextColumn, from.nextRow, from.direction, out, roads);
      costs[keyOf(from.nextColumn, from.nextRow, out)] = builder.length;
    }
    for (let i = 0; i < count; i++) {
      let at = -1,
        best = Infinity;
      for (let n = 0; n < count; n++) {
        if (!done[n] && costs[n]! < best) {
          at = n;
          best = costs[n]!;
        }
      }
      if (at < 0 || at === target) {
        break;
      }
      done[at] = 1;
      const dir = at % 4,
        cell = Math.floor(at / 4),
        c = (cell % width) + DIRECTIONS[dir]!.x,
        r = Math.floor(cell / width) + DIRECTIONS[dir]!.z;
      if (c < 0 || c >= width || r < 0 || r >= width) {
        continue;
      }
      for (const out of [dir, (dir + 1) % 4, (dir + 3) % 4]) {
        if (!legal(c, r, out)) {
          continue;
        }
        const next = keyOf(c, r, out),
          cost =
            best +
            (gridForLayout(this.layout).blockStep - 12) +
            (out === dir ? 12 : out === (dir + 1) % 4 ? Math.PI * 2 : Math.PI * 4);
        if (cost < costs[next]!) {
          costs[next] = cost;
          prev[next] = at;
        }
      }
    }
    if (!Number.isFinite(costs[target])) {
      throw new Error('No connected car route');
    }
    const states: number[] = [];
    for (let at = target; at >= 0; at = prev[at]!) {
      states.push(at);
    }
    states.reverse();
    const builder = new RouteBuilder(from.point);
    let incoming = from.direction;
    for (const state of states) {
      const cell = Math.floor(state / 4),
        c = cell % width,
        r = Math.floor(cell / width),
        outgoing = state % 4;
      builder.line(laneEnd(c, r, incoming, true, roads));
      turnAt(builder, c, r, incoming, outgoing, roads);
      incoming = outgoing;
    }
    builder.line(to.point);
    const route = builder.route();
    this.driveCache.set(key, route);
    return route;
  }
}
function buildingAccess(network: LifeNetwork, b: CityBuilding, offset = 0): WalkAccess {
  const block = network.layout.blocks.find((p) => p.id === b.blockId)!;
  if (b.plot) {
    const north = b.plot.front === 'north',
      sign = north ? -1 : 1;
    const door = point(b.x, b.z + sign * (b.depth / 2 + 0.45));
    return network.access(door, [point(b.x, b.plot.z + sign * 5.7), point(b.x, block.z + sign * 12.55)]);
  }
  const door = point(b.x + offset, b.z + b.depth / 2 + 0.45);
  if (b.z > block.z) {
    return network.access(door, [point(door.x, block.z + 12.55)]);
  }
  const side = b.x < block.x ? -1 : 1;
  return network.access(door, [point(door.x, block.z), point(block.x + side * 12.55, block.z)]);
}
export function createLifeProfile(layout: CityLayout): LifeProfile {
  const network = new LifeNetwork(layout),
    roads = network.roads;
  const profile: LifeProfile = {
    seed: layout.seed,
    layout,
    places: [],
    facilities: [],
    slots: [],
    bays: [],
    garageBuildings: {},
    arrival: roadAccess(point(roads[0]! - 24, -83, 0.91), 0, roads),
  };
  let commercial = 0;
  for (const b of layout.buildings) {
    const kind =
      b.district === 'residential'
        ? 'home'
        : b.district === 'industrial'
          ? 'factory'
          : b.district === 'downtown'
            ? 'office'
            : commercial++ === 0
              ? 'school'
              : commercial % 3 === 0
                ? 'cafe'
                : 'shop';
    const access = buildingAccess(network, b);
    const title = kind === 'school' ? 'Городская школа' : kind === 'cafe' ? `Кафе ${commercial}` : b.name;
    profile.places.push({
      id: b.id,
      name: title,
      kind,
      building: b,
      blockId: b.blockId,
      door: access.point,
      access,
      capacity: kind === 'home' ? (b.plot ? 1 : Math.max(2, b.floors * 2)) : Math.min(32, Math.max(4, b.floors * 2)),
      parking: null,
      price: b.plot ? 3_600_000 : 900_000 + b.floors * 90_000,
      wage: kind === 'office' ? 4500 + b.floors * 70 : kind === 'factory' ? 3200 : kind === 'school' ? 4100 : 2400,
      education: kind === 'office' || kind === 'school' ? 2 : 0,
      open: kind === 'shop' ? 7 * 60 : kind === 'cafe' ? 9 * 60 : 0,
      close: kind === 'shop' ? 23 * 60 : kind === 'cafe' ? 22 * 60 : 1440,
    });
  }
  for (const block of layout.blocks.filter((b) => b.district === 'park')) {
    const door = point(block.x + 5, block.z + 2),
      access = network.access(door, [
        point(block.x + 5, block.z + 5),
        point(block.x, block.z + 5),
        point(block.x, block.z + 12.55),
      ]);
    profile.places.push({
      id: block.id,
      name: 'Парк у воды',
      kind: 'park',
      blockId: block.id,
      door,
      access,
      capacity: 60,
      parking: null,
      price: 0,
      wage: 0,
      education: 0,
      open: 6 * 60,
      close: 23 * 60,
    });
  }
  function facility(
    data: Omit<ParkingFacility, 'id' | 'slots'>,
    spots: Array<{ position: Point; yaw: number }>,
  ): ParkingFacility {
    const f: ParkingFacility = { ...data, id: profile.facilities.length, slots: [] };
    profile.facilities.push(f);
    for (const s of spots) {
      const id = profile.slots.length;
      f.slots.push(id);
      profile.slots.push({
        id,
        facility: f.id,
        ...s,
        width: data.kind === 'street' ? CURB_PARKING.width : 2.4,
        length: data.kind === 'street' ? CURB_PARKING.placeLength : 4.3,
        household: null,
        occupant: null,
        reserved: null,
      });
    }
    return f;
  }
  for (const place of profile.places.filter((p) => p.building?.plot)) {
    const b = place.building!,
      p = b.plot!,
      block = layout.blocks.find((b) => b.id === pBlock(place))!,
      sign = p.front === 'north' ? -1 : 1;
    const transform = (x: number, z: number, y = 1.12) => point(p.x + sign * x, p.z + sign * z, y);
    const entrance = transform(3.6, 5.7),
      position = transform(3.6, p.annex === 'garage' ? -1.8 : 3.1);
    const direction = sign === 1 ? 2 : 0,
      lane = point(entrance.x + DIRECTIONS[direction].x * 4, block.z + sign * 15, 0.91);
    const pickup = transform(2.5, p.annex === 'garage' ? 0.95 : 3.1);
    const access = network.access(pickup, [transform(2.5, 5.7), point(pickup.x, block.z + sign * 12.55)]);
    const f = facility(
      {
        kind: 'private',
        name: p.annex === 'garage' ? `Гараж: ${place.name}` : `Стоянка: ${place.name}`,
        buildingId: b.id,
        blockId: b.blockId,
        entrance,
        yaw: sign === 1 ? 0 : Math.PI,
        road: roadAccess(lane, direction, roads),
        access,
        residentsOnly: true,
        fee: 0,
      },
      [{ position, yaw: sign === 1 ? 0 : Math.PI }],
    );
    place.parking = f.id;
  }
  for (const block of layout.blocks.filter((b) => !['industrial', 'park'].includes(b.district))) {
    const candidates = profile.places.filter(
      (p) =>
        p.blockId === block.id && !p.building?.plot && p.building && p.building.z > block.z && p.building.floors >= 6,
    );
    if (!candidates.length) {
      continue;
    }
    candidates.sort((a, b) => Math.abs(a.building!.x - block.x - 2) - Math.abs(b.building!.x - block.x - 2));
    const host = candidates[0]!,
      b = host.building!;
    const gx = b.x - b.width / 2 + 1.2,
      entrance = point(gx, b.z + b.depth / 2 + 0.2, 0.91);
    host.access = buildingAccess(network, b, Math.min(1.4, b.width / 4));
    host.door = host.access.point;
    const count = block.district === 'residential' ? 18 : 16;
    const f = facility(
      {
        kind: 'underground',
        name: `Паркинг: ${host.name}`,
        buildingId: b.id,
        blockId: b.blockId,
        entrance,
        yaw: 0,
        road: roadAccess(point(gx + 4, block.z + 15, 0.91), 2, roads),
        access: host.access,
        residentsOnly: block.district === 'residential',
        fee: block.district === 'residential' ? 0 : 40,
      },
      Array.from({ length: count }, () => ({ position: point(gx, entrance.z - 4, -1.5), yaw: Math.PI })),
    );
    profile.garageBuildings[b.id] = f.id;
    for (const p of profile.places.filter((p) => p.blockId === block.id)) {
      p.parking = f.id;
    }
  }
  for (const segment of streetParkingSegments(layout)) {
    const { center, direction } = segment,
      d = DIRECTIONS[direction]!,
      r = rightOf(direction);
    const road = roadAccess(
      add(add(center, r, CURB_PARKING.laneOffset), d, -CURB_PARKING.placeLength / 2 - 4),
      direction,
      roads,
    );
    const entrance = add(center, r, CURB_PARKING.centerOffset);
    const access = network.access({ ...add(center, r, CURB_PARKING.sidewalkOffset), y: 1.07 }, []);
    const f = facility(
      {
        kind: 'street',
        name: `Уличная парковка ${profile.bays.length + 1}`,
        buildingId: null,
        blockId: segment.id,
        entrance,
        yaw: Math.atan2(d.x, d.z),
        road,
        access,
        residentsOnly: false,
        fee: 15,
      },
      [-1, 1].map((side) => ({
        position: add(entrance, d, (side * CURB_PARKING.placeLength) / 2),
        yaw: Math.atan2(d.x, d.z),
      })),
    );
    profile.bays.push({
      x: center.x,
      z: center.z,
      yaw: f.yaw,
      facility: f.id,
      blockId: segment.blockId,
      sidewalk: segment.sidewalk,
    });
  }
  if (gridForLayout(layout).minRow < 0) {
    const door = point(-24, -126.5),
      access = network.access(door, [point(-24, -123.45)]);
    const parking =
      profile.facilities
        .filter((f) => f.kind === 'street')
        .sort((a, b) => distance(a.entrance, door) - distance(b.entrance, door))[0]?.id ?? null;
    profile.places.push({
      id: 'railway-station',
      name: 'Городской вокзал',
      kind: 'station',
      blockId: 'block-2--1',
      door,
      access,
      capacity: 0,
      parking,
      price: 0,
      wage: 0,
      education: 0,
      open: 0,
      close: 1440,
    });
  }
  return profile;
}
function pBlock(p: LifePlace): string {
  return p.blockId;
}
export function departureAccess(f: ParkingFacility, slot: ParkingSlot, roads = CITY_ROAD_CENTERS): RoadAccess {
  const d = DIRECTIONS[f.road.direction]!,
    r = rightOf(f.road.direction);
  if (f.kind === 'street') {
    return roadAccess(
      add(add(slot.position, r, CURB_PARKING.laneOffset - CURB_PARKING.centerOffset), d, 4),
      f.road.direction,
      roads,
    );
  }
  if (f.kind === 'underground') {
    return roadAccess(add(f.road.point, d, 8), f.road.direction, roads);
  }
  return f.road;
}
export function parkingWalkAccess(network: LifeNetwork, f: ParkingFacility, slot: ParkingSlot): WalkAccess {
  if (f.kind !== 'street') {
    return f.access;
  }
  const r = rightOf(f.road.direction),
    pickup = add(slot.position, r, 1.1);
  return network.access({ ...pickup, y: 1.07 }, [
    { ...add(slot.position, r, CURB_PARKING.sidewalkOffset - CURB_PARKING.centerOffset), y: 1.07 },
  ]);
}
export function parkingRoute(f: ParkingFacility, slot: ParkingSlot, entering: boolean): PlannedDrive {
  const d = DIRECTIONS[f.road.direction]!,
    out = { x: Math.sin(f.yaw), z: Math.cos(f.yaw) };
  if (f.kind === 'street') {
    const r = rightOf(f.road.direction),
      near = add(add(slot.position, r, CURB_PARKING.laneOffset - CURB_PARKING.centerOffset), d, -4),
      exit = departureAccess(f, slot).point;
    const b = new RouteBuilder(entering ? f.road.point : slot.position);
    if (entering) {
      b.line(near).curve(add(near, d, 2.6), add(slot.position, d, -2.6), slot.position);
    } else {
      b.curve(add(slot.position, d, 2.6), add(exit, d, -2.6), exit);
    }
    return { route: b.route(), stops: [0, b.length] };
  }
  if (f.kind === 'private') {
    const mouth = add(f.entrance, out, 1.8),
      b = new RouteBuilder(entering ? f.road.point : slot.position);
    if (entering) {
      b.curve(add(f.road.point, d, -3), add(mouth, out, 2), mouth, true).line(slot.position, true);
    } else {
      b.line(mouth).curve(add(mouth, out, 2), add(f.road.point, d, -3), f.road.point);
    }
    return { route: b.route(), stops: [0, b.length] };
  }
  const exit = departureAccess(f, slot).point,
    mouth = add(f.entrance, out, 1.2),
    b = new RouteBuilder(entering ? f.road.point : slot.position);
  if (entering) {
    b.curve(add(f.road.point, d, 3), add(mouth, out, 2), mouth).line(slot.position);
  } else {
    b.line(mouth).curve(add(mouth, out, 2), add(exit, d, -3), exit);
  }
  return { route: b.route(), stops: [0, b.length] };
}
