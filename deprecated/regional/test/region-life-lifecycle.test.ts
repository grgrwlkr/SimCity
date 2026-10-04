import {finishRoadClosures} from '../../../packages/app/src/region/model/life/lifecycle';
import {
  parseRegion,
  serializeRegion,
} from '../../../packages/app/src/region/model/save';
import {describe, expect, it} from 'vitest';
import {applyAction} from '../../../packages/app/src/region/model/commands';
import {moneyBalance} from '../src/model/life/economy';
import type {
  MutableRegion,
  RegionalBuilding,
} from '../../../packages/app/src/region/model/life/types';
import {
  accepted,
  flatFixture,
} from '../../../packages/app/test/helpers/regionFixture';

function fixture(): MutableRegion {
  const state = flatFixture();
  const building: RegionalBuilding = {
    id: 'building-1',
    lotId: 'parcel-3',
    settlementId: 'settlement-1',
    kind: 'commercial',
    ownerId: 'investor-1',
    stage: 'ready',
    startedAt: 0,
    progressSeconds: 1,
    durationSeconds: 1,
    capacity: 0,
    jobs: 4,
    qualification: 0,
    parking: 2,
    inventory: 0,
    inventoryCapacity: 50,
    cash: 200,
    productionWork: 0,
  };

  return {
    ...state,
    nextId: 5,
    terrain: {...state.terrain, water: []},
    settlements: [{id: 'settlement-1', name: 'A', center: {x: 0, z: 0}}],
    roads: [
      {
        id: 'road-2',
        points: [
          {x: -2000, z: 100},
          {x: 500, z: 100},
        ],
      },
    ],
    parcels: [
      {
        id: 'parcel-3',
        settlementId: 'settlement-1',
        center: {x: 0, z: 120},
        heading: Math.PI,
        width: 16,
        depth: 24,
        zone: 'commercial',
        access: {roadId: 'road-2', segment: 0, offset: 0.8},
      },
    ],
    externalEntries: [{id: 'entry-4', roadId: 'road-2', endpoint: 'start'}],
    life: {
      ...state.life,
      initialized: true,
      elapsedSeconds: 1,
      nextId: 2,
      buildings: [building],
      investors: [{id: 'investor-1', cash: 1000}],
    },
  };
}

describe('regional object lifecycle', () => {
  it('moves every command cost to the external construction ledger atomically', () => {
    const state = flatFixture();
    const before = structuredClone(state);
    const next = accepted(
      applyAction(
        state,
        {type: 'found', name: 'A', center: {x: -500, z: -500}},
        0,
      ),
    );

    expect(moneyBalance(next)).toBe(moneyBalance(state));
    expect(next.life.economy.constructionPaid).toBe(12800);
    expect(next.life.economy.externalMoney).toBe(12800);
    expect(state).toEqual(before);
  });
  it('accounts for road and warehouse purchases and leaves refused spending untouched', () => {
    let state = accepted(
      applyAction(
        flatFixture(),
        {type: 'found', name: 'A', center: {x: -100, z: -100}},
        0,
      ),
    );
    const initialBalance = moneyBalance(state);
    const road = {
      type: 'road' as const,
      points: [
        {x: -200, z: 0},
        {x: 100, z: 0},
      ],
    };

    state = accepted(applyAction(state, road, state.revision));
    state = accepted(
      applyAction(
        state,
        {
          type: 'warehouse',
          settlementId: state.settlements[0]!.id,
          center: {x: -100, z: 20},
        },
        state.revision,
      ),
    );
    expect(moneyBalance(state)).toBe(initialBalance);
    expect(state.life.economy.constructionPaid).toBe(
      12800 + 30000 + state.rules.warehouseCost,
    );
    const poor = {...state, cash: 0};
    const before = structuredClone(poor);

    expect(
      applyAction(
        poor,
        {type: 'found', name: 'B', center: {x: -800, z: -800}},
        poor.revision,
      ),
    ).toEqual({ok: false, state: poor, reason: 'insufficient-funds'});
    expect(poor).toEqual(before);
  });
  it('rejects demolition of a building whose goods have not been moved', () => {
    const state = fixture();

    state.life.buildings[0]!.inventory = 2;
    expect(
      applyAction(state, {type: 'remove', id: 'parcel-3'}, state.revision),
    ).toEqual({ok: false, state, reason: 'occupied-building'});
  });
});

