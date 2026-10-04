import {describe, expect, it} from 'vitest';
import {sampleLaneRoute} from '../../../packages/app/src/city/trafficRoutes';
import {RegionMobility} from '../src/model/life/mobility';
import {parkingPoint, resolvePlace} from '../src/model/life/routes';
import {createRegionalLife} from '../../../packages/app/src/region/model/life/state';
import type {
  MutableRegion,
  RegionalBuilding,
} from '../../../packages/app/src/region/model/life/types';
import {flatFixture} from '../../../packages/app/test/helpers/regionFixture';

function fixture(): MutableRegion {
  const base = flatFixture();
  const state: MutableRegion = {
    ...base,
    schemaVersion: 3,
    life: createRegionalLife(base.cash),
    roads: [
      {
        id: 'road',
        points: [
          {x: -400, z: 0},
          {x: 400, z: 0},
        ],
      },
    ],
    externalEntries: [{id: 'entry', roadId: 'road', endpoint: 'start'}],
    parcels: [],
  };

  for (const [i, x] of [-200, 200].entries()) {
    const id = 'b' + i;

    state.parcels = [
      ...state.parcels,
      {
        id: 'lot' + i,
        center: {x, z: -18},
        heading: 0,
        width: 16,
        depth: 24,
        zone: 'residential',
        settlementId: 'town',
        access: {roadId: 'road', segment: 0, offset: (x + 400) / 800},
      },
    ];
    const b: RegionalBuilding = {
      id,
      lotId: 'lot' + i,
      settlementId: 'town',
      kind: 'residential',
      ownerId: 'family',
      stage: 'ready',
      startedAt: 0,
      progressSeconds: 0,
      durationSeconds: 1,
      capacity: 16,
      jobs: 0,
      qualification: 0,
      parking: 1,
      inventory: 0,
      inventoryCapacity: 0,
      cash: 0,
      productionWork: 0,
    };

    state.life.buildings.push(b);
  }

  state.life.families.push({
    id: 'family',
    memberIds: ['person'],
    cash: 100,
    homeId: 'b0',
    status: 'settled',
    availableAt: 0,
    carId: null,
    goods: 0,
    lastShopDay: -1,
    reason: null,
  });

  return state;
}

describe('regional mobility', () => {
  it('routes only through connected real roads with exact provenance', () => {
    const state = fixture();
    const mobility = new RegionMobility(state);

    expect(mobility.route('entry', 'b1', 'car')?.roadIds).toEqual(['road']);
    expect(mobility.route('missing', 'b1', 'walk')).toBeNull();
    state.roads = [];
    state.roadRevision++;
    expect(mobility.route('b0', 'b1', 'car')).toBeNull();
  });
  it('reserves finite parking and a single car and completes a physical trip', () => {
    const state = fixture();
    const mobility = new RegionMobility(state);
    const car = mobility.createCar('family', 'entry')!;
    const request = {
      actorId: 'person',
      vehicleId: car.id,
      fromId: 'entry',
      toId: 'b0',
      mode: 'car',
      purpose: 'arrival',
    } as const;

    expect(mobility.start(request)).not.toBeNull();
    expect(mobility.start(request)).toBeNull();
    expect(mobility.step(1)).toEqual([]);
    const complete = mobility.step(120);

    expect(complete).toHaveLength(1);
    expect(car.parkedAt).toBe('b0');
    expect(car.driverId).toBeNull();
    expect(state.life.trips).toEqual([]);
  });
  it('continues the identical active journey after save and restore', () => {
    const state = fixture();
    const first = new RegionMobility(state);
    const car = first.createCar('family', 'entry')!;

    first.start({
      actorId: 'person',
      vehicleId: car.id,
      fromId: 'entry',
      toId: 'b1',
      mode: 'car',
      purpose: 'arrival',
    });
    first.step(20);
    first.save();
    const other = structuredClone(state);
    const restored = new RegionMobility(other);

    first.step(15);
    first.save();
    restored.step(15);
    restored.save();
    expect(other.life).toEqual(state.life);
  });
});

