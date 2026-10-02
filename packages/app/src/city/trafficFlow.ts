import { CITY_ROAD_CENTERS, createTrafficRoutes, sampleLaneRoute, type LanePose, type LaneRoute } from './trafficRoutes';

interface VehicleSize { length: number; width: number }
interface Vehicle {
  id: number; size: VehicleSize; route: LaneRoute;
  start: number; distance: number; previous: number; speed: number; waiting: number; pose: LanePose;
  plan: TrafficPlan | undefined; stopIndex: number; stopDistance: number; stopped: boolean;
}
export interface TrafficPlan { route: LaneRoute; stops: readonly number[]; initialStop: number }
export interface JunctionBounds { id: number; minX: number; maxX: number; minZ: number; maxZ: number }
interface TrafficOptions {
  plans?: ReadonlyMap<number, TrafficPlan>;
  junctions?: readonly JunctionBounds[];
  onStep?: (seconds: number, traffic: CityTraffic) => void;
  onReset?: () => void;
}

const STEP = 0.05;
const SPEED = 5.5;
const ACCELERATION = 2.2;
const BRAKING = 4;
const BUMPER_MARGIN = 0.7;
const SIDE_MARGIN = 0.12;
const JUNCTION_HALF = 6;
const PROBE_STEP = 0.4;

/** Oriented footprints include the complete kit and a bumper gap. Opposite lanes remain independent. */
function overlaps(a: LanePose, aSize: VehicleSize, b: LanePose, bSize: VehicleSize): boolean {
  const x = b.x - a.x, z = b.z - a.z;
  const al = aSize.length / 2 + BUMPER_MARGIN, aw = aSize.width / 2 + SIDE_MARGIN;
  const bl = bSize.length / 2 + BUMPER_MARGIN, bw = bSize.width / 2 + SIDE_MARGIN;
  if (Math.abs(x) > al + aw + bl + bw || Math.abs(z) > al + aw + bl + bw) return false;
  const c = Math.abs(a.dx * b.dx + a.dz * b.dz), s = Math.abs(a.dx * b.dz - a.dz * b.dx);
  return Math.abs(x * a.dx + z * a.dz) < al + bl * c + bw * s
    && Math.abs(-x * a.dz + z * a.dx) < aw + bl * s + bw * c
    && Math.abs(x * b.dx + z * b.dz) < bl + al * c + aw * s
    && Math.abs(-x * b.dz + z * b.dx) < bw + al * s + aw * c;
}

function junction(p: LanePose, size: VehicleSize, extensions: readonly JunctionBounds[] = []): number {
  const halfLength = size.length / 2 + BUMPER_MARGIN, halfWidth = size.width / 2 + SIDE_MARGIN;
  const ex = halfLength * Math.abs(p.dx) + halfWidth * Math.abs(p.dz);
  const ez = halfLength * Math.abs(p.dz) + halfWidth * Math.abs(p.dx);
  for (const box of extensions) if (p.x + ex > box.minX && p.x - ex < box.maxX && p.z + ez > box.minZ && p.z - ez < box.maxZ) return box.id;
  const column = Math.round((p.x - CITY_ROAD_CENTERS[0]!) / 34);
  const row = Math.round((p.z - CITY_ROAD_CENTERS[0]!) / 34);
  const x = CITY_ROAD_CENTERS[column], z = CITY_ROAD_CENTERS[row];
  if (x === undefined || z === undefined) return -1;
  const l = size.length / 2 + BUMPER_MARGIN, w = size.width / 2 + SIDE_MARGIN;
  return Math.abs(p.x - x) < JUNCTION_HALF + l * Math.abs(p.dx) + w * Math.abs(p.dz)
    && Math.abs(p.z - z) < JUNCTION_HALF + l * Math.abs(p.dz) + w * Math.abs(p.dx)
    ? row * CITY_ROAD_CENTERS.length + column : -1;
}

/** Ambient traffic with fixed steps, shared junction reservations and frame-rate-independent sampling. */
export class CityTraffic {
  private readonly vehicles: Vehicle[] = [];
  private readonly owners: Int32Array;
  private readonly held: Int32Array;
  private readonly order: Vehicle[];
  private tick = 0;
  private lastTime = 0;

  constructor(sizes: readonly VehicleSize[], private readonly options: TrafficOptions = {}) {
    this.owners = new Int32Array(Math.max(CITY_ROAD_CENTERS.length ** 2, ...(options.junctions ?? []).map((j) => j.id + 1))).fill(-1);
    const routes = createTrafficRoutes(), perRoute = Math.max(1, Math.ceil((sizes.length - (options.plans?.size ?? 0)) / routes.length));
    this.held = new Int32Array(sizes.length).fill(-1);
    for (const [id, size] of sizes.entries()) {
      const plan = options.plans?.get(id);
      const route = plan?.route ?? routes[id % routes.length]!;
      let distance = plan ? plan.stops[plan.initialStop]! : (Math.floor(id / routes.length) / perRoute + (id % routes.length) * 0.017) * route.length;
      let pose = sampleLaneRoute(route, distance), found = false;
      // Spawn on an unoccupied street segment, never inside a junction or another assembly.
      for (let attempt = 0; attempt < (plan ? 1 : Math.ceil(route.length / 2)); attempt++) {
        pose = sampleLaneRoute(route, distance);
        if (junction(pose, size, options.junctions) < 0 && !this.vehicles.some((v) => overlaps(pose, size, v.pose, v.size))) { found = true; break; }
        distance += 2;
      }
      if (!found) throw new Error('City traffic has no free spawn position');
      this.vehicles.push({ id, size, route, start: distance, distance, previous: distance, speed: plan ? 0 : SPEED, waiting: 0, pose, plan, stopIndex: plan?.initialStop ?? -1, stopDistance: plan ? distance : Infinity, stopped: !!plan });
    }
    this.order = [...this.vehicles];
    options.onStep?.(0, this);
  }

