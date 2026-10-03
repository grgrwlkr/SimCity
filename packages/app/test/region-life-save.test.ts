import {CityTraffic} from '../src/city/trafficFlow';
import {sampleLaneRoute, type LaneRoute} from '../src/city/trafficRoutes';
import type {RegionState} from '../src/region/model/types';
import type {
  RegionalBuilding,
  RegionalTrip,
} from '../src/region/model/life/types';
import {describe, expect, it} from 'vitest';
import {parseRegion, serializeRegion} from '../src/region/model/save';
import {createRegion} from '../src/region/model/world';

describe('regional life saves', () => {
  it('starts v3 with zero population and preserves the complete empty state', () => {
    const state = createRegion('empty', '689856');

    expect(state.schemaVersion).toBe(3);
    expect(state.life.people).toEqual([]);
    expect(state.life.economy.initialMoney).toBe(state.cash);
    expect(parseRegion(serializeRegion(state))).toEqual(state);
  });
  it.each([1, 2])(
    'migrates v%i without changing the authored region',
    version => {
      const current = createRegion('legacy', '689856');
      const {life: emptyLife, ...legacy} = current;

      expect(emptyLife.people).toEqual([]);
      const saved = {...legacy, schemaVersion: version, cash: 123456};
      const loaded = parseRegion({
        kind: 'simcity-region',
        version,
        state: saved,
      });
      const {life, ...editor} = loaded;

      expect(editor).toEqual({...saved, schemaVersion: 3});
      expect(life.people).toEqual([]);
      expect(life.families).toEqual([]);
      expect(life.economy.initialMoney).toBe(123456);
    },
  );
  it('rejects invalid clocks, counters and unknown life fields', () => {
    const state = createRegion('invalid', '689856');

    for (const invalid of [
      {elapsedSeconds: -1},
      {elapsedSeconds: NaN},
      {remainderSeconds: 1},
      {nextId: 0},
      {completedTrips: -1},
      {mystery: true},
    ]) {
      expect(() =>
        parseRegion({
          kind: 'simcity-region',
          version: 3,
          state: {...state, life: {...state.life, ...invalid}},
        }),
      ).toThrow();
    }
  });
});