it('walks to the parked car, drives, then walks from the reserved space to the door', () => {
  const state = fixture();
  const mobility = new RegionMobility(state);
  const car = mobility.createCar('family', 'entry')!;

  car.parkedAt = 'b0';
  car.parkingSlot = 0;
  const trip = mobility.start({
    actorId: 'person',
    vehicleId: car.id,
    fromId: 'b0',
    toId: 'b1',
    mode: 'car',
    purpose: 'work',
  })!;

  expect(trip.phase).toBe('approach');
  expect(car.parkedAt).toBe('b0');
  mobility.step(2);
  expect(trip.phase).toBe('approach');
  expect(trip.approach!.distance).toBeGreaterThan(0);
  mobility.step(10);
  expect(trip.phase).toBe('travel');
  expect(car.parkedAt).toBeNull();
  expect(mobility.step(180)).toHaveLength(1);
  expect(car.parkedAt).toBe('b1');
});

it('closing a used road blocks new routes without losing the current journey', () => {
  const state = fixture();
  const mobility = new RegionMobility(state);
  const car = mobility.createCar('family', 'entry')!;

  mobility.start({
    actorId: 'person',
    vehicleId: car.id,
    fromId: 'entry',
    toId: 'b1',
    mode: 'car',
    purpose: 'arrival',
  });
  mobility.step(5);
  state.life.closingRoadIds = ['road'];
  state.roadRevision++;
  expect(mobility.route('entry', 'b0', 'car')).toBeNull();
  expect(mobility.step(180)).toHaveLength(1);
  expect(car.parkedAt).toBe('b1');
});

it('keeps occupied parking finite and rejects a second simultaneous driver', () => {
  const state = fixture();
  const mobility = new RegionMobility(state);
  const car = mobility.createCar('family', 'entry')!;

  car.parkedAt = 'b1';
  car.parkingSlot = 0;
  state.life.families.push({
    ...state.life.families[0]!,
    id: 'other',
    memberIds: ['other-person'],
    carId: null,
  });
  const other = mobility.createCar('other', 'entry')!;

  expect(
    mobility.start({
      actorId: 'other-person',
      vehicleId: other.id,
      fromId: 'entry',
      toId: 'b1',
      mode: 'car',
      purpose: 'arrival',
    }),
  ).toBeNull();
  const trip = mobility.start({
    actorId: 'person',
    vehicleId: car.id,
    fromId: 'b1',
    toId: 'b0',
    mode: 'car',
    purpose: 'work',
  });

  expect(trip).not.toBeNull();
  expect(
    mobility.start({
      actorId: 'other-person',
      vehicleId: car.id,
      fromId: 'b1',
      toId: 'b0',
      mode: 'car',
      purpose: 'work',
    }),
  ).toBeNull();
});

it('keeps routes and traffic continuous when a junction is added during a journey', () => {
  const state = fixture();
  const mobility = new RegionMobility(state);
  const car = mobility.createCar('family', 'entry')!;
  const trip = mobility.start({
    actorId: 'person',
    vehicleId: car.id,
    fromId: 'entry',
    toId: 'b1',
    mode: 'car',
    purpose: 'arrival',
  })!;

  mobility.step(10);
  const before = trip.distance;

  state.roads = [
    ...state.roads,
    {
      id: 'branch',
      points: [
        {x: 0, z: -100},
        {x: 0, z: 100},
      ],
    },
  ];
  state.roadRevision++;
  mobility.step(1);
  expect(trip.distance).toBeGreaterThan(before);
  expect(state.life.junctionKeys).toContain('0,0');
  mobility.save();
  const restored = new RegionMobility(structuredClone(state));

  expect(restored.step(180)).toHaveLength(1);
});

