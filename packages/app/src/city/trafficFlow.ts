import {
  CITY_ROAD_CENTERS,
  createTrafficRoutes,
  sampleLaneRoute,
  type LanePose,
  type LaneRoute,
} from './trafficRoutes';

interface VehicleSize {
  length: number;
  width: number;
}
interface Vehicle {
  id: number;
  size: VehicleSize;
  route: LaneRoute;
  start: number;
  distance: number;
  previous: number;
  speed: number;
  waiting: number;
  pose: LanePose;
  plan: TrafficPlan | undefined;
  stopIndex: number;
  stopDistance: number;
  stopped: boolean;
  active: boolean;
  dormant: boolean;
  maneuverUntil: number;
}
export interface TrafficPlan {
  route: LaneRoute;
  stops: readonly number[];
  initialStop: number;
}
export interface JunctionBounds {
  id: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
interface TrafficOptions {
  roads?: readonly number[];
  blocked?: (
    proposed: LanePose,
    current: LanePose,
    size: VehicleSize,
    currentSize: VehicleSize,
  ) => boolean;
  plans?: ReadonlyMap<number, TrafficPlan>;
  junctions?: readonly JunctionBounds[];
  onStep?: (seconds: number, traffic: CityTraffic) => void;
  onReset?: () => void;
  initiallyInactive?: ReadonlySet<number>;
  pedestrians?: () => ReadonlyArray<{x: number; z: number}>;
}
export interface TrafficSave {
  tick: number;
  lastTime: number;
  owners: number[];
  held: number[];
  vehicles: Array<
    Omit<Vehicle, 'stopDistance'> & {stopDistance: number | null}
  >;
}

const STEP = 0.05;
const SPEED = 5.5;
const ACCELERATION = 2.2;
const BRAKING = 4;
const BUMPER_MARGIN = 0.7;
const SIDE_MARGIN = 0.12;
const JUNCTION_HALF = 6;
const PROBE_STEP = 0.4;
const SPATIAL_CELL = 12;

/** Oriented footprints include the complete kit and a bumper gap. Opposite lanes remain independent. */
function overlaps(
  a: LanePose,
  aSize: VehicleSize,
  b: LanePose,
  bSize: VehicleSize,
): boolean {
  const x = b.x - a.x;
  const z = b.z - a.z;
  const al = aSize.length / 2 + BUMPER_MARGIN;
  const aw = aSize.width / 2 + SIDE_MARGIN;
  const bl = bSize.length / 2 + BUMPER_MARGIN;
  const bw = bSize.width / 2 + SIDE_MARGIN;

  if (Math.abs(x) > al + aw + bl + bw || Math.abs(z) > al + aw + bl + bw) {
    return false;
  }

  const c = Math.abs(a.dx * b.dx + a.dz * b.dz);
  const s = Math.abs(a.dx * b.dz - a.dz * b.dx);

  return (
    Math.abs(x * a.dx + z * a.dz) < al + bl * c + bw * s &&
    Math.abs(-x * a.dz + z * a.dx) < aw + bl * s + bw * c &&
    Math.abs(x * b.dx + z * b.dz) < bl + al * c + aw * s &&
    Math.abs(-x * b.dz + z * b.dx) < bw + al * s + aw * c
  );
}

function junction(
  p: LanePose,
  size: VehicleSize,
  extensions: readonly JunctionBounds[] = [],
  roads: readonly number[] = CITY_ROAD_CENTERS,
): number {
  const halfLength = size.length / 2 + BUMPER_MARGIN;
  const halfWidth = size.width / 2 + SIDE_MARGIN;
  const ex = halfLength * Math.abs(p.dx) + halfWidth * Math.abs(p.dz);
  const ez = halfLength * Math.abs(p.dz) + halfWidth * Math.abs(p.dx);

  for (const box of extensions) {
    if (
      p.x + ex > box.minX &&
      p.x - ex < box.maxX &&
      p.z + ez > box.minZ &&
      p.z - ez < box.maxZ
    ) {
      return box.id;
    }
  }

  const column = Math.round((p.x - roads[0]!) / 34);
  const row = Math.round((p.z - roads[0]!) / 34);
  const x = roads[column];
  const z = roads[row];

  if (x === undefined || z === undefined) {
    return -1;
  }

  const l = size.length / 2 + BUMPER_MARGIN;
  const w = size.width / 2 + SIDE_MARGIN;

  return Math.abs(p.x - x) <
    JUNCTION_HALF + l * Math.abs(p.dx) + w * Math.abs(p.dz) &&
    Math.abs(p.z - z) < JUNCTION_HALF + l * Math.abs(p.dz) + w * Math.abs(p.dx)
    ? row * roads.length + column
    : -1;
}

interface ManeuverFootprint {
  pose: LanePose;
  size: VehicleSize;
  until: number;
}

/** A line segment sweeps an exact oriented rectangle, including both headings at
 * a corner. Sampling just points misses short collisions while the body turns. */
function maneuverFootprints(
  route: LaneRoute,
  size: VehicleSize,
  until: number,
): ManeuverFootprint[] {
  const footprints: ManeuverFootprint[] = [];
  let start = 0;

  for (const segment of route.segments) {
    const length = Math.min(segment.length, until - start);

    if (length <= 0) {
      break;
    }
    if (segment.kind === 'line') {
      footprints.push({
        pose: sampleLaneRoute(route, start + length / 2),
        size: {length: size.length + length, width: size.width},
        until: start + length,
      });
    } else {
      // Bound translation and rotation around each arc sample, not just its center.
      const count = Math.ceil(length / 0.25);
      const step = length / count;
      const radius = Math.hypot(
        size.length / 2 + BUMPER_MARGIN,
        size.width / 2 + SIDE_MARGIN,
      );
      const padding = step / 2 + (radius * step) / (2 * segment.radius);

      for (let i = 0; i < count; i++) {
        footprints.push({
          pose: sampleLaneRoute(route, start + (i + 0.5) * step),
          size: {
            length: size.length + padding * 2,
            width: size.width + padding * 2,
          },
          until: start + (i + 1) * step,
        });
      }
    }

    start += segment.length;
  }

  return footprints;
}

interface SpatialBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function spatialBounds(pose: LanePose, size: VehicleSize): SpatialBounds {
  const l = size.length / 2 + BUMPER_MARGIN;
  const w = size.width / 2 + SIDE_MARGIN;
  const x = l * Math.abs(pose.dx) + w * Math.abs(pose.dz);
  const z = l * Math.abs(pose.dz) + w * Math.abs(pose.dx);

