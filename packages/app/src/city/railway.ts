import type {Point} from './life/types';
import type {LanePose} from './trafficRoutes';
import {nativePlacementTransform} from './nativeInfrastructurePlacement';
import type {
  NativeInfrastructurePlacement,
  NativePlacementTransform,
} from './nativeInfrastructurePlacement';
import type {RailwayCrossingLayout} from './railwayLayout';
import {
  RAILWAY_CROSSING_HALF_DEPTH,
  RAILWAY_CROSSING_HALF_WIDTH,
  RAILWAY_DWELL_SECONDS,
  RAILWAY_INTERVAL_SECONDS,
  RAILWAY_ROAD_CENTERS,
  RAILWAY_SPEED,
  RAILWAY_STATION_X,
  RAILWAY_TRACKS,
  RAILWAY_TRAIN_LENGTH,
  railwayCrossings,
} from './railwayLayout';

type TrainPhase = 'away' | 'arriving' | 'boarding' | 'leaving';
type CrossingState = 'open' | 'closing' | 'closed' | 'opening';
export interface RailwayTrain {
  serial: number;
  phase: TrainPhase;
  /** Centre of the complete consist, not the locomotive. */
  x: number;
  z: number;
  direction: 1 | -1;
  doorsOpen: boolean;
  passengers: number;
}
export interface RailwayCrossing extends RailwayCrossingLayout {
  id: number;
  x: number;
  z: number;
  openness: number;
  state: CrossingState;
  occupied: boolean;
}
export interface RailwaySnapshot {
  train: RailwayTrain;
  crossings: RailwayCrossing[];
}
export interface RailwayStatus {
  phase: TrainPhase;
  trains: number;
  arrivals: number;
  departures: number;
  nextInSeconds: number;
  passengers: number;
  crossingsClosed: number;
}
export interface RailwayOccupancy {
  vehicles: ReadonlyArray<
    LanePose & {length: number; width: number; id: number}
  >;
  walkers: readonly Point[];
}
export interface RailwaySave {
  enabled: boolean;
  seconds: number;
  origin: number;
  tick: number;
  nextVisit: number;
  dwellUntil: number;
  arrivals: number;
  departures: number;
  passengers: number;
  train: RailwayTrain;
  crossings: RailwayCrossing[];
}
interface Bounds {
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
}

const STEP = 0.05;
const GATE_SECONDS = 2.5;
const APPROACH_WARNING = 65;
// The 22 m train fits between adjacent crossing boxes with 0.5 m at each end.
const TRACK_CLEARANCE = 0.25;
const HALF_TRAIN = RAILWAY_TRAIN_LENGTH / 2;
const empty: RailwayOccupancy = {vehicles: [], walkers: []};
const groundLevel = (point: {y?: number}): boolean =>
  point.y === undefined || (point.y >= 0.5 && point.y < 2);
const footprint = (
  pose: LanePose,
  size: {length: number; width: number},
): Bounds => ({
  x: pose.x,
  z: pose.z,
  halfX: (Math.abs(pose.dx) * size.length + Math.abs(pose.dz) * size.width) / 2,
  halfZ: (Math.abs(pose.dz) * size.length + Math.abs(pose.dx) * size.width) / 2,
});
const intersects = (body: Bounds, crossing: RailwayCrossing): boolean =>
  Math.abs(body.x - crossing.x) <
    body.halfX + (crossing.halfWidth ?? RAILWAY_CROSSING_HALF_WIDTH) &&
  Math.abs(body.z - crossing.z) <
    body.halfZ + (crossing.halfDepth ?? RAILWAY_CROSSING_HALF_DEPTH);