it('traverses angled road segments with continuous separated lanes', () => {
  const state = fixture();

  state.roads = [
    {
      id: 'road',
      points: [
        {x: -400, z: 0},
        {x: 0, z: 0},
      ],
    },
    {
      id: 'diagonal',
      points: [
        {x: 0, z: 0},
        {x: 200, z: 200},
      ],
    },
  ];
  state.parcels = state.parcels.map((p, i) =>
    i === 1
      ? {
          ...p,
          center: {x: 110, z: 90},
          heading: -Math.PI / 4,
          access: {roadId: 'diagonal', segment: 0, offset: 0.5},
        }
      : p,
  );
  const route = new RegionMobility(state).route('entry', 'b1', 'car')!;

  expect(route.roadIds).toEqual(['road', 'diagonal']);
  expect(route.lane.length).toBeGreaterThan(500);
  expect(route.lane.segments.some(s => s.kind === 'arc')).toBe(true);

  for (let i = 1; i < route.lane.segments.length; i++) {
    const prior = route.lane.segments[i - 1]!;
    const next = route.lane.segments[i]!;
    const end = sampleLaneRoute(
      {direction: 1, closed: false, segments: [prior], length: prior.length},
      prior.length,
    );
    const start = sampleLaneRoute(
      {direction: 1, closed: false, segments: [next], length: next.length},
      0,
    );

    expect(end.x).toBeCloseTo(start.x, 6);
    expect(end.z).toBeCloseTo(start.z, 6);
    expect(end.dx * start.dx + end.dz * start.dz).toBeCloseTo(1, 6);
  }

  for (let i = 1; i < route.lane.segments.length; i++) {
    const previous = route.lane.segments[i - 1]!;
    const current = route.lane.segments[i]!;

    if (previous.kind === 'line' && current.kind === 'line') {
      expect(previous.x + previous.dx * previous.length).toBeCloseTo(current.x);
      expect(previous.z + previous.dz * previous.length).toBeCloseTo(current.z);
    }
  }
});

it('is independent of save and time request partitioning', () => {
  const state = fixture();
  const mobility = new RegionMobility(state);
  const car = mobility.createCar('family', 'entry')!;

  mobility.start({
    actorId: 'person',
    vehicleId: car.id,
    fromId: 'entry',
    toId: 'b1',
    mode: 'car',
    purpose: 'arrival',
  });
  mobility.save();
  const other = structuredClone(state);

  mobility.step(40);
  mobility.save();
  let restored = new RegionMobility(other);

  for (let i = 0; i < 40; i++) {
    restored.step(1);
    restored.save();
    restored = new RegionMobility(other);
  }

  expect(other.life).toEqual(state.life);
});

it('allows walking between opposite buildings sharing one road access point', () => {
  const state = fixture();
  const first = state.parcels[0]!;

  state.parcels = [
    first,
    {
      ...state.parcels[1]!,
      center: {x: first.center.x, z: 18},
      heading: Math.PI,
      access: first.access,
    },
  ];
  const mobility = new RegionMobility(state);
  const route = mobility.route('b0', 'b1', 'walk');

  expect(route).not.toBeNull();
  expect(route!.roadIds).toEqual(['road']);
  expect(route!.crossings).toHaveLength(1);
  expect(
    mobility.start({
      actorId: 'person',
      fromId: 'b0',
      toId: 'b1',
      mode: 'walk',
      purpose: 'work',
    }),
  ).not.toBeNull();
  expect(mobility.step(30)).toHaveLength(1);
});

it('lets sidewalk pedestrians and a departing parked car clear the shared driveway', () => {
  const state = fixture();

  state.parcels = state.parcels.map(p => ({
    ...p,
    center: {x: p.center.x, z: 18},
    heading: Math.PI,
  }));
  const mobility = new RegionMobility(state);
  const car = mobility.createCar('family', 'entry')!;

  car.parkedAt = 'b0';
  car.parkingSlot = 0;
  expect(
    mobility.start({
      actorId: 'person',
      vehicleId: car.id,
      fromId: 'b0',
      toId: 'b1',
      mode: 'car',
      purpose: 'work',
    }),
  ).not.toBeNull();
  expect(
    mobility.start({
      actorId: 'walker',
      fromId: 'b0',
      toId: 'b1',
      mode: 'walk',
      purpose: 'work',
    }),
  ).not.toBeNull();
  const completed = mobility.step(1000);

  expect(completed).toHaveLength(2);
  expect(state.life.trips).toEqual([]);
});