  return {
    minX: Math.floor((pose.x - x) / SPATIAL_CELL),
    maxX: Math.floor((pose.x + x) / SPATIAL_CELL),
    minZ: Math.floor((pose.z - z) / SPATIAL_CELL),
    maxZ: Math.floor((pose.z + z) / SPATIAL_CELL),
  };
}

/** Ambient traffic with fixed steps, shared junction reservations and frame-rate-independent sampling. */
export class CityTraffic {
  private readonly vehicles: Vehicle[] = [];
  private readonly roads: readonly number[];
  private readonly owners: Int32Array;
  private held: Int32Array;
  private readonly order: Vehicle[];
  private readonly activeVehicles: Vehicle[] = [];
  private tick = 0;
  private lastTime = 0;
  // Derived geometry is rebuilt on restore; saved routes remain the source of truth.
  private readonly maneuvers = new Map<number, ManeuverFootprint[]>();
  private readonly maneuverJunctions = new Map<number, Set<number>>();
  private readonly spatial = new Map<number, Map<number, Set<Vehicle>>>();
  private readonly indexed = new Map<number, SpatialBounds>();

  constructor(
    sizes: readonly VehicleSize[],
    private readonly options: TrafficOptions = {},
  ) {
    this.roads = options.roads ?? CITY_ROAD_CENTERS;
    this.owners = new Int32Array(
      Math.max(
        this.roads.length ** 2,
        ...(options.junctions ?? []).map(j => j.id + 1),
      ),
    ).fill(-1);
    const routes = createTrafficRoutes(this.roads);
    const perRoute = Math.max(
      1,
      Math.ceil((sizes.length - (options.plans?.size ?? 0)) / routes.length),
    );

    this.held = new Int32Array(sizes.length).fill(-1);

    for (const [id, size] of sizes.entries()) {
      const plan = options.plans?.get(id);

      if (options.initiallyInactive?.has(id)) {
        const route: LaneRoute = {
          direction: 1,
          closed: false,
          length: 1,
          segments: [
            {
              kind: 'line',
              x: 10000 + id * 20,
              z: 10000,
              dx: 1,
              dz: 0,
              length: 1,
            },
          ],
        };

        this.vehicles.push({
          id,
          size,
          route,
          start: 0,
          distance: 0,
          previous: 0,
          speed: 0,
          waiting: 0,
          pose: sampleLaneRoute(route, 0),
          plan: undefined,
          stopIndex: -1,
          stopDistance: Infinity,
          stopped: true,
          active: false,
          dormant: true,
          maneuverUntil: 0,
        });
        continue;
      }

      const route = plan?.route ?? routes[id % routes.length]!;
      let distance = plan
        ? plan.stops[plan.initialStop]!
        : (Math.floor(id / routes.length) / perRoute +
            (id % routes.length) * 0.017) *
          route.length;
      let pose = sampleLaneRoute(route, distance);
      let found = false;

      // Spawn on an unoccupied street segment, never inside a junction or another assembly.
      for (
        let attempt = 0;
        attempt < (plan ? 1 : Math.ceil(route.length / 2));
        attempt++
      ) {
        pose = sampleLaneRoute(route, distance);

        if (
          junction(pose, size, options.junctions, this.roads) < 0 &&
          !this.vehicles.some(v => overlaps(pose, size, v.pose, v.size))
        ) {
          found = true;
          break;
        }

        distance += 2;
      }

      if (!found) {
        throw new Error('City traffic has no free spawn position');
      }

      this.vehicles.push({
        id,
        size,
        route,
        start: distance,
        distance,
        previous: distance,
        speed: plan ? 0 : SPEED,
        waiting: 0,
        pose,
        plan,
        stopIndex: plan?.initialStop ?? -1,
        stopDistance: plan ? distance : Infinity,
        stopped: !!plan,
        active: true,
        dormant: false,
        maneuverUntil: 0,
      });
    }

    this.order = [...this.vehicles];
    this.activeVehicles.push(...this.vehicles.filter(v => v.active));
    this.rebuildSpatial();
    options.onStep?.(0, this);
  }

