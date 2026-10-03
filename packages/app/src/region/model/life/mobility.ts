import {CityTraffic} from '../../../city/trafficFlow';
import {sampleLaneRoute} from '../../../city/trafficRoutes';
import type {Point} from '../types';
import {LIFE_RULES} from './rules';
import {
  RegionalRoutes,
  parkingPoint,
  parkingWalkPoints,
  polylineLane,
  resolvePlace,
} from './routes';
import type {
  MutableRegion,
  RegionalCar,
  RegionalRoute,
  RegionalTrip,
  RegionMobilityPort,
  TravelMode,
  TripRequest,
} from './types';

const PHYSICAL_STEP = 0.05;
const CAR_SIZE = {length: 4.2, width: 1.8};
const TRUCK_SIZE = {length: 6.5, width: 2.3};

export class RegionMobility implements RegionMobilityPort {
  private readonly routes: RegionalRoutes;
  private readonly traffic: CityTraffic;
  private time: number;
  private revision = -1;
  private readonly arrivalLimits = new Map<number, number>();
  private trafficCapacity: number;

  constructor(private readonly draft: MutableRegion) {
    this.routes = new RegionalRoutes(draft);
    const junctions = this.routes.junctions();
    // Existing reservations may reference a now-closing road; retain their slots.
    const capacity = draft.life.junctionKeys.length;

    if (capacity && !junctions.some(j => j.id === capacity - 1)) {
      junctions.push({
        id: capacity - 1,
        minX: Infinity,
        maxX: Infinity,
        minZ: Infinity,
        maxZ: Infinity,
      });
    }

    this.traffic = new CityTraffic([], {
      roads: [],
      junctions,
      pedestrians: () => this.pedestrians(),
      pedestrianRadius: 0.3,
      travelLimit: id => this.arrivalLimits.get(id) ?? Infinity,
    });

    if (draft.life.traffic) {
      this.traffic.restore(draft.life.traffic);
    }

    this.time = draft.life.traffic?.lastTime ?? 0;
    this.trafficCapacity = draft.life.traffic?.vehicles.length ?? 0;
  }

  route(fromId: string, toId: string, mode: TravelMode): RegionalRoute | null {
    return this.routes.route(fromId, toId, mode);
  }

  createCar(familyId: string, entryId: string): RegionalCar | null {
    const family = this.draft.life.families.find(f => f.id === familyId);
    const entry = resolvePlace(this.draft, entryId);

    if (
      !family ||
      family.carId ||
      !entry?.entry ||
      this.draft.life.cars.some(c => c.parkedAt === entryId)
    ) {
      return null;
    }

    const car: RegionalCar = {
      id: `car-${this.draft.life.nextId++}`,
      familyId,
      driverId: null,
      parkedAt: entryId,
      parkingSlot: 0,
      tripId: null,
      trafficIndex: this.traffic.addCar(CAR_SIZE, {
        ...entry.road,
        dx: 1,
        dz: 0,
      }),
    };

    this.trafficCapacity++;
    this.draft.life.cars.push(car);
    family.carId = car.id;

    return car;
  }

