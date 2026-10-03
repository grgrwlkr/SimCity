import {z} from 'zod';
import {
  sampleLaneRoute,
  type LaneRoute,
  type LanePose,
} from '../../../city/trafficRoutes';
import type {RegionState} from '../types';
import type {RegionalLifeState} from './types';

const finite = z.number().finite();
const amount = finite.nonnegative();
const count = amount.int().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(128);
const point = z.object({x: finite, z: finite}).strict();
const pose = z
  .object({x: finite, z: finite, dx: finite, dz: finite, y: finite.optional()})
  .strict()
  .transform(({y, ...value}) => ({...value, ...(y === undefined ? {} : {y})}));
const line = z
  .object({
    kind: z.literal('line'),
    x: finite,
    z: finite,
    dx: finite,
    dz: finite,
    length: amount.positive(),
    backwards: z.boolean().optional(),
    y: finite.optional(),
    endY: finite.optional(),
  })
  .strict()
  .transform(({backwards, y, endY, ...value}) => ({
    ...value,
    ...(backwards === undefined ? {} : {backwards}),
    ...(y === undefined ? {} : {y}),
    ...(endY === undefined ? {} : {endY}),
  }));
const arc = z
  .object({
    kind: z.literal('arc'),
    x: finite,
    z: finite,
    radius: amount.positive(),
    angle: finite,
    length: amount.positive(),
    turn: z.union([z.literal(1), z.literal(-1)]).optional(),
    backwards: z.boolean().optional(),
  })
  .strict()
  .transform(({turn, backwards, ...value}) => ({
    ...value,
    ...(turn === undefined ? {} : {turn}),
    ...(backwards === undefined ? {} : {backwards}),
  }));
const lane = z
  .object({
    direction: z.union([z.literal(1), z.literal(-1)]),
    length: amount,
    segments: z.array(z.union([line, arc])),
    closed: z.boolean().optional(),
  })
  .strict()
  .transform(({closed, ...value}) => ({
    ...value,
    ...(closed === undefined ? {} : {closed}),
  }));
const plan = z
  .object({route: lane, stops: z.array(amount), initialStop: count})
  .strict();
const traffic = z
  .object({
    tick: count,
    lastTime: amount,
    owners: z.array(count.or(z.literal(-1))),
    held: z.array(count.or(z.literal(-1))),
    vehicles: z.array(
      z
        .object({
          id: count,
          size: z
            .object({length: amount.positive(), width: amount.positive()})
            .strict(),
          route: lane,
          start: amount,
          distance: amount,
          previous: amount,
          speed: amount,
          waiting: amount,
          pose,
          plan: plan.optional(),
          stopIndex: count.or(z.literal(-1)),
          stopDistance: amount.nullable(),
          stopped: z.boolean(),
          active: z.boolean(),
          dormant: z.boolean(),
          maneuverUntil: amount,
          maneuverFrom: amount.optional(),
        })
        .strict()
        .transform(({maneuverFrom, ...value}) => ({
          ...value,
          plan: value.plan,
          ...(maneuverFrom === undefined ? {} : {maneuverFrom}),
        })),
    ),
  })
  .strict();
const leg = z.object({lane, distance: amount}).strict();
const trip = z
  .object({
    id,
    actorId: id,
    passengerIds: z.array(id),
    vehicleId: id.nullable(),
    trafficIndex: count.nullable(),
    fromId: id,
    toId: id,
    mode: z.enum(['car', 'walk', 'truck']),
    purpose: z.enum(['arrival', 'work', 'home', 'shop', 'delivery', 'leisure']),
    phase: z.enum(['approach', 'travel', 'exit']),
    approach: leg.optional(),
    exit: leg.optional(),
    route: z
      .object({
        lane,
        roadIds: z.array(id),
        roadRevision: count,
        crossings: z.array(z.object({from: point, to: point}).strict()),
      })
      .strict(),
    distance: amount,
    pose,
    startedAt: amount,
    waitingSeconds: amount,
    parkingSlot: count.nullable(),
  })
  .strict()
  .transform(({approach, exit, ...value}) => ({
    ...value,
    ...(approach === undefined ? {} : {approach}),
    ...(exit === undefined ? {} : {exit}),
  }));