it('clears the complete merge before releasing a driveway beside another departing car', () => {
  const state = fixture();

  state.parcels = state.parcels.map(p => ({
    ...p,
    center: {x: p.center.x, z: 18},
    heading: Math.PI,
  }));
  state.life.buildings.forEach(b => {
    b.parking = 4;
  });
  const mobility = new RegionMobility(state);

  for (let i = 0; i < 3; i++) {
    const familyId = 'f' + i;
    const personId = 'p' + i;

    state.life.families.push({
      ...state.life.families[0]!,
      id: familyId,
      memberIds: [personId],
      carId: null,
    });
    const car = mobility.createCar(familyId, 'entry')!;

    car.parkedAt = 'b0';
    car.parkingSlot = i;
    expect(
      mobility.start({
        actorId: personId,
        vehicleId: car.id,
        fromId: 'b0',
        toId: 'b1',
        mode: 'car',
        purpose: 'work',
      }),
    ).not.toBeNull();
    expect(
      mobility.start({
        actorId: 'walker' + i,
        fromId: 'b0',
        toId: 'b1',
        mode: 'walk',
        purpose: 'work',
      }),
    ).not.toBeNull();
  }

  expect(mobility.step(1000)).toHaveLength(6);
});

it.each([0, Math.PI / 5, -Math.PI / 3])(
  'keeps an outer parking bay driver clear of occupied inner bays at heading %s',
  heading => {
    const state = fixture();
    const rotate = (p: {x: number; z: number}) => ({
      x: p.x * Math.cos(heading) + p.z * Math.sin(heading),
      z: -p.x * Math.sin(heading) + p.z * Math.cos(heading),
    });

    state.roads = state.roads.map(r => ({...r, points: r.points.map(rotate)}));
    state.parcels = state.parcels.map(p => ({
      ...p,
      center: rotate(p.center),
      heading,
    }));
    state.life.buildings.forEach(b => {
      b.parking = 4;
    });
    const mobility = new RegionMobility(state);
    const driver = mobility.createCar('family', 'entry')!;

    driver.parkedAt = 'b0';
    driver.parkingSlot = 3;

    for (const placeId of ['b0', 'b1']) {
      for (let slot = 0; slot < 3; slot++) {
        const familyId = placeId + '-family-' + slot;

        state.life.families.push({
          ...state.life.families[0]!,
          id: familyId,
          carId: null,
        });
        const car = mobility.createCar(familyId, 'entry')!;

        car.parkedAt = placeId;
        car.parkingSlot = slot;
      }
    }

    const trip = mobility.start({
      actorId: 'person',
      vehicleId: driver.id,
      fromId: 'b0',
      toId: 'b1',
      mode: 'car',
      purpose: 'work',
    })!;

    expect(trip.parkingSlot).toBe(3);

    for (const [placeId, leg] of [
      ['b0', trip.approach!],
      ['b1', trip.exit!],
    ] as const) {
      const place = resolvePlace(state, placeId)!;

      for (let distance = 0; distance <= leg.lane.length; distance += 0.05) {
        const pose = sampleLaneRoute(leg.lane, distance);

        for (let slot = 0; slot < 3; slot++) {
          const parked = parkingPoint(place, slot);
          const dx = pose.x - parked.x;
          const dz = pose.z - parked.z;
          const across = Math.abs(
            dx * Math.cos(heading) - dz * Math.sin(heading),
          );
          const along = Math.abs(
            dx * Math.sin(heading) + dz * Math.cos(heading),
          );

          expect(across >= 0.9 + 0.3 || along >= 2.1 + 0.3).toBe(true);
        }
      }
    }

    expect(mobility.step(1000)).toHaveLength(1);
    expect(driver.parkedAt).toBe('b1');
    expect(driver.parkingSlot).toBe(3);
    expect(
      state.life.cars
        .filter(c => c.id !== driver.id)
        .every(c => c.tripId === null),
    ).toBe(true);
  },
);