function sweptIntersects(
  from: Bounds,
  to: Bounds,
  crossing: RailwayCrossing,
): boolean {
  const halfX =
    Math.max(from.halfX, to.halfX) +
    (crossing.halfWidth ?? RAILWAY_CROSSING_HALF_WIDTH);
  const halfZ =
    Math.max(from.halfZ, to.halfZ) +
    (crossing.halfDepth ?? RAILWAY_CROSSING_HALF_DEPTH);
  let entry = 0;
  let exit = 1;

  for (const [start, delta, centre, half] of [
    [from.x, to.x - from.x, crossing.x, halfX],
    [from.z, to.z - from.z, crossing.z, halfZ],
  ]) {
    if (delta === 0) {
      if (Math.abs(start! - centre!) >= half!) {
        return false;
      }
    } else {
      const a = (centre! - half! - start!) / delta!;
      const b = (centre! + half! - start!) / delta!;

      entry = Math.max(entry, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));

      if (entry > exit) {
        return false;
      }
    }
  }

  return entry <= exit;
}

/** Gates and trains share explicit simulation time and road-occupancy sensors. */
export class Railway {
  private enabled: boolean;
  private seconds = 0;
  private origin = 0;
  private tick = 0;
  private nextVisit = 5;
  private dwellUntil = 0;
  private arrivals = 0;
  private departures = 0;
  private passengers = 0;
  private train: RailwayTrain;
  private crossings: RailwayCrossing[];
  private readonly placement: NativePlacementTransform | undefined;
  private readonly west: number;
  private readonly east: number;

  constructor(
    startSeconds = 0,
    enabled = true,
    roads: readonly number[] = RAILWAY_ROAD_CENTERS,
    options: {
      placement?: NativeInfrastructurePlacement;
      crossings?: readonly RailwayCrossingLayout[];
      west?: number;
      east?: number;
    } = {},
  ) {
    this.enabled = enabled;
    this.placement = options.placement
      ? nativePlacementTransform(options.placement, {x: -34, z: -136})
      : undefined;
    this.west = options.west ?? Math.min(...roads, RAILWAY_STATION_X) - 45;
    this.east = options.east ?? Math.max(...roads, RAILWAY_STATION_X) + 45;
    this.train = {
      serial: 0,
      phase: 'away',
      x: this.west,
      z: RAILWAY_TRACKS[1],
      direction: 1,
      doorsOpen: false,
      passengers: 0,
    };
    this.crossings = (options.crossings ?? railwayCrossings(roads)).map(
      crossing => ({
        ...crossing,
        openness: 1,
        state: 'open',
        occupied: false,
      }),
    );
    this.reset(startSeconds);
  }

  advance(absoluteSeconds: number, occupancy: RailwayOccupancy = empty): void {
    if (
      !Number.isFinite(absoluteSeconds) ||
      absoluteSeconds + 1e-8 < this.seconds
    ) {
      throw new Error('Railway time must be finite and monotonic');
    }

    const placement = this.placement;

    if (placement) {
      occupancy = {
        vehicles: occupancy.vehicles.map(vehicle =>
          placement.localVector(placement.toLocal(vehicle)),
        ),
        walkers: occupancy.walkers.map(point => placement.toLocal(point)),
      };
    }

    const target = Math.floor((absoluteSeconds - this.origin + 1e-8) / STEP);

    while (this.tick < target) {
      this.tick++;
      this.seconds = this.origin + this.tick * STEP;
      this.step(occupancy);
    }
  }