function populatedFixture(): RegionState {
  const initial = createRegion('lived', '689856');
  const home: RegionalBuilding = {
    id: 'building-1',
    lotId: 'parcel-3',
    settlementId: 'settlement-1',
    kind: 'residential',
    ownerId: 'family-1',
    stage: 'ready',
    startedAt: 0,
    progressSeconds: 100,
    durationSeconds: 100,
    capacity: 4,
    jobs: 0,
    qualification: 0,
    parking: 2,
    inventory: 0,
    inventoryCapacity: 0,
    cash: 0,
    productionWork: 0,
  };
  const industry: RegionalBuilding = {
    ...home,
    id: 'building-2',
    lotId: 'parcel-4',
    kind: 'industrial',
    ownerId: 'investor-1',
    capacity: 0,
    jobs: 4,
    inventoryCapacity: 50,
    inventory: 7,
    cash: 123,
  };
  const lane: LaneRoute = {
    direction: 1,
    closed: false,
    length: 200,
    segments: [{kind: 'line', x: -600, z: -300, dx: 1, dz: 0, length: 200}],
  };
  const runtime = new CityTraffic([], {roads: []});
  const carIndex = runtime.addCar({length: 4, width: 2});
  const truckIndex = runtime.addCar({length: 6, width: 2});

  runtime.beginTrip(carIndex, lane);
  runtime.beginTrip(truckIndex, {
    ...lane,
    segments: [{kind: 'line', x: -1900, z: -300, dx: 1, dz: 0, length: 200}],
  });
  runtime.update(1);
  const traffic = runtime.save();
  const work: RegionalTrip = {
    id: 'trip-4',
    actorId: 'resident-1',
    passengerIds: [],
    vehicleId: 'car-1',
    trafficIndex: carIndex,
    fromId: home.id,
    toId: industry.id,
    mode: 'car',
    purpose: 'work',
    phase: 'travel',
    route: {lane, roadIds: ['road-2'], roadRevision: 1, crossings: []},
    distance: traffic.vehicles[carIndex]!.distance,
    pose: traffic.vehicles[carIndex]!.pose,
    startedAt: 99,
    waitingSeconds: 0,
    parkingSlot: 0,
  };
  const freight: RegionalTrip = {
    ...work,
    id: 'trip-5',
    actorId: 'delivery-6',
    vehicleId: null,
    trafficIndex: truckIndex,
    fromId: 'entry-6',
    mode: 'truck',
    purpose: 'delivery',
    route: {...work.route, lane: traffic.vehicles[truckIndex]!.route},
    distance: traffic.vehicles[truckIndex]!.distance,
    pose: traffic.vehicles[truckIndex]!.pose,
    parkingSlot: 2,
  };

  return {
    ...initial,
    nextId: 7,
    revision: 1,
    roadRevision: 1,
    terrain: {...initial.terrain, water: []},
    settlements: [
      {id: 'settlement-1', name: 'Север', center: {x: -500, z: -500}},
    ],
    roads: [
      {
        id: 'road-2',
        points: [
          {x: -2000, z: -300},
          {x: -400, z: -300},
        ],
      },
    ],
    parcels: [
      {
        id: 'parcel-3',
        settlementId: 'settlement-1',
        center: {x: -600, z: -260},
        heading: 0,
        width: 32,
        depth: 32,
        zone: 'residential',
        access: null,
      },
      {
        id: 'parcel-4',
        settlementId: 'settlement-1',
        center: {x: -400, z: -260},
        heading: 0,
        width: 32,
        depth: 32,
        zone: 'industrial',
        access: null,
      },
      {
        id: 'parcel-5',
        settlementId: 'settlement-1',
        center: {x: -450, z: -260},
        heading: 0,
        width: 32,
        depth: 32,
        zone: 'commercial',
        access: null,
      },
    ],
    externalEntries: [{id: 'entry-6', roadId: 'road-2', endpoint: 'start'}],
    life: {
      ...initial.life,
      elapsedSeconds: 100,
      remainderSeconds: 0.25,
      initialized: true,
      nextId: 7,
      families: [
        {
          id: 'family-1',
          memberIds: ['resident-1'],
          cash: 678,
          homeId: home.id,
          status: 'settled',
          availableAt: 0,
          carId: 'car-1',
          goods: 2,
          lastShopDay: -1,
          reason: null,
        },
      ],
      people: [
        {
          id: 'resident-1',
          familyId: 'family-1',
          name: 'Ирина',
          age: 34,
          qualification: 0,
          jobId: industry.id,
          placeId: home.id,
          tripId: work.id,
          activity: 'driving',
          reason: null,
          workedSeconds: 12,
          wageSeconds: 12,
        },
      ],
      investors: [{id: 'investor-1', cash: 1000}],
      buildings: [
        home,
        industry,
        {
          ...industry,
          id: 'building-3',
          lotId: 'parcel-5',
          kind: 'commercial',
          stage: 'constructing',
          progressSeconds: 42,
        },
      ],
      cars: [
        {
          id: 'car-1',
          familyId: 'family-1',
          driverId: 'resident-1',
          parkedAt: null,
          parkingSlot: null,
          tripId: work.id,
          trafficIndex: carIndex,
        },
      ],
      trips: [work, freight],
      deliveries: [
        {
          id: 'delivery-6',
          sourceId: null,
          targetId: industry.id,
          quantity: 16,
          cargo: 16,
          state: 'in-transit',
          tripId: freight.id,
          phaseSeconds: 0,
          unitPrice: 20,
          reason: null,
        },
      ],
      traffic,
      closingRoadIds: ['road-2'],
      economy: {
        ...initial.life.economy,
        produced: 7,
        consumed: 2,
        externalGoods: 25,
        importsPaid: 320,
      },
    },
  };
}