  atStop(id: number): number | null {
    const vehicle = this.vehicles[id];

    return vehicle?.stopped ? vehicle.stopIndex : null;
  }

  release(id: number): void {
    const vehicle = this.vehicles[id];

    if (!vehicle?.plan || !vehicle.stopped) {
      return;
    }

    vehicle.stopIndex = (vehicle.stopIndex + 1) % vehicle.plan.stops.length;
    const next = vehicle.plan.stops[vehicle.stopIndex]!;
    const delta =
      (((next - vehicle.distance) % vehicle.route.length) +
        vehicle.route.length) %
      vehicle.route.length;

    vehicle.stopDistance =
      vehicle.distance + (delta < 1e-6 ? vehicle.route.length : delta);
    vehicle.stopped = false;
    vehicle.waiting = 0;
  }

  pose(id: number): LanePose {
    return this.vehicles[id]!.pose;
  }

  isActive(id: number): boolean {
    return this.vehicles[id]?.active ?? false;
  }

  addCar(size: VehicleSize): number {
    const id = this.vehicles.length;
    const route: LaneRoute = {
      direction: 1,
      closed: false,
      length: 1,
      segments: [
        {kind: 'line', x: 10000 + id * 20, z: 10000, dx: 1, dz: 0, length: 1},
      ],
    };

    this.vehicles.push({
      id,
      size,
      route,
      start: 0,
      distance: 0,
      previous: 0,
      speed: 0,
      waiting: 0,
      pose: sampleLaneRoute(route, 0),
      plan: undefined,
      stopIndex: -1,
      stopDistance: Infinity,
      stopped: true,
      active: false,
      dormant: true,
      maneuverUntil: 0,
    });
    const held = new Int32Array(id + 1).fill(-1);

    held.set(this.held);
    this.held = held;

    return id;
  }