  private step(occupancy: RailwayOccupancy): void {
    if (!this.enabled) {
      return;
    }
    if (this.train.phase === 'away' && this.seconds >= this.nextVisit) {
      const serial = this.train.serial + 1;
      const direction = serial % 2 === 1 ? 1 : -1;

      this.train = {
        serial,
        direction,
        phase: 'arriving',
        x: direction === 1 ? this.west : this.east,
        z: RAILWAY_TRACKS[direction === 1 ? 1 : 0],
        doorsOpen: false,
        passengers: 0,
      };
      this.nextVisit += RAILWAY_INTERVAL_SECONDS;
    }
    if (this.train.phase === 'boarding' && this.seconds >= this.dwellUntil) {
      this.train.phase = 'leaving';
      this.train.doorsOpen = false;
      this.departures++;
    }

    const moving =
      this.train.phase === 'arriving' || this.train.phase === 'leaving';

    for (const crossing of this.crossings) {
      crossing.occupied =
        occupancy.vehicles.some(
          car => groundLevel(car) && intersects(footprint(car, car), crossing),
        ) ||
        occupancy.walkers.some(
          person =>
            groundLevel(person) &&
            intersects({...person, halfX: 0.22, halfZ: 0.22}, crossing),
        );
      const ahead = (crossing.x - this.train.x) * this.train.direction;
      const close =
        this.train.phase !== 'away' &&
        ahead >=
          -HALF_TRAIN -
            (crossing.halfWidth ?? RAILWAY_CROSSING_HALF_WIDTH) -
            (moving ? TRACK_CLEARANCE : 0) &&
        ahead <=
          HALF_TRAIN +
            (crossing.halfWidth ?? RAILWAY_CROSSING_HALF_WIDTH) +
            (moving ? APPROACH_WARNING : 0);

      if (close) {
        // Red signals block new entrants immediately, but raised arms let existing occupants clear.
        crossing.openness = crossing.occupied
          ? 1
          : Math.max(0, crossing.openness - STEP / GATE_SECONDS);
        crossing.state = crossing.openness <= 1e-8 ? 'closed' : 'closing';

        if (crossing.state === 'closed') {
          crossing.openness = 0;
        }
      } else {
        crossing.openness = Math.min(
          1,
          crossing.openness + STEP / GATE_SECONDS,
        );
        crossing.state = crossing.openness >= 1 - 1e-8 ? 'open' : 'opening';

        if (crossing.state === 'open') {
          crossing.openness = 1;
        }
      }
    }

    if (!moving) {
      return;
    }

    const direction = this.train.direction;
    let travel = RAILWAY_SPEED * STEP;

    for (const crossing of this.crossings) {
      const distance = (crossing.x - this.train.x) * direction;

      // Only the front enters a crossing. Once admitted, the rear must keep clearing it.
      if (distance < 0 || (crossing.state === 'closed' && !crossing.occupied)) {
        continue;
      }

      const remaining =
        distance -
        HALF_TRAIN -
        (crossing.halfWidth ?? RAILWAY_CROSSING_HALF_WIDTH) -
        TRACK_CLEARANCE;

      if (remaining >= -1e-8) {
        travel = Math.min(travel, Math.max(0, remaining));
      }
    }

    if (this.train.phase === 'arriving') {
      travel = Math.min(
        travel,
        Math.max(0, (RAILWAY_STATION_X - this.train.x) * direction),
      );
    }

    this.train.x += travel * direction;

    if (
      this.train.phase === 'arriving' &&
      Math.abs(this.train.x - RAILWAY_STATION_X) < 1e-8
    ) {
      this.train.x = RAILWAY_STATION_X;
      this.train.phase = 'boarding';
      this.train.doorsOpen = true;
      this.dwellUntil = this.seconds + RAILWAY_DWELL_SECONDS;
      this.arrivals++;
    } else if (
      this.train.phase === 'leaving' &&
      (direction === 1 ? this.train.x >= this.east : this.train.x <= this.west)
    ) {
      this.train.phase = 'away';
      this.nextVisit = Math.max(this.nextVisit, this.seconds + 10);
    }
  }

  blocksVehicle(
    proposed: LanePose,
    current: LanePose,
    size: {length: number; width: number},
    currentSize: {length: number; width: number} = size,
  ): boolean {
    if (!this.enabled || !groundLevel(proposed) || !groundLevel(current)) {
      return false;
    }

    if (this.placement) {
      current = this.placement.localVector(this.placement.toLocal(current));
      proposed = this.placement.localVector(this.placement.toLocal(proposed));
    }

    const before = footprint(current, currentSize);
    const after = footprint(proposed, size);

    return this.crossings.some(
      crossing =>
        crossing.state !== 'open' &&
        !intersects(before, crossing) &&
        sweptIntersects(before, after, crossing),
    );
  }