  atStop(id: number): number | null {
    const vehicle = this.vehicles[id];
    return vehicle?.stopped ? vehicle.stopIndex : null;
  }

  release(id: number): void {
    const vehicle = this.vehicles[id];
    if (!vehicle?.plan || !vehicle.stopped) return;
    vehicle.stopIndex = (vehicle.stopIndex + 1) % vehicle.plan.stops.length;
    const next = vehicle.plan.stops[vehicle.stopIndex]!;
    const delta = ((next - vehicle.distance) % vehicle.route.length + vehicle.route.length) % vehicle.route.length;
    vehicle.stopDistance = vehicle.distance + (delta < 1e-6 ? vehicle.route.length : delta);
    vehicle.stopped = false; vehicle.waiting = 0;
  }

  pose(id: number): LanePose { return this.vehicles[id]!.pose; }

  update(seconds: number): LanePose[] {
    const time = Math.max(0, seconds);
    if (time < this.lastTime - 1e-8) this.reset();
    while (this.tick * STEP < time - 1e-9) this.step();
    this.lastTime = time;
    const alpha = this.tick === 0 ? 1 : Math.max(0, Math.min(1, (time - (this.tick - 1) * STEP) / STEP));
    return this.vehicles.map((v) => sampleLaneRoute(v.route, v.previous + (v.distance - v.previous) * alpha));
  }

  private reset(): void {
    this.tick = 0; this.owners.fill(-1); this.held.fill(-1);
    for (const v of this.vehicles) {
      v.distance = v.start; v.previous = v.start; v.speed = v.plan ? 0 : SPEED; v.waiting = 0;
      v.stopped = !!v.plan; v.stopIndex = v.plan?.initialStop ?? -1; v.stopDistance = v.plan ? v.start : Infinity;
      v.pose = sampleLaneRoute(v.route, v.start);
    }
    this.options.onReset?.();
    this.options.onStep?.(0, this);
  }

  private occupied(pose: LanePose, car: Vehicle): boolean {
    return this.vehicles.some((other) => other.id !== car.id && overlaps(pose, car.size, other.pose, other.size));
  }

  private exitFree(car: Vehicle, gate: number, entryDistance: number): boolean {
    for (let ahead = 0.5; ahead <= 80; ahead += 0.5) {
      const exit = sampleLaneRoute(car.route, entryDistance + ahead);
      // A driveway can merge before a junction. Reserve the entire swept exit path,
      // otherwise a long truck can trap a waiting car behind its own reservation.
      if (this.occupied(exit, car)) return false;
      if (junction(exit, car.size, this.options.junctions) !== gate) {
        // The footprint already includes its bumper gap. Reserving extra road beyond
        // a fully cleared exit can make two long trucks wait forever for each other.
        return true;
      }
    }
    return false;
  }

  private step(): void {
    for (const car of this.vehicles) {
      car.previous = car.distance;
      const gate = this.held[car.id]!;
      if (gate >= 0 && junction(car.pose, car.size, this.options.junctions) !== gate) {
        this.owners[gate] = -1; this.held[car.id] = -1;
      }
    }
    // Clear cars already inside first, then let the longest-waiting approach take the next turn.
    this.order.sort((a, b) => Number(this.held[b.id]! >= 0) - Number(this.held[a.id]! >= 0) || b.waiting - a.waiting || a.id - b.id);
    for (const car of this.order) {
      if (car.stopped) continue;
      const exits = new Map<number, boolean>();
      const blocked = (ahead: number) => {
        const distance = car.distance + ahead, pose = sampleLaneRoute(car.route, distance);
        if (this.occupied(pose, car)) return true;
        const gate = junction(pose, car.size, this.options.junctions);
        if (gate < 0 || this.owners[gate] === car.id) return false;
        if (this.owners[gate]! >= 0) return true;
        let clear = exits.get(gate);
        if (clear === undefined) { clear = this.exitFree(car, gate, distance); exits.set(gate, clear); }
        return !clear;
      };
      const horizon = Math.max(1.2, car.speed * car.speed / (2 * BRAKING) + 1.25);
      let free = horizon;
      for (let ahead = PROBE_STEP; ahead <= horizon + PROBE_STEP; ahead += PROBE_STEP) {
        if (blocked(ahead)) { free = Math.max(0, ahead - PROBE_STEP); break; }
      }
      const remaining = Math.max(0, car.stopDistance - car.distance);
      const desired = Math.min(SPEED, Math.sqrt(2 * BRAKING * Math.max(0, free - 0.1)), Math.sqrt(2 * BRAKING * remaining));
      let speed = car.speed + Math.max(-BRAKING * STEP, Math.min(ACCELERATION * STEP, desired - car.speed));
      let movement = Math.min(free, remaining, (car.speed + speed) * STEP / 2);
      if (remaining < 0.002 && free >= remaining) movement = remaining;
      if (movement <= 1e-6 || blocked(movement)) { movement = 0; speed = 0; }
      car.distance += movement; car.speed = speed; car.waiting = movement < 0.005 ? car.waiting + STEP : 0;
      if (car.plan && car.stopDistance - car.distance < 1e-6) { car.stopped = true; car.speed = 0; car.waiting = 0; }
      car.pose = sampleLaneRoute(car.route, car.distance);
      const gate = junction(car.pose, car.size, this.options.junctions);
      if (gate >= 0) { this.owners[gate] = car.id; this.held[car.id] = gate; }
    }
    this.tick++;
    this.options.onStep?.(this.tick * STEP, this);
  }
}