  movingPoses(): Array<
    LanePose & {speed: number; id: number; length: number; width: number}
  > {
    return this.activeVehicles.map(v => ({
      ...v.pose,
      speed: v.speed,
      id: v.id,
      length: v.size.length,
      width: v.size.width,
    }));
  }

  beginTrip(id: number, route: LaneRoute, maneuverUntil = 0): boolean {
    const car = this.vehicles[id];

    if (!car || route.length <= 1e-7) {
      return false;
    }

    const pose = sampleLaneRoute(route, 0);
    // A dormant car starts at its real parking/entry point, not its off-map render placeholder.
    const current = car.active ? car.pose : pose;

    if (this.occupied(pose, car, car.size, false, current)) {
      return false;
    }

    const maneuver = maneuverFootprints(route, car.size, maneuverUntil);
    const gates = this.maneuverGates(maneuver);

    if (
      [...gates].some(
        gate => this.owners[gate]! >= 0 && this.owners[gate] !== id,
      )
    ) {
      return false;
    }

    for (const footprint of maneuver) {
      if (this.occupied(footprint.pose, car, footprint.size, false, current)) {
        return false;
      }
    }

    this.park(id);
    car.route = route;
    car.start = 0;
    car.distance = 0;
    car.previous = 0;
    car.speed = 0;
    car.waiting = 0;
    car.maneuverUntil = maneuverUntil;

    if (maneuver.length) {
      this.maneuvers.set(id, maneuver);
      this.maneuverJunctions.set(id, gates);

      for (const gate of gates) {
        this.owners[gate] = id;
      }
    }

    car.pose = pose;
    car.plan = {route, stops: [0, route.length], initialStop: 0};
    car.stopIndex = 1;
    car.stopDistance = route.length;
    car.stopped = false;
    car.active = true;
    this.activeVehicles.push(car);
    this.updateSpatial(car);

    return true;
  }

  park(id: number): void {
    const car = this.vehicles[id];

    if (!car) {
      return;
    }

    for (const reserved of this.maneuverJunctions.get(id) ?? []) {
      if (this.owners[reserved] === id) {
        this.owners[reserved] = -1;
      }
    }

    this.maneuverJunctions.delete(id);
    const gate = this.held[id]!;

    if (gate >= 0 && this.owners[gate] === id) {
      this.owners[gate] = -1;
    }

    this.held[id] = -1;
    car.maneuverUntil = 0;
    this.maneuvers.delete(id);
    this.removeSpatial(car);
    car.active = false;
    car.stopped = true;
    car.speed = 0;
    const at = this.activeVehicles.indexOf(car);

    if (at >= 0) {
      this.activeVehicles.splice(at, 1);
    }
  }

  save(): TrafficSave {
    return structuredClone({
      tick: this.tick,
      lastTime: this.lastTime,
      owners: Array.from(this.owners),
      held: Array.from(this.held),
      vehicles: this.vehicles.map(v => ({
        ...v,
        stopDistance: Number.isFinite(v.stopDistance) ? v.stopDistance : null,
      })),
    });
  }