it.each([58, 59, 60, 61, 62])(
  'clears an arriving truck and shopping walkers at a service bay after %s seconds',
  delay => {
    const state = fixture();

    state.parcels = state.parcels.map(p => ({
      ...p,
      center: {x: p.center.x, z: 18},
      heading: Math.PI,
    }));
    const lot = state.parcels[0]!;

    state.parcels = [
      ...state.parcels,
      {...lot, id: 'nearby', center: {x: -216, z: 18}},
    ];
    state.life.buildings.push({
      ...state.life.buildings[0]!,
      id: 'b2',
      lotId: 'nearby',
    });
    state.parcels = state.parcels.map(p =>
      p.id === 'nearby'
        ? {...p, access: {roadId: 'road', segment: 0, offset: 184 / 800}}
        : p,
    );
    const mobility = new RegionMobility(state);

    expect(
      mobility.start({
        actorId: 'delivery',
        fromId: 'b1',
        toId: 'b0',
        mode: 'truck',
        purpose: 'delivery',
      }),
    ).not.toBeNull();
    const completed = mobility.step(delay);

    for (let i = 0; i < 4; i++) {
      expect(
        mobility.start({
          actorId: 'shopper-' + i,
          fromId: 'b2',
          toId: 'b0',
          mode: 'walk',
          purpose: 'shop',
        }),
      ).not.toBeNull();
    }

    if (delay === 60) {
      for (let tick = 0; tick < 4000; tick++) {
        completed.push(...mobility.step(0.05));
        const truck = state.life.trips.find(t => t.mode === 'truck');

        if (!truck) {
          continue;
        }

        for (const walker of state.life.trips.filter(t => t.mode === 'walk')) {
          const dx = walker.pose.x - truck.pose.x;
          const dz = walker.pose.z - truck.pose.z;
          const along = Math.abs(dx * truck.pose.dx + dz * truck.pose.dz);
          const across = Math.abs(-dx * truck.pose.dz + dz * truck.pose.dx);

          expect(along >= 6.5 / 2 + 0.29 || across >= 2.3 / 2 + 0.29).toBe(
            true,
          );
        }
      }
    } else {
      completed.push(...mobility.step(200));
    }

    expect(completed).toHaveLength(5);
    expect(state.life.trips).toEqual([]);
  },
);

it.each([96.5, 97, 97.5, 98])(
  'clears a turning car and a sidewalk crossing at a reserved junction with delay %s',
  delay => {
    const state = fixture();

    state.roads = [
      ...state.roads,
      {
        id: 'cross',
        points: [
          {x: 0, z: -400},
          {x: 0, z: 400},
        ],
      },
    ];
    state.externalEntries = [{id: 'entry', roadId: 'road', endpoint: 'end'}];

    for (const [i, z] of [-200, 200].entries()) {
      state.parcels = [
        ...state.parcels,
        {
          ...state.parcels[0]!,
          id: 'crosslot' + i,
          center: {x: 18, z},
          heading: -Math.PI / 2,
          access: {roadId: 'cross', segment: 0, offset: (z + 400) / 800},
        },
      ];
      state.life.buildings.push({
        ...state.life.buildings[0]!,
        id: 'crossbuilding' + i,
        lotId: 'crosslot' + i,
      });
    }

    const mobility = new RegionMobility(state);

    mobility.start({
      actorId: 'walker',
      fromId: 'crossbuilding0',
      toId: 'crossbuilding1',
      mode: 'walk',
      purpose: 'work',
    });
    const completed = mobility.step(delay);
    const car = mobility.createCar('family', 'entry')!;

    mobility.start({
      actorId: 'person',
      vehicleId: car.id,
      fromId: 'entry',
      toId: 'crossbuilding1',
      mode: 'car',
      purpose: 'arrival',
    });

    if (delay === 97) {
      completed.push(...mobility.step(73.5));
      mobility.save();
      const clone = structuredClone(state);
      const restored = new RegionMobility(clone);

      completed.push(...mobility.step(5));
      restored.step(5);
      mobility.save();
      restored.save();
      expect(clone.life).toEqual(state.life);

      for (let tick = 0; tick < 4000; tick++) {
        const previous = new Map(
          state.life.trips.map(t => [t.id, {...t.pose}]),
        );

        completed.push(...mobility.step(0.05));

        for (const trip of state.life.trips) {
          const before = previous.get(trip.id)!;

          expect(
            Math.hypot(trip.pose.x - before.x, trip.pose.z - before.z),
          ).toBeLessThanOrEqual(trip.mode === 'walk' ? 0.060001 : 0.275001);
        }

        const driving = state.life.trips.find(
          t => t.mode === 'car' && t.phase === 'travel',
        );
        const walking = state.life.trips.find(t => t.mode === 'walk');

        if (driving && walking) {
          const dx = walking.pose.x - driving.pose.x;
          const dz = walking.pose.z - driving.pose.z;
          const along = Math.abs(dx * driving.pose.dx + dz * driving.pose.dz);
          const across = Math.abs(-dx * driving.pose.dz + dz * driving.pose.dx);

          expect(along >= 2.1 + 0.29 || across >= 0.9 + 0.29).toBe(true);
        }
      }
    }

    completed.push(...mobility.step(600));
    expect(completed).toHaveLength(2);
  },
);