  start(request: TripRequest): RegionalTrip | null {
    if (
      this.draft.life.trips.some(
        t =>
          t.actorId === request.actorId ||
          t.passengerIds.includes(request.actorId),
      )
    ) {
      return null;
    }

    const route = this.route(request.fromId, request.toId, request.mode);
    const from = resolvePlace(this.draft, request.fromId);
    const to = resolvePlace(this.draft, request.toId);

    if (!route || !from || !to || route.lane.length <= 0) {
      return null;
    }

    const car =
      request.mode === 'car'
        ? this.draft.life.cars.find(c => c.id === request.vehicleId)
        : undefined;

    if (
      request.mode === 'car' &&
      (!car ||
        car.parkedAt !== request.fromId ||
        car.driverId !== null ||
        car.tripId !== null)
    ) {
      return null;
    }
    if (
      from.entry &&
      this.draft.life.cars.some(
        c => c.parkedAt === request.fromId && c.id !== car?.id,
      )
    ) {
      return null;
    }

    if (car) {
      const family = this.draft.life.families.find(f => f.id === car.familyId);

      if (!family?.memberIds.includes(request.actorId)) {
        return null;
      }
    }

    const parkingSlot =
      request.mode === 'walk' || to.entry
        ? null
        : this.availableSlot(request.toId, request.mode);

    if (request.mode !== 'walk' && !to.entry && parkingSlot === null) {
      return null;
    }

    const trafficIndex =
      request.mode === 'walk'
        ? null
        : (car?.trafficIndex ?? this.reusableTruck());
    const trip: RegionalTrip = {
      id: `trip-${this.draft.life.nextId++}`,
      actorId: request.actorId,
      passengerIds: [...(request.passengerIds ?? [])],
      vehicleId: car?.id ?? null,
      trafficIndex,
      fromId: request.fromId,
      toId: request.toId,
      mode: request.mode,
      purpose: request.purpose,
      route: structuredClone(route),
      distance: 0,
      pose: sampleLaneRoute(route.lane, 0),
      startedAt: this.draft.life.elapsedSeconds,
      waitingSeconds: 0,
      parkingSlot,
      phase: 'travel',
    };

    if (trafficIndex !== null) {
      const origin = from.entry
        ? sampleLaneRoute(route.lane, 0)
        : parkingPoint(from, car?.parkingSlot ?? from.parking);
      const destination = to.entry
        ? sampleLaneRoute(route.lane, route.lane.length)
        : parkingPoint(to, parkingSlot!);
      const first = sampleLaneRoute(route.lane, 0);
      const last = sampleLaneRoute(route.lane, route.lane.length);
      const prefix = polylineLane([origin, first]);
      const suffix = polylineLane([last, destination]);

      trip.route.lane = {
        direction: 1,
        closed: false,
        segments: [
          ...prefix.segments,
          ...route.lane.segments,
          ...suffix.segments,
        ],
        length: prefix.length + route.lane.length + suffix.length,
      };
      trip.pose = sampleLaneRoute(trip.route.lane, 0);

      if (car && !from.entry) {
        trip.approach = {
          lane: polylineLane(parkingWalkPoints(from, car.parkingSlot ?? 0)),
          distance: 0,
        };
        trip.phase = 'approach';
        trip.pose = sampleLaneRoute(trip.approach.lane, 0);
      } else if (
        !this.traffic.beginTrip(
          trafficIndex,
          trip.route.lane,
          prefix.length + (car ? CAR_SIZE.length : TRUCK_SIZE.length) + 1,
        )
      ) {
        return null;
      }
      if (car && !to.entry) {
        trip.exit = {
          lane: polylineLane(parkingWalkPoints(to, parkingSlot!).reverse()),
          distance: 0,
        };
      }
    }
    if (car) {
      car.tripId = trip.id;
      car.driverId = request.actorId;

      if (trip.phase === 'travel') {
        car.parkedAt = null;
        car.parkingSlot = null;
      }
    }

    this.draft.life.trips.push(trip);

    return trip;
  }

  step(seconds: number): RegionalTrip[] {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error('Invalid mobility duration');
    }
    if (this.revision !== this.draft.roadRevision) {
      this.traffic.setJunctions(this.routes.junctions());
      this.revision = this.draft.roadRevision;
    }

    const completed: RegionalTrip[] = [];
    const target = this.time + seconds;

    // Match CityTraffic's exact physical lattice. Root feeds whole game seconds.
    while (this.time < target - 1e-8) {
      if (this.draft.life.trips.length === 0) {
        this.time = target;
        this.traffic.update(target);
        break;
      }

      const dt = Math.min(PHYSICAL_STEP, target - this.time);

      this.time = Math.round((this.time + dt) * 1e9) / 1e9;

      this.prepareArrivals();

      for (const trip of this.draft.life.trips) {
        this.stepWalker(trip, dt);
      }

      this.prepareArrivals();
      this.traffic.update(this.time);

      for (const trip of this.draft.life.trips) {
        if (
          trip.phase !== 'travel' ||
          trip.mode === 'walk' ||
          trip.trafficIndex === null
        ) {
          continue;
        }

        const previous = trip.distance;

        trip.distance = this.traffic.progress(trip.trafficIndex);
        trip.pose = {...this.traffic.pose(trip.trafficIndex)};
        trip.waitingSeconds =
          trip.distance <= previous ? trip.waitingSeconds + dt : 0;

        if (this.traffic.atStop(trip.trafficIndex) === 1) {
          this.traffic.park(trip.trafficIndex);
          const car = this.draft.life.cars.find(c => c.id === trip.vehicleId);

          if (car) {
            car.parkedAt = trip.toId;
            car.parkingSlot = trip.parkingSlot;
          }
          if (trip.exit && trip.exit.lane.length > 0) {
            trip.phase = 'exit';
            trip.pose = sampleLaneRoute(trip.exit.lane, 0);
          }
        }
      }

      const finished = this.draft.life.trips.filter(trip =>
        this.finished(trip),
      );

      for (const trip of finished) {
        const car = this.draft.life.cars.find(c => c.id === trip.vehicleId);

        if (car) {
          car.tripId = null;
          car.driverId = null;
        }

        completed.push(trip);
      }

      if (finished.length) {
        const ids = new Set(finished.map(t => t.id));

        this.draft.life.trips = this.draft.life.trips.filter(
          t => !ids.has(t.id),
        );
      }
    }