describe('regional life reference integrity', () => {
  it('migrates v2 retaining authored lots and roads without importing population', () => {
    const state = populatedFixture();
    const {life, ...editor} = state;

    expect(life.initialized).toBe(true);
    const old = {...editor, schemaVersion: 2};
    const loaded = parseRegion({
      kind: 'simcity-region',
      version: 2,
      state: old,
    });

    expect(loaded.parcels).toEqual(state.parcels);
    expect(loaded.roads).toEqual(state.roads);
    expect(loaded.life.people).toEqual([]);
    expect(loaded.life.initialized).toBe(false);
  });

  it('round-trips construction, people, active cars, cargo and closing roads exactly', () => {
    const state = populatedFixture();
    const loaded = parseRegion(serializeRegion(state));

    expect(loaded).toEqual(state);
    expect(loaded.life).not.toBe(state.life);
  });
  it('rejects broken references, duplicate parking and forged traffic state without mutating input', () => {
    const source = populatedFixture();
    const changes: Array<(state: RegionState) => void> = [
      state => {
        state.life.initialized = false;
      },
      state => {
        state.life.nextId = 2;
      },
      state => {
        state.life.families[0]!.memberIds.push('missing');
      },
      state => {
        state.life.people[0]!.jobId = 'missing';
      },
      state => {
        state.life.people[0]!.familyId = 'missing';
      },
      state => {
        state.life.buildings[0]!.lotId = 'missing';
      },
      state => {
        state.life.buildings[0]!.settlementId = 'missing';
      },
      state => {
        state.life.cars[0]!.tripId = 'missing';
      },
      state => {
        state.life.trips[0]!.route.roadIds.push('missing');
      },
      state => {
        state.life.trips[0]!.pose.z += 20;
      },
      state => {
        state.life.trips[0]!.trafficIndex = 1;
      },
      state => {
        state.life.trips[0]!.parkingSlot = 2;
      },
      state => {
        state.life.trips[1]!.parkingSlot = 0;
      },
      state => {
        state.life.deliveries[0]!.targetId = 'missing';
      },
      state => {
        state.life.deliveries[0]!.cargo = 17;
      },
      state => {
        state.life.traffic!.vehicles[0]!.pose.x += 20;
      },
      state => {
        state.life.traffic!.held[0] = 1;
      },
      state => {
        state.life.traffic!.vehicles[0]!.route = {
          ...state.life.traffic!.vehicles[0]!.route,
          length: 999,
        };
      },
      state => {
        state.life.closingRoadIds.push('missing');
      },
      state => {
        state.life.families.push({...state.life.families[0]!});
      },
    ];

    for (const mutate of changes) {
      const state = structuredClone(source);

      mutate(state);
      const before = structuredClone(state);

      expect(() => parseRegion(serializeRegion(state))).toThrow();
      expect(state).toEqual(before);
    }

    expect(parseRegion(serializeRegion(source))).toEqual(source);
  });
  it('preserves approach and exit legs while an owned car remains parked', () => {
    for (const phase of ['approach', 'exit'] as const) {
      const state = populatedFixture();
      const trip = state.life.trips[0]!;
      const car = state.life.cars[0]!;
      const leg = {lane: trip.route.lane, distance: 10};

      trip.phase = phase;
      trip[phase] = leg;
      trip.pose = sampleLaneRoute(leg.lane, leg.distance);
      car.parkedAt = phase === 'exit' ? trip.toId : trip.fromId;
      car.parkingSlot = 0;
      expect(parseRegion(serializeRegion(state))).toEqual(state);
    }
  });
});

it('preserves bounded arrival reservations and rejects invalid route ranges', () => {
  const state = populatedFixture();
  const vehicle = state.life.traffic!.vehicles[0]!;

  vehicle.maneuverFrom = 150;
  vehicle.maneuverUntil = 190;
  expect(parseRegion(serializeRegion(state))).toEqual(state);
  vehicle.maneuverFrom = 191;
  expect(() => parseRegion(serializeRegion(state))).toThrow();
  vehicle.maneuverFrom = 150;
  vehicle.maneuverUntil = vehicle.route.length + 1;
  expect(() => parseRegion(serializeRegion(state))).toThrow();
});