it.each([98, 99, 100])(
  'lets a pedestrian trapped ahead of a turning truck leave forward with delay %s',
  delay => {
    const state = fixture();

    state.parcels = state.parcels.map(p => ({
      ...p,
      center: {x: p.center.x, z: 18},
      heading: Math.PI,
    }));
    state.roads = [
      ...state.roads,
      {
        id: 'cross',
        points: [
          {x: 0, z: -400},
          {x: 0, z: 400},
        ],
      },
    ];
    state.parcels = [
      ...state.parcels,
      {
        ...state.parcels[0]!,
        id: 'south',
        center: {x: 18, z: 200},
        heading: -Math.PI / 2,
        access: {roadId: 'cross', segment: 0, offset: 0.75},
      },
    ];
    state.life.buildings.push({
      ...state.life.buildings[0]!,
      id: 'south-building',
      lotId: 'south',
    });
    const mobility = new RegionMobility(state);

    mobility.start({
      actorId: 'walker',
      fromId: 'b0',
      toId: 'b1',
      mode: 'walk',
      purpose: 'work',
    });
    const completed = mobility.step(delay);

    mobility.start({
      actorId: 'delivery',
      fromId: 'entry',
      toId: 'south-building',
      mode: 'truck',
      purpose: 'delivery',
    });

    if (delay === 99) {
      for (let tick = 0; tick < 12000; tick++) {
        const before = state.life.trips.find(t => t.mode === 'walk')?.pose;

        completed.push(...mobility.step(0.05));
        const walker = state.life.trips.find(t => t.mode === 'walk');
        const truck = state.life.trips.find(t => t.mode === 'truck');

        if (before && walker) {
          expect(
            Math.hypot(walker.pose.x - before.x, walker.pose.z - before.z),
          ).toBeLessThanOrEqual(0.060001);
        }
        if (walker && truck) {
          const dx = walker.pose.x - truck.pose.x;
          const dz = walker.pose.z - truck.pose.z;
          const along = Math.abs(dx * truck.pose.dx + dz * truck.pose.dz);
          const across = Math.abs(-dx * truck.pose.dz + dz * truck.pose.dx);

          expect(along >= 3.25 + 0.29 || across >= 1.15 + 0.29).toBe(true);
        }
      }
    } else {
      completed.push(...mobility.step(600));
    }

    expect(completed).toHaveLength(2);
  },
);