    return completed;
  }

  save(): void {
    this.draft.life.traffic = this.traffic.save();
  }

  private prepareArrivals(): void {
    this.arrivalLimits.clear();

    for (const trip of this.draft.life.trips) {
      if (
        trip.phase !== 'travel' ||
        trip.trafficIndex === null ||
        trip.parkingSlot === null
      ) {
        continue;
      }

      const size = trip.mode === 'truck' ? TRUCK_SIZE : CAR_SIZE;
      const tail = trip.route.lane.segments.at(-1)!;
      const from = Math.max(
        0,
        trip.route.lane.length - tail.length - size.length - 1,
      );

      if (
        trip.distance >= from - size.length - 1 &&
        !this.traffic.reserveManeuver(
          trip.trafficIndex,
          Math.max(from, trip.distance),
          trip.route.lane.length,
        )
      ) {
        // This is a stop line, not the trip's destination. A refused maneuver
        // must not let the vehicle creep into the conflict one step at a time.
        this.arrivalLimits.set(
          trip.trafficIndex,
          Math.max(from, trip.distance),
        );
      }
    }
  }

  private pedestrians(): Point[] {
    return this.draft.life.trips
      .filter(
        t =>
          t.mode === 'walk' ||
          t.phase === 'exit' ||
          (t.phase === 'approach' &&
            !!t.approach &&
            t.approach.distance < t.approach.lane.length),
      )
      .map(t => t.pose);
  }

  private availableSlot(placeId: string, mode: TravelMode): number | null {
    const place = resolvePlace(this.draft, placeId);

    if (!place) {
      return null;
    }

    const slots =
      mode === 'truck'
        ? [place.parking]
        : Array.from({length: place.parking}, (_, i) => i);

    return (
      slots.find(
        slot =>
          !this.draft.life.cars.some(
            c => c.parkedAt === placeId && c.parkingSlot === slot,
          ) &&
          !this.draft.life.trips.some(
            t => t.toId === placeId && t.parkingSlot === slot,
          ),
      ) ?? null
    );
  }

  private reusableTruck(): number {
    // Reuse retired delivery slots; lifetime delivery count must not grow traffic capacity.
    const reserved = new Set([
      ...this.draft.life.cars.map(c => c.trafficIndex),
      ...this.draft.life.trips.flatMap(t =>
        t.trafficIndex === null ? [] : [t.trafficIndex],
      ),
    ]);
    const count = this.trafficCapacity;

    for (let i = 0; i < count; i++) {
      if (!reserved.has(i) && !this.traffic.isActive(i)) {
        return i;
      }
    }

    this.trafficCapacity++;

    return this.traffic.addCar(TRUCK_SIZE);
  }

  private stepWalker(trip: RegionalTrip, seconds: number): void {
    const walk =
      trip.phase === 'approach'
        ? trip.approach
        : trip.phase === 'exit'
          ? trip.exit
          : trip.mode === 'walk'
            ? trip
            : null;

    if (!walk) {
      return;
    }

    const lane = 'lane' in walk ? walk.lane : trip.route.lane;
    const next = Math.min(
      lane.length,
      walk.distance + (seconds * LIFE_RULES.walkMetersPerMinute) / 60,
    );
    const pose = sampleLaneRoute(lane, next);
    // A reserved driveway must be clear before the vehicle enters it; walking
    // into only its future sweep would otherwise make both actors yield forever.
    const occupied =
      this.traffic.pedestrianBlocked(pose) ||
      (trip.waitingSeconds > 0 && this.traffic.pedestrianConflict(trip.pose));

    if (!occupied) {
      walk.distance = next;
      trip.pose = pose;
      trip.waitingSeconds = 0;
    } else {
      trip.waitingSeconds += seconds;

      // An existing conflict must clear in whichever direction has real space.
      // Always retreating can push a person at a front corner into the vehicle.
      if (this.traffic.pedestrianConflict(trip.pose)) {
        const previous = Math.max(
          0,
          walk.distance - (seconds * LIFE_RULES.walkMetersPerMinute) / 60,
        );
        const choices = [next, previous]
          .map(distance => ({distance, pose: sampleLaneRoute(lane, distance)}))
          .filter(choice => !this.traffic.pedestrianBlocked(choice.pose, false))
          .sort(
            (a, b) =>
              this.traffic.pedestrianClearance(b.pose) -
              this.traffic.pedestrianClearance(a.pose),
          );
        const clear = choices[0];

        if (clear) {
          walk.distance = clear.distance;
          trip.pose = clear.pose;
        }
      }
    }
    if (
      trip.phase === 'approach' &&
      walk.distance >= lane.length &&
      trip.trafficIndex !== null
    ) {
      if (
        this.traffic.beginTrip(
          trip.trafficIndex,
          trip.route.lane,
          (trip.route.lane.segments[0]?.length ?? 0) + CAR_SIZE.length + 1,
        )
      ) {
        trip.phase = 'travel';
        const car = this.draft.life.cars.find(c => c.id === trip.vehicleId);

        if (car) {
          car.parkedAt = null;
          car.parkingSlot = null;
        }
      }
    }
  }

  private finished(trip: RegionalTrip): boolean {
    if (trip.phase === 'approach') {
      return false;
    }
    if (trip.phase === 'exit') {
      return !!trip.exit && trip.exit.distance >= trip.exit.lane.length;
    }
    if (trip.mode === 'walk') {
      return trip.distance >= trip.route.lane.length;
    }

    return (
      trip.trafficIndex !== null &&
      this.traffic.atStop(trip.trafficIndex) === 1 &&
      !this.traffic.isActive(trip.trafficIndex)
    );
  }
}