function movingFixture(): MutableRegion {
  const state = fixture();

  state.life.nextId = 3;
  state.life.families.push({
    id: 'family-1',
    memberIds: ['resident-1'],
    cash: 500,
    homeId: null,
    status: 'waiting',
    availableAt: 0,
    carId: null,
    goods: 0,
    lastShopDay: -1,
    reason: null,
  });
  state.life.people.push({
    id: 'resident-1',
    familyId: 'family-1',
    name: 'A',
    age: 30,
    qualification: 0,
    jobId: 'building-1',
    placeId: 'entry-4',
    tripId: 'trip-2',
    activity: 'walking',
    reason: null,
    workedSeconds: 0,
    wageSeconds: 0,
  });
  state.life.trips.push({
    id: 'trip-2',
    actorId: 'resident-1',
    passengerIds: [],
    vehicleId: null,
    trafficIndex: null,
    fromId: 'entry-4',
    toId: 'building-1',
    mode: 'walk',
    purpose: 'work',
    phase: 'travel',
    route: {
      lane: {
        direction: 1,
        closed: false,
        length: 100,
        segments: [{kind: 'line', x: -1000, z: 100, dx: 1, dz: 0, length: 100}],
      },
      roadIds: ['road-2'],
      roadRevision: 0,
      crossings: [],
    },
    distance: 10,
    pose: {x: -990, z: 100, dx: 1, dz: 0},
    startedAt: 0,
    waitingSeconds: 0,
    parkingSlot: null,
  });

  return state;
}