  restore(saved: TrafficSave): void {
    while (saved.vehicles.length > this.vehicles.length) {
      this.addCar(saved.vehicles[this.vehicles.length]!.size);
    }

    if (saved.vehicles.length !== this.vehicles.length) {
      throw new Error('Invalid saved traffic capacity');
    }

    const data = structuredClone(saved);

    this.tick = data.tick;
    this.lastTime = data.lastTime;
    this.owners.set(data.owners);
    this.held.set(data.held);
    this.activeVehicles.length = 0;
    this.maneuvers.clear();
    this.maneuverJunctions.clear();
    data.vehicles.forEach((v, i) => {
      Object.assign(this.vehicles[i]!, v, {
        stopDistance: v.stopDistance ?? Infinity,
      });

      if (v.active) {
        this.activeVehicles.push(this.vehicles[i]!);

        if (v.maneuverUntil > v.distance) {
          const maneuver = maneuverFootprints(v.route, v.size, v.maneuverUntil);

          this.maneuvers.set(v.id, maneuver);
          this.maneuverJunctions.set(
            v.id,
            new Set(
              [...this.maneuverGates(maneuver)].filter(
                gate => this.owners[gate] === v.id,
              ),
            ),
          );
        }
      }
    });
    this.rebuildSpatial();
  }

  update(seconds: number): LanePose[] {
    const time = Math.max(0, seconds);

    if (time < this.lastTime - 1e-8) {
      this.reset();
    }

    while (this.tick * STEP < time - 1e-9) {
      this.step();
    }

    this.lastTime = time;
    const alpha =
      this.tick === 0
        ? 1
        : Math.max(0, Math.min(1, (time - (this.tick - 1) * STEP) / STEP));

    return this.vehicles.map(v =>
      sampleLaneRoute(v.route, v.previous + (v.distance - v.previous) * alpha),
    );
  }

  private reset(): void {
    this.tick = 0;
    this.maneuvers.clear();
    this.maneuverJunctions.clear();
    this.owners.fill(-1);
    this.held.fill(-1);
    this.activeVehicles.length = 0;

    for (const v of this.vehicles) {
      v.distance = v.start;
      v.previous = v.start;
      v.speed = v.plan ? 0 : SPEED;
      v.waiting = 0;
      v.stopped = !!v.plan;
      v.stopIndex = v.plan?.initialStop ?? -1;
      v.stopDistance = v.plan ? v.start : Infinity;
      v.pose = sampleLaneRoute(v.route, v.start);
      v.active = !v.dormant;

      if (v.active) {
        this.activeVehicles.push(v);
      }
    }

    this.rebuildSpatial();
    this.options.onReset?.();
    this.options.onStep?.(0, this);
  }

  private removeSpatial(car: Vehicle): void {
    const bounds = this.indexed.get(car.id);

    if (!bounds) {
      return;
    }

    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const column = this.spatial.get(x)!;

      for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
        const cell = column.get(z)!;

        cell.delete(car);

        if (!cell.size) {
          column.delete(z);
        }
      }

      if (!column.size) {
        this.spatial.delete(x);
      }
    }