  blocksWalker(proposed: Point, current: Point): boolean {
    if (!this.enabled || !groundLevel(proposed) || !groundLevel(current)) {
      return false;
    }

    if (this.placement) {
      current = this.placement.toLocal(current);
      proposed = this.placement.toLocal(proposed);
    }

    const before = {...current, halfX: 0.22, halfZ: 0.22};
    const after = {...proposed, halfX: 0.22, halfZ: 0.22};

    return this.crossings.some(
      crossing =>
        crossing.state !== 'open' &&
        !intersects(before, crossing) &&
        sweptIntersects(before, after, crossing),
    );
  }

  boardingSerial(): number | null {
    return this.train.phase === 'boarding' ? this.train.serial : null;
  }

  recordPassengers(count: number): void {
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      (this.train.phase !== 'arriving' && this.train.phase !== 'boarding')
    ) {
      throw new Error(
        'Passengers require an arriving train or a platform stop',
      );
    }

    this.train.passengers += count;
    this.passengers += count;
  }

  disembarkPassenger(): void {
    if (
      this.train.phase !== 'boarding' ||
      !this.train.doorsOpen ||
      this.train.passengers < 1
    ) {
      throw new Error(
        'Disembarking requires an onboard passenger and open doors at the platform',
      );
    }

    this.train.passengers--;
  }

  snapshot(): RailwaySnapshot {
    return {
      train: this.placement
        ? this.placement.toWorld({...this.train})
        : {...this.train},
      crossings: this.crossings.map(crossing =>
        this.placement ? this.placement.toWorld({...crossing}) : {...crossing},
      ),
    };
  }

  status(): RailwayStatus {
    return {
      phase: this.train.phase,
      trains: this.train.serial,
      arrivals: this.arrivals,
      departures: this.departures,
      nextInSeconds: Math.max(0, this.nextVisit - this.seconds),
      passengers: this.passengers,
      crossingsClosed: this.crossings.filter(
        crossing => crossing.state !== 'open',
      ).length,
    };
  }

  save(): RailwaySave {
    return {
      enabled: this.enabled,
      seconds: this.seconds,
      origin: this.origin,
      tick: this.tick,
      nextVisit: this.nextVisit,
      dwellUntil: this.dwellUntil,
      arrivals: this.arrivals,
      departures: this.departures,
      passengers: this.passengers,
      ...(this.placement
        ? {
            train: {...this.train},
            crossings: this.crossings.map(crossing => ({...crossing})),
          }
        : this.snapshot()),
    };
  }

  restore(saved: RailwaySave): void {
    const data = structuredClone(saved);

    this.enabled = data.enabled;
    this.seconds = data.seconds;
    this.origin = data.origin;
    this.tick = data.tick;
    this.nextVisit = data.nextVisit;
    this.dwellUntil = data.dwellUntil;
    this.arrivals = data.arrivals;
    this.departures = data.departures;
    this.passengers = data.passengers;
    this.train = data.train;
    this.crossings = data.crossings;
  }

  reset(seconds = 0): void {
    this.seconds = seconds;
    this.origin = seconds;
    this.tick = 0;
    this.nextVisit = seconds + 5;
    this.dwellUntil = seconds;
    this.arrivals = 0;
    this.departures = 0;
    this.passengers = 0;
    this.train = {
      serial: 0,
      phase: 'away',
      x: this.west,
      z: RAILWAY_TRACKS[1],
      direction: 1,
      doorsOpen: false,
      passengers: 0,
    };
    this.crossings = this.crossings.map(crossing => ({
      ...crossing,
      openness: 1,
      state: 'open',
      occupied: false,
    }));
  }
}