export const regionalLifeSchema = z
  .object({
    elapsedSeconds: count,
    remainderSeconds: amount.lt(1),
    initialized: z.boolean(),
    nextId: count.positive(),
    families: z.array(
      z
        .object({
          id,
          finance: z
            .object({
              sinceSeconds: amount,
              construction: amount,
              goods: amount,
              travel: amount,
              wages: amount,
            })
            .strict()
            .optional(),
          memberIds: z.array(id).min(1),
          cash: amount,
          homeId: id.nullable(),
          status: z.enum(['waiting', 'arriving', 'settled']),
          availableAt: amount,
          carId: id.nullable(),
          goods: amount,
          lastShopDay: count.or(z.literal(-1)),
          reason: z.string().nullable(),
        })
        .strict()
        .transform(({finance, ...value}) => ({
          ...value,
          ...(finance === undefined ? {} : {finance}),
        })),
    ),
    people: z.array(
      z
        .object({
          id,
          familyId: id,
          name: z.string(),
          age: count,
          qualification: count,
          jobId: id.nullable(),
          placeId: id.nullable(),
          tripId: id.nullable(),
          activity: z.enum([
            'outside',
            'home',
            'work',
            'shopping',
            'walking',
            'driving',
            'passenger',
            'waiting',
          ]),
          reason: z.string().nullable(),
          workedSeconds: amount,
          wageSeconds: amount,
        })
        .strict(),
    ),
    investors: z.array(z.object({id, cash: amount}).strict()),
    buildings: z.array(
      z
        .object({
          id,
          lotId: id,
          settlementId: id,
          kind: z.enum([
            'residential',
            'commercial',
            'industrial',
            'warehouse',
          ]),
          ownerId: id,
          stage: z.enum(['constructing', 'ready']),
          startedAt: amount,
          progressSeconds: amount,
          durationSeconds: amount.positive(),
          capacity: count,
          jobs: count,
          qualification: count,
          parking: count,
          inventory: amount,
          inventoryCapacity: amount,
          cash: amount,
          productionWork: amount,
        })
        .strict(),
    ),
    cars: z.array(
      z
        .object({
          id,
          familyId: id,
          driverId: id.nullable(),
          parkedAt: id.nullable(),
          parkingSlot: count.nullable(),
          tripId: id.nullable(),
          trafficIndex: count,
        })
        .strict(),
    ),
    trips: z.array(trip),
    deliveries: z.array(
      z
        .object({
          id,
          sourceId: id.nullable(),
          targetId: id,
          quantity: amount.positive(),
          cargo: amount,
          state: z.enum([
            'waiting',
            'loading',
            'in-transit',
            'unloading',
            'delivered',
          ]),
          tripId: id.nullable(),
          phaseSeconds: amount,
          unitPrice: amount,
          reason: z.string().nullable(),
        })
        .strict(),
    ),
    economy: z
      .object({
        initialMoney: amount,
        initialGoods: amount,
        externalMoney: amount,
        externalGoods: amount,
        produced: amount,
        consumed: amount,
        taxesPaid: amount,
        maintenancePaid: amount,
        constructionPaid: amount,
        wagesPaid: amount,
        salesValue: amount,
        importsPaid: amount,
        maintenanceDebt: amount,
      })
      .strict(),
    traffic: traffic.nullable(),
    junctionKeys: z.array(id),
    closingRoadIds: z.array(id),
    completedTrips: count,
    completedDeliveries: count,
  })
  .strict();