    this.indexed.delete(car.id);
  }

  private updateSpatial(car: Vehicle): void {
    const bounds = spatialBounds(car.pose, car.size);
    const previous = this.indexed.get(car.id);

    if (
      previous &&
      previous.minX === bounds.minX &&
      previous.maxX === bounds.maxX &&
      previous.minZ === bounds.minZ &&
      previous.maxZ === bounds.maxZ
    ) {
      return;
    }

    this.removeSpatial(car);
    this.indexed.set(car.id, bounds);

    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      let column = this.spatial.get(x);

      if (!column) {
        column = new Map();
        this.spatial.set(x, column);
      }

      for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
        let cell = column.get(z);

        if (!cell) {
          cell = new Set();
          column.set(z, cell);
        }

        cell.add(car);
      }
    }
  }

  private rebuildSpatial(): void {
    this.spatial.clear();
    this.indexed.clear();

    for (const car of this.activeVehicles) {
      this.updateSpatial(car);
    }
  }

  /** Reserve a parking exit and every junction it sweeps as one operation. Otherwise
   * a junction owner and the departing car can reserve each other's remaining path. */
  private maneuverGates(maneuver: readonly ManeuverFootprint[]): Set<number> {
    const gates = new Set<number>();

    for (const {pose, size} of maneuver) {
      const l = size.length / 2 + BUMPER_MARGIN;
      const w = size.width / 2 + SIDE_MARGIN;
      const ex = l * Math.abs(pose.dx) + w * Math.abs(pose.dz);
      const ez = l * Math.abs(pose.dz) + w * Math.abs(pose.dx);

      for (const box of this.options.junctions ?? []) {
        if (
          pose.x + ex > box.minX &&
          pose.x - ex < box.maxX &&
          pose.z + ez > box.minZ &&
          pose.z - ez < box.maxZ
        ) {
          gates.add(box.id);
        }
      }

      for (const [row, z] of this.roads.entries()) {
        if (Math.abs(pose.z - z) >= JUNCTION_HALF + ez) {
          continue;
        }

        for (const [column, x] of this.roads.entries()) {
          if (Math.abs(pose.x - x) < JUNCTION_HALF + ex) {
            gates.add(row * this.roads.length + column);
          }
        }
      }
    }

    return gates;
  }

  private clearsStoppedArrival(
    pose: LanePose,
    car: Vehicle,
    other: Vehicle,
  ): boolean {
    if (car.distance >= car.maneuverUntil || !other.stopped) {
      return false;
    }

    const x = other.pose.x - car.pose.x;
    const z = other.pose.z - car.pose.z;

    if (x * car.pose.dx + z * car.pose.dz >= 0) {
      return false;
    }

    const before = Math.hypot(x, z);
    const after = Math.hypot(other.pose.x - pose.x, other.pose.z - pose.z);
    const bodies =
      Math.hypot(car.size.length, car.size.width) / 2 +
      Math.hypot(other.size.length, other.size.width) / 2;

    // Old states may already violate the preferred bumper gap. Finish moving away
    // only when full bounding circles remain separate, regardless of body rotation.
    return after > before + 1e-8 && before > bodies + 0.1;
  }

  private occupied(
    pose: LanePose,
    car: Vehicle,
    size: VehicleSize = car.size,
    moving = false,
    current = car.pose,
  ): boolean {
    if (this.options.blocked?.(pose, current, size, car.size)) {
      return true;
    }

    const bounds = spatialBounds(pose, size);
    const candidates = new Set<Vehicle>();

    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const column = this.spatial.get(x);

      if (!column) {
        continue;
      }

      for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
        for (const other of column.get(z) ?? []) {
          candidates.add(other);
        }
      }
    }

    // Broad phase changes only candidates; exact footprints and stable IDs still decide occupancy.
    for (const other of [...candidates].sort((a, b) => a.id - b.id)) {
      if (
        other.id !== car.id &&
        overlaps(pose, size, other.pose, other.size) &&
        !(moving && this.clearsStoppedArrival(pose, car, other))
      ) {
        return true;
      }
    }

    // Future maneuver sweeps can span buckets beyond the vehicle's current body.
    for (const [id, sweeps] of this.maneuvers) {
      if (id === car.id) {
        continue;
      }

      const other = this.vehicles[id]!;

      if (
        other.active &&
        other.distance < other.maneuverUntil &&
        sweeps.some(
          sweep =>
            other.distance < sweep.until &&
            overlaps(pose, size, sweep.pose, sweep.size),
        )
      ) {
        return true;
      }
    }

    return (this.options.pedestrians?.() ?? []).some(p => {
      const x = p.x - pose.x;
      const z = p.z - pose.z;

      return (
        Math.abs(x * pose.dx + z * pose.dz) < size.length / 2 + 0.8 &&
        Math.abs(-x * pose.dz + z * pose.dx) < size.width / 2 + 0.5
      );
    });
  }

  private exitFree(car: Vehicle, gate: number, entryDistance: number): boolean {
    for (let ahead = 0.5; ahead <= 80; ahead += 0.5) {
      const exit = sampleLaneRoute(car.route, entryDistance + ahead);

      // A driveway can merge before a junction. Reserve the entire swept exit path,
      // otherwise a long truck can trap a waiting car behind its own reservation.
      if (this.occupied(exit, car)) {
        return false;
      }
      if (
        car.route.closed === false &&
        entryDistance + ahead >= car.route.length
      ) {
        return true;
      }
      if (
        junction(exit, car.size, this.options.junctions, this.roads) !== gate
      ) {
        // The footprint already includes its bumper gap. Reserving extra road beyond
        // a fully cleared exit can make two long trucks wait forever for each other.
        return true;
      }
    }

    return false;
  }

  private step(): void {
    for (const car of this.activeVehicles) {
      car.previous = car.distance;

      if (car.distance >= car.maneuverUntil) {
        this.maneuvers.delete(car.id);
        const current = junction(
          car.pose,
          car.size,
          this.options.junctions,
          this.roads,
        );

        for (const reserved of this.maneuverJunctions.get(car.id) ?? []) {
          if (reserved !== current && this.owners[reserved] === car.id) {
            this.owners[reserved] = -1;
          }
        }

        this.maneuverJunctions.delete(car.id);
      }

      const gate = this.held[car.id]!;

      if (
        gate >= 0 &&
        !this.maneuverJunctions.get(car.id)?.has(gate) &&
        junction(car.pose, car.size, this.options.junctions, this.roads) !==
          gate
      ) {
        this.owners[gate] = -1;
        this.held[car.id] = -1;
      }
    }

    // Clear cars already inside first, then let the longest-waiting approach take the next turn.
    this.order.length = 0;
    this.order.push(...this.activeVehicles);
    this.order.sort(
      (a, b) =>
        Number(this.held[b.id]! >= 0) - Number(this.held[a.id]! >= 0) ||
        b.waiting - a.waiting ||
        a.id - b.id,
    );

    for (const car of this.order) {
      if (car.stopped) {
        continue;
      }

      const exits = new Map<number, boolean>();
      const blocked = (ahead: number) => {
        const distance = car.distance + ahead;
        const pose = sampleLaneRoute(car.route, distance);

        if (this.occupied(pose, car, car.size, true)) {
          return true;
        }

        const gate = junction(
          pose,
          car.size,
          this.options.junctions,
          this.roads,
        );

        if (gate < 0 || this.owners[gate] === car.id) {
          return false;
        }
        if (this.owners[gate]! >= 0) {
          return true;
        }

        let clear = exits.get(gate);

        if (clear === undefined) {
          clear = this.exitFree(car, gate, distance);
          exits.set(gate, clear);
        }

        return !clear;
      };
      const horizon = Math.max(
        1.2,
        (car.speed * car.speed) / (2 * BRAKING) + 1.25,
      );
      let free = horizon;

      for (
        let ahead = PROBE_STEP;
        ahead <= horizon + PROBE_STEP;
        ahead += PROBE_STEP
      ) {
        if (blocked(ahead)) {
          free = Math.max(0, ahead - PROBE_STEP);
          break;
        }
      }

      const remaining = Math.max(0, car.stopDistance - car.distance);
      const desired = Math.min(
        SPEED,
        Math.sqrt(2 * BRAKING * Math.max(0, free - 0.1)),
        Math.sqrt(2 * BRAKING * remaining),
      );
      let speed =
        car.speed +
        Math.max(
          -BRAKING * STEP,
          Math.min(ACCELERATION * STEP, desired - car.speed),
        );
      let movement = Math.min(
        free,
        remaining,
        ((car.speed + speed) * STEP) / 2,
      );

      if (remaining < 0.002 && free >= remaining) {
        movement = remaining;
      }
      if (movement <= 1e-6 || blocked(movement)) {
        movement = 0;
        speed = 0;
      }

      car.distance += movement;
      car.speed = speed;
      car.waiting = movement < 0.005 ? car.waiting + STEP : 0;

      if (car.plan && car.stopDistance - car.distance < 1e-6) {
        car.stopped = true;
        car.speed = 0;
        car.waiting = 0;
      }

      car.pose = sampleLaneRoute(car.route, car.distance);
      this.updateSpatial(car);
      const gate = junction(
        car.pose,
        car.size,
        this.options.junctions,
        this.roads,
      );

      if (gate >= 0) {
        this.owners[gate] = car.id;
        this.held[car.id] = gate;
      }
    }

    this.tick++;
    this.options.onStep?.(this.tick * STEP, this);
  }
}