it('clears an existing pedestrian conflict at an unreserved service-bay turn', () => {
  const state = fixture();

  state.parcels = state.parcels.map(p => ({
    ...p,
    center: {x: p.center.x, z: 18},
    heading: Math.PI,
  }));
  state.parcels = [
    ...state.parcels,
    {
      ...state.parcels[0]!,
      id: 'opposite',
      center: {x: -200, z: -18},
      heading: 0,
    },
  ];
  state.life.buildings.push({
    ...state.life.buildings[0]!,
    id: 'opposite-building',
    lotId: 'opposite',
  });
  const mobility = new RegionMobility(state);
  const delivery = mobility.start({
    actorId: 'delivery',
    fromId: 'entry',
    toId: 'b0',
    mode: 'truck',
    purpose: 'delivery',
  })!;
  const walker = mobility.start({
    actorId: 'walker',
    fromId: 'opposite-building',
    toId: 'b0',
    mode: 'walk',
    purpose: 'shop',
  })!;

  mobility.save();
  // Physical positions reduced from the captured Saturday snapshot, before any overlap.
  const truck = state.life.traffic!.vehicles[delivery.trafficIndex!]!;

  truck.distance = 199.6610555011298;
  truck.previous = truck.distance;
  truck.pose = sampleLaneRoute(truck.route, truck.distance);
  delivery.distance = truck.distance;
  delivery.pose = {...truck.pose};
  walker.distance = 13.519999978098625;
  walker.pose = sampleLaneRoute(walker.route.lane, walker.distance);
  const loaded = new RegionMobility(state);
  const follower = loaded.start({
    actorId: 'following-delivery',
    fromId: 'entry',
    toId: 'b1',
    mode: 'truck',
    purpose: 'delivery',
  })!;

  loaded.save();
  const followingTruck = state.life.traffic!.vehicles[follower.trafficIndex!]!;

  followingTruck.distance = 191.3624389197972;
  followingTruck.previous = followingTruck.distance;
  followingTruck.pose = sampleLaneRoute(
    followingTruck.route,
    followingTruck.distance,
  );
  follower.distance = followingTruck.distance;
  follower.pose = {...followingTruck.pose};
  const restored = new RegionMobility(state);

  expect(restored.step(200)).toHaveLength(3);
});

it('does not enter a refused arrival maneuver before the pedestrian clears it', () => {
  const state = fixture();

  state.parcels = state.parcels.map(p => ({
    ...p,
    center: {x: p.center.x, z: 18},
    heading: Math.PI,
  }));
  state.parcels = [
    ...state.parcels,
    {
      ...state.parcels[0]!,
      id: 'opposite',
      center: {x: -200, z: -18},
      heading: 0,
    },
  ];
  state.life.buildings.push({
    ...state.life.buildings[0]!,
    id: 'opposite-building',
    lotId: 'opposite',
  });
  const setup = new RegionMobility(state);
  const delivery = setup.start({
    actorId: 'delivery',
    fromId: 'entry',
    toId: 'b0',
    mode: 'truck',
    purpose: 'delivery',
  })!;
  const walker = setup.start({
    actorId: 'walker',
    fromId: 'opposite-building',
    toId: 'b0',
    mode: 'walk',
    purpose: 'shop',
  })!;

  setup.save();
  const vehicle = state.life.traffic!.vehicles[delivery.trafficIndex!]!;

  vehicle.distance = 188;
  vehicle.previous = 188;
  vehicle.pose = sampleLaneRoute(vehicle.route, 188);
  delivery.distance = 188;
  delivery.pose = {...vehicle.pose};
  walker.distance = 13.52;
  walker.pose = sampleLaneRoute(walker.route.lane, walker.distance);
  const mobility = new RegionMobility(state);
  let observedRefusal = false;
  let observedPermit = false;
  const completed = [];

  for (let tick = 0; tick < 400; tick++) {
    completed.push(...mobility.step(0.05));
    mobility.save();
    const current = state.life.traffic!.vehicles[delivery.trafficIndex!]!;

    if (current.maneuverFrom === undefined && current.active) {
      observedRefusal = true;
      expect(delivery.distance).toBeLessThanOrEqual(192.500001);
      expect(completed.some(t => t.id === delivery.id)).toBe(false);
    } else if (current.maneuverFrom !== undefined) {
      observedPermit = true;
    }
  }

  completed.push(...mobility.step(100));
  expect(observedRefusal).toBe(true);
  expect(observedPermit).toBe(true);
  expect(completed).toHaveLength(2);
});