function fail(): never {
  throw new Error('Повреждённые связи симуляции региона');
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validLane(route: LaneRoute): boolean {
  const length = route.segments.reduce(
    (sum, segment) => sum + segment.length,
    0,
  );

  return (
    Math.abs(length - route.length) < 0.001 &&
    route.segments.every(
      segment =>
        segment.kind !== 'line' ||
        Math.abs(Math.hypot(segment.dx, segment.dz) - 1) < 0.001,
    )
  );
}

function matchesPose(actual: LanePose, expected: LanePose): boolean {
  return (
    Math.hypot(actual.x - expected.x, actual.z - expected.z) < 0.01 &&
    Math.hypot(actual.dx - expected.dx, actual.dz - expected.dz) < 0.001 &&
    Math.abs((actual.y ?? 0) - (expected.y ?? 0)) < 0.01
  );
}

/** Cross references are checked only after the complete structural parse succeeds. */
export function validateRegionalLife(state: RegionState): void {
  const life: RegionalLifeState = state.life;
  const families = new Map(life.families.map(value => [value.id, value]));
  const people = new Map(life.people.map(value => [value.id, value]));
  const buildings = new Map(life.buildings.map(value => [value.id, value]));
  const cars = new Map(life.cars.map(value => [value.id, value]));
  const trips = new Map(life.trips.map(value => [value.id, value]));
  const deliveries = new Map(life.deliveries.map(value => [value.id, value]));
  const investors = new Set(life.investors.map(value => value.id));
  const roads = new Set(state.roads.map(value => value.id));
  const entries = new Set(state.externalEntries.map(value => value.id));
  const entities = [
    ...life.families,
    ...life.people,
    ...life.buildings,
    ...life.cars,
    ...life.trips,
    ...life.deliveries,
    ...life.investors,
  ];
  const lots = new Map(
    [...state.parcels, ...state.warehouses].map(value => [value.id, value]),
  );
  const placeExists = (value: string) =>
    buildings.has(value) || entries.has(value);

  if (
    (!life.initialized && entities.length > 0) ||
    !unique(entities.map(value => value.id)) ||
    !unique(life.buildings.map(value => value.lotId)) ||
    [...life.buildings, ...life.trips, ...life.deliveries, ...life.cars].some(
      value => {
        const counter = Number(value.id.split('-').at(-1));

        return (
          !Number.isSafeInteger(counter) ||
          counter < 1 ||
          counter >= life.nextId
        );
      },
    ) ||
    !unique(life.junctionKeys) ||
    !unique(life.closingRoadIds) ||
    life.closingRoadIds.some(value => !roads.has(value))
  ) {
    fail();
  }

  for (const building of life.buildings) {
    const lot = lots.get(building.lotId);

    if (
      !lot ||
      lot.settlementId !== building.settlementId ||
      !state.settlements.some(value => value.id === building.settlementId) ||
      (building.kind === 'warehouse'
        ? !state.warehouses.some(value => value.id === lot.id)
        : !state.parcels.some(value => value.id === lot.id)) ||
      (building.kind === 'warehouse'
        ? building.ownerId !== 'region' || building.cash !== 0
        : building.kind === 'residential'
          ? !families.has(building.ownerId)
          : !investors.has(building.ownerId)) ||
      building.inventory > building.inventoryCapacity ||
      building.progressSeconds > building.durationSeconds ||
      (building.stage === 'ready' &&
        building.progressSeconds < building.durationSeconds) ||
      building.startedAt > life.elapsedSeconds
    ) {
      fail();
    }
  }

  for (const family of life.families) {
    const home = family.homeId === null ? null : buildings.get(family.homeId);
    const car = family.carId === null ? null : cars.get(family.carId);

    if (
      !unique(family.memberIds) ||
      family.memberIds.some(
        value => people.get(value)?.familyId !== family.id,
      ) ||
      (family.homeId !== null && home?.kind !== 'residential') ||
      (family.carId !== null && car?.familyId !== family.id) ||
      (family.status !== 'waiting' && home?.stage !== 'ready')
    ) {
      fail();
    }
  }

  for (const person of life.people) {
    const family = families.get(person.familyId);
    const job = person.jobId === null ? null : buildings.get(person.jobId);
    const active = person.tripId === null ? null : trips.get(person.tripId);

    if (
      !family?.memberIds.includes(person.id) ||
      (person.jobId !== null &&
        (!job ||
          job.stage !== 'ready' ||
          job.jobs === 0 ||
          person.qualification < job.qualification)) ||
      (person.placeId !== null && !placeExists(person.placeId)) ||
      (person.tripId !== null &&
        (!active ||
          (active.actorId !== person.id &&
            !active.passengerIds.includes(person.id))))
    ) {
      fail();
    }
  }

  const parking = new Set<string>();
  const trafficIndices = new Set<number>();

  for (const car of life.cars) {
    const family = families.get(car.familyId);
    const parked = car.parkedAt === null ? null : buildings.get(car.parkedAt);
    const active = car.tripId === null ? null : trips.get(car.tripId);

    if (
      family?.carId !== car.id ||
      (car.driverId !== null &&
        people.get(car.driverId)?.familyId !== car.familyId) ||
      (car.tripId !== null && active?.vehicleId !== car.id) ||
      (car.parkedAt !== null &&
        !entries.has(car.parkedAt) &&
        (!parked ||
          car.parkingSlot === null ||
          car.parkingSlot >= parked.parking)) ||
      (car.parkedAt === null && car.parkingSlot !== null) ||
      trafficIndices.has(car.trafficIndex) ||
      !life.traffic?.vehicles[car.trafficIndex]
    ) {
      fail();
    }

    trafficIndices.add(car.trafficIndex);

    if (car.parkedAt !== null && !entries.has(car.parkedAt)) {
      const key = `${car.parkedAt}:${car.parkingSlot}`;

      if (parking.has(key)) {
        fail();
      }

      parking.add(key);
    }
  }

  for (const building of life.buildings) {
    const occupants = life.families
      .filter(
        value => value.homeId === building.id && value.status !== 'waiting',
      )
      .reduce((sum, value) => sum + value.memberIds.length, 0);
    const employees = life.people.filter(
      value => value.jobId === building.id,
    ).length;

    if (occupants > building.capacity || employees > building.jobs) {
      fail();
    }
  }

  const tripTraffic = new Set<number>();

  for (const active of life.trips) {
    const delivery = deliveries.get(active.actorId);
    const person = people.get(active.actorId);

    if (
      !placeExists(active.fromId) ||
      !placeExists(active.toId) ||
      (!person && !delivery) ||
      (person && person.tripId !== active.id) ||
      (delivery && delivery.tripId !== active.id) ||
      !unique(active.passengerIds) ||
      active.passengerIds.some(
        value => people.get(value)?.tripId !== active.id,
      ) ||
      active.route.roadIds.some(value => !roads.has(value)) ||
      active.route.roadRevision > state.roadRevision ||
      !validLane(active.route.lane) ||
      active.route.lane.length <= 0 ||
      active.distance > active.route.lane.length + 0.001 ||
      active.startedAt > life.elapsedSeconds ||
      (active.approach &&
        (!validLane(active.approach.lane) ||
          active.approach.distance > active.approach.lane.length + 0.001)) ||
      (active.exit &&
        (!validLane(active.exit.lane) ||
          active.exit.distance > active.exit.lane.length + 0.001)) ||
      (active.phase === 'approach' && !active.approach) ||
      (active.phase === 'exit' && !active.exit)
    ) {
      fail();
    }

    const leg =
      active.phase === 'approach'
        ? active.approach
        : active.phase === 'exit'
          ? active.exit
          : undefined;
    const currentLane = leg?.lane ?? active.route.lane;
    const currentDistance = leg?.distance ?? active.distance;

    if (
      currentLane.length <= 0 ||
      !matchesPose(active.pose, sampleLaneRoute(currentLane, currentDistance))
    ) {
      fail();
    }

    if (active.mode === 'walk') {
      if (
        active.vehicleId !== null ||
        active.trafficIndex !== null ||
        active.parkingSlot !== null
      ) {
        fail();
      }
    } else if (
      active.trafficIndex === null ||
      !life.traffic?.vehicles[active.trafficIndex] ||
      (active.mode === 'car' &&
        (active.vehicleId === null ||
          cars.get(active.vehicleId)?.tripId !== active.id))
    ) {
      fail();
    }
    if (
      active.mode === 'truck' &&
      (active.vehicleId !== null || !delivery || active.purpose !== 'delivery')
    ) {
      fail();
    }
    if (active.trafficIndex !== null) {
      const vehicle = life.traffic!.vehicles[active.trafficIndex]!;
      const car =
        active.vehicleId === null ? undefined : cars.get(active.vehicleId);

      if (
        tripTraffic.has(active.trafficIndex) ||
        (car &&
          (car.trafficIndex !== active.trafficIndex ||
            car.driverId !== active.actorId)) ||
        (active.mode === 'truck' && trafficIndices.has(active.trafficIndex)) ||
        (active.phase === 'travel' &&
          (!vehicle.active ||
            !matchesPose(active.pose, vehicle.pose) ||
            Math.abs(active.distance - vehicle.distance) > 0.01))
      ) {
        fail();
      }

      tripTraffic.add(active.trafficIndex);
    }
    if (active.parkingSlot !== null) {
      const target = buildings.get(active.toId);
      const key = `${active.toId}:${active.parkingSlot}`;

      const ownParkedCar =
        active.vehicleId === null ? undefined : cars.get(active.vehicleId);
      const alreadyParked =
        active.phase === 'exit' &&
        ownParkedCar?.parkedAt === active.toId &&
        ownParkedCar.parkingSlot === active.parkingSlot;

      if (
        !target ||
        (active.mode === 'truck'
          ? active.parkingSlot !== target.parking
          : active.parkingSlot >= target.parking) ||
        (parking.has(key) && !alreadyParked)
      ) {
        fail();
      }

      parking.add(key);
    }
  }

  for (const delivery of life.deliveries) {
    if (
      (delivery.sourceId !== null && !placeExists(delivery.sourceId)) ||
      !buildings.has(delivery.targetId) ||
      delivery.cargo > delivery.quantity ||
      (delivery.tripId !== null &&
        trips.get(delivery.tripId)?.actorId !== delivery.id) ||
      (delivery.state === 'in-transit' && delivery.tripId === null)
    ) {
      fail();
    }
  }

  if (life.traffic) {
    const data = life.traffic;

    if (
      data.held.length !== data.vehicles.length ||
      data.owners.length < life.junctionKeys.length ||
      data.owners.some(
        value =>
          value >= data.vehicles.length ||
          (value >= 0 && !data.vehicles[value]!.active),
      ) ||
      data.held.some(value => value >= data.owners.length)
    ) {
      fail();
    }

    for (const [index, vehicle] of data.vehicles.entries()) {
      if (
        vehicle.id !== index ||
        !validLane(vehicle.route) ||
        vehicle.route.length <= 0 ||
        vehicle.previous > vehicle.distance ||
        (vehicle.maneuverFrom !== undefined &&
          (vehicle.maneuverFrom > vehicle.maneuverUntil ||
            vehicle.maneuverUntil > vehicle.route.length + 0.001)) ||
        !matchesPose(
          vehicle.pose,
          sampleLaneRoute(vehicle.route, vehicle.distance),
        ) ||
        (vehicle.plan &&
          (!validLane(vehicle.plan.route) ||
            JSON.stringify(vehicle.plan.route) !==
              JSON.stringify(vehicle.route) ||
            vehicle.plan.initialStop >= vehicle.plan.stops.length ||
            vehicle.plan.stops.some(
              value => value > vehicle.plan!.route.length,
            ) ||
            vehicle.stopIndex >= vehicle.plan.stops.length)) ||
        (data.held[index]! >= 0 && data.owners[data.held[index]!] !== index)
      ) {
        fail();
      }
    }
  }
}