describe('regional demolition and closure safety', () => {
  it('refunds only the empty firm wallet and deletes completed delivery references', () => {
    const state = fixture();

    state.life.deliveries.push({
      id: 'delivery-2',
      sourceId: 'entry-4',
      targetId: 'building-1',
      quantity: 1,
      cargo: 0,
      state: 'delivered',
      tripId: null,
      phaseSeconds: 0,
      unitPrice: 20,
      reason: null,
    });
    state.life.nextId = 3;
    const before = structuredClone(state);
    const result = accepted(
      applyAction(state, {type: 'remove', id: 'building-1'}, state.revision),
    );

    expect(result.life.buildings).toEqual([]);
    expect(result.parcels).toEqual([]);
    expect(result.life.deliveries).toEqual([]);
    expect(result.life.investors[0]!.cash).toBe(1200);
    expect(moneyBalance(result)).toBe(moneyBalance(state));
    expect(state).toEqual(before);
    expect(parseRegion(serializeRegion(result))).toEqual(result);
  });
  it('cancels an unfunded waiting order when its empty business is removed', () => {
    const state = fixture();

    state.life.nextId = 3;
    state.life.deliveries.push({
      id: 'delivery-2',
      sourceId: null,
      targetId: 'building-1',
      quantity: 4,
      cargo: 0,
      state: 'waiting',
      tripId: null,
      phaseSeconds: 0,
      unitPrice: 0,
      reason: 'insufficient-funds',
    });
    const removed = accepted(
      applyAction(state, {type: 'remove', id: 'building-1'}, state.revision),
    );

    expect(removed.life.deliveries).toEqual([]);
    expect(moneyBalance(removed)).toBe(moneyBalance(state));
    expect(parseRegion(serializeRegion(removed))).toEqual(removed);
  });
  it('cancels unfinished reserved housing without refunding spent construction money', () => {
    const state = fixture();
    const home = state.life.buildings[0]!;

    home.kind = 'residential';
    home.ownerId = 'family-1';
    home.stage = 'constructing';
    home.progressSeconds = 0;
    home.jobs = 0;
    home.cash = 0;
    state.life.economy.constructionPaid = 32000;
    state.life.economy.externalMoney = 32000;
    state.life.families.push({
      id: 'family-1',
      memberIds: ['resident-1'],
      cash: 500,
      homeId: home.id,
      status: 'waiting',
      availableAt: 0,
      carId: null,
      goods: 0,
      lastShopDay: -1,
      reason: 'constructing',
    });
    state.life.people.push({
      id: 'resident-1',
      familyId: 'family-1',
      name: 'A',
      age: 30,
      qualification: 0,
      jobId: null,
      placeId: null,
      tripId: null,
      activity: 'outside',
      reason: 'waiting-home',
      workedSeconds: 0,
      wageSeconds: 0,
    });
    const result = accepted(
      applyAction(state, {type: 'remove', id: home.id}, state.revision),
    );

    expect(result.life.families[0]).toMatchObject({
      homeId: null,
      reason: 'waiting-home',
      cash: 500,
    });
    expect(result.life.economy.constructionPaid).toBe(32000);
    expect(result.life.economy.externalMoney).toBe(32000);
    expect(moneyBalance(result)).toBe(moneyBalance(state));
    expect(parseRegion(serializeRegion(result))).toEqual(result);
  });
  it('blocks occupied homes, workplaces, parked cars, trips and unsettled deliveries', () => {
    const changes: Array<(state: MutableRegion) => void> = [
      state => {
        state.life.families.push({
          id: 'family-1',
          memberIds: ['resident-1'],
          cash: 0,
          homeId: 'building-1',
          status: 'arriving',
          availableAt: 0,
          carId: null,
          goods: 0,
          lastShopDay: -1,
          reason: null,
        });
      },
      state => {
        state.life.people.push({
          ...movingFixture().life.people[0]!,
          placeId: null,
          tripId: null,
        });
      },
      state => {
        state.life.people.push({
          ...movingFixture().life.people[0]!,
          jobId: null,
          placeId: 'building-1',
          tripId: null,
        });
      },
      state => {
        state.life.cars.push({
          id: 'car-2',
          familyId: 'family-1',
          parkedAt: 'building-1',
          parkingSlot: 0,
          driverId: null,
          tripId: null,
          trafficIndex: 0,
        });
      },
      state => {
        state.life.trips.push(movingFixture().life.trips[0]!);
      },
      state => {
        state.life.deliveries.push({
          id: 'delivery-2',
          sourceId: null,
          targetId: 'building-1',
          quantity: 1,
          cargo: 0,
          state: 'loading',
          tripId: null,
          phaseSeconds: 0,
          unitPrice: 0,
          reason: null,
        });
      },
    ];

    for (const occupy of changes) {
      const state = fixture();

      occupy(state);
      const before = structuredClone(state);

      expect(
        applyAction(state, {type: 'remove', id: 'building-1'}, state.revision),
      ).toEqual({ok: false, state, reason: 'occupied-building'});
      expect(state).toEqual(before);
    }
  });
  it('closes a travelled road, persists its route, then removes it only after arrival', () => {
    const state = movingFixture();
    const before = structuredClone(state);
    const closed = accepted(
      applyAction(state, {type: 'remove', id: 'road-2'}, state.revision),
    );

    expect(closed.roads).toEqual(state.roads);
    expect(closed.life.closingRoadIds).toEqual(['road-2']);
    expect(closed.roadRevision).toBe(state.roadRevision + 1);
    expect(closed.parcels[0]!.access).toBeNull();
    expect(closed.life.trips).toEqual(state.life.trips);
    expect(state).toEqual(before);
    const loaded: MutableRegion = {...parseRegion(serializeRegion(closed))};

    finishRoadClosures(loaded);
    expect(loaded.roads).toHaveLength(1);
    loaded.life.trips = [];
    loaded.life.people[0]!.tripId = null;
    loaded.life.people[0]!.placeId = 'building-1';
    loaded.life.people[0]!.activity = 'work';
    finishRoadClosures(loaded);
    expect(loaded.roads).toEqual([]);
    expect(loaded.externalEntries).toEqual([]);
    expect(loaded.life.closingRoadIds).toEqual([]);
    expect(loaded.life.people[0]!.id).toBe('resident-1');
    expect(moneyBalance(loaded)).toBe(moneyBalance(closed));
    expect(parseRegion(serializeRegion(loaded))).toEqual(loaded);
  });
  it('removes idle entries and their completed delivery history without touching private balances', () => {
    const state = fixture();

    state.life.nextId = 3;
    state.life.deliveries.push({
      id: 'delivery-2',
      sourceId: 'entry-4',
      targetId: 'building-1',
      quantity: 1,
      cargo: 0,
      state: 'delivered',
      tripId: null,
      phaseSeconds: 0,
      unitPrice: 20,
      reason: null,
    });
    const removed = accepted(
      applyAction(state, {type: 'remove', id: 'entry-4'}, state.revision),
    );

    expect(removed.externalEntries).toEqual([]);
    expect(removed.life.deliveries).toEqual([]);
    expect(removed.life.buildings).toEqual(state.life.buildings);
    expect(moneyBalance(removed)).toBe(moneyBalance(state));
    expect(parseRegion(serializeRegion(removed))).toEqual(removed);
  });
  it('does not strand staged cars or loaded orders by closing their entry', () => {
    const carState = fixture();

    carState.life.cars.push({
      id: 'car-2',
      familyId: 'family-1',
      parkedAt: 'entry-4',
      parkingSlot: 0,
      driverId: null,
      tripId: null,
      trafficIndex: 0,
    });
    const cargoState = fixture();

    cargoState.life.deliveries.push({
      id: 'delivery-2',
      sourceId: 'entry-4',
      targetId: 'building-1',
      quantity: 4,
      cargo: 4,
      state: 'loading',
      tripId: null,
      phaseSeconds: 2,
      unitPrice: 20,
      reason: null,
    });

    for (const state of [carState, cargoState]) {
      for (const id of ['entry-4', 'road-2']) {
        expect(
          applyAction(state, {type: 'remove', id}, state.revision),
        ).toEqual({ok: false, state, reason: 'busy-entry'});
      }
    }

    const walking = movingFixture();

    expect(
      applyAction(walking, {type: 'remove', id: 'entry-4'}, walking.revision),
    ).toEqual({ok: false, state: walking, reason: 'busy-entry'});
  });
});
