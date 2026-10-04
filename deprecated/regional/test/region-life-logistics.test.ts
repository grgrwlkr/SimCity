import {describe, expect, it} from 'vitest';
import {completeDelivery, stepLogistics} from '../src/model/life/logistics';
import {goodsBalance, moneyBalance} from '../src/model/life/economy';
import {RegionMobility} from '../src/model/life/mobility';
import {
  parseRegion,
  serializeRegion,
} from '../../../packages/app/src/region/model/save';
import type {
  MutableRegion,
  RegionalBuilding,
  RegionMobilityPort,
} from '../../../packages/app/src/region/model/life/types';
import {flatFixture} from '../../../packages/app/test/helpers/regionFixture';

function fixture(): MutableRegion {
  const base = flatFixture();
  const state: MutableRegion = {
    ...base,
    nextId: 7,
    terrain: {...base.terrain, water: []},
    settlements: [
      {id: 'settlement-1', name: 'Town', center: {x: -300, z: -100}},
    ],
    roads: [
      {
        id: 'road-2',
        points: [
          {x: -2000, z: 0},
          {x: 300, z: 0},
        ],
      },
    ],
    externalEntries: [{id: 'entry-3', roadId: 'road-2', endpoint: 'start'}],
    parcels: [],
  };

  state.life.initialized = true;
  state.life.nextId = 3;
  state.life.investors = [{id: 'investor-1', cash: 0}];
  state.life.economy.externalGoods = 100;

  for (const [i, x] of [-200, 200].entries()) {
    const kind = i === 0 ? 'industrial' : 'commercial';

    state.parcels = [
      ...state.parcels,
      {
        id: `parcel-${4 + i}`,
        settlementId: 'settlement-1',
        center: {x, z: -18},
        heading: 0,
        width: 16,
        depth: 24,
        zone: kind,
        access: {roadId: 'road-2', segment: 0, offset: (x + 2000) / 2300},
      },
    ];
    const building: RegionalBuilding = {
      id: `building-${i + 1}`,
      lotId: `parcel-${4 + i}`,
      settlementId: 'settlement-1',
      kind,
      ownerId: 'investor-1',
      stage: 'ready',
      startedAt: 0,
      progressSeconds: 1,
      durationSeconds: 1,
      capacity: 0,
      jobs: 2,
      qualification: 0,
      parking: 2,
      inventory: i === 0 ? 20 : 0,
      inventoryCapacity: 64,
      cash: 1000,
      productionWork: 0,
    };

    state.life.buildings.push(building);
  }

  state.life.economy.initialMoney = moneyBalance(state);
  state.life.economy.initialGoods = goodsBalance(state);

  return state;
}

function ticks(
  state: MutableRegion,
  mobility: RegionMobilityPort,
  seconds: number,
): void {
  for (let i = 0; i < seconds; i++) {
    state.life.elapsedSeconds++;
    stepLogistics(state, mobility);
  }
}

function conserved(state: MutableRegion): void {
  expect(moneyBalance(state)).toBe(state.life.economy.initialMoney);
  expect(goodsBalance(state)).toBe(state.life.economy.initialGoods);
}

describe('regional physical deliveries', () => {
  it('pays and removes goods once at loading, then waits for physical arrival and unloading', () => {
    const state = fixture();
    const mobility = new RegionMobility(state);
    const [factory, shop] = state.life.buildings;

    ticks(state, mobility, 1);
    const delivery = state.life.deliveries[0]!;

    expect(delivery.state).toBe('loading');
    expect(delivery.cargo).toBe(16);
    expect(factory!.inventory).toBe(4);
    expect(shop!.cash).toBe(508);
    expect(shop!.inventory).toBe(0);
    conserved(state);
    ticks(state, mobility, 30);
    expect(delivery.state).toBe('in-transit');
    expect(shop!.cash).toBe(508);
    expect(shop!.inventory).toBe(0);
    expect(mobility.step(1)).toEqual([]);
    const arrived = mobility.step(240);

    expect(arrived).toHaveLength(1);
    completeDelivery(state, arrived[0]!);
    expect(delivery.state).toBe('unloading');
    expect(shop!.inventory).toBe(0);
    ticks(state, mobility, 29);
    expect(shop!.inventory).toBe(0);
    ticks(state, mobility, 1);
    expect(shop!.inventory).toBe(16);
    expect(delivery.cargo).toBe(0);
    expect(state.life.completedDeliveries).toBe(1);
    completeDelivery(state, arrived[0]!);
    expect(state.life.completedDeliveries).toBe(1);
    conserved(state);
  });
  it('leaves blocked goods at the sender unpaid and holds already loaded cargo during a break', () => {
    const state = fixture();
    const mobility = new RegionMobility(state);

    state.life.closingRoadIds = ['road-2'];
    state.roadRevision++;
    ticks(state, mobility, 40);
    expect(state.life.deliveries).toHaveLength(1);
    expect(state.life.deliveries[0]!.state).toBe('waiting');
    expect(state.life.buildings[0]!.inventory).toBe(20);
    expect(state.life.buildings[1]!.cash).toBe(1000);
    state.life.closingRoadIds = [];
    state.roadRevision++;
    ticks(state, mobility, 1);
    expect(state.life.deliveries[0]!.cargo).toBe(16);
    state.life.closingRoadIds = ['road-2'];
    state.roadRevision++;
    ticks(state, mobility, 60);
    expect(state.life.deliveries[0]!.state).toBe('loading');
    expect(state.life.trips).toHaveLength(0);
    expect(state.life.buildings[1]!.cash).toBe(508);
    state.life.closingRoadIds = [];
    state.roadRevision++;
    ticks(state, mobility, 1);
    expect(state.life.deliveries[0]!.state).toBe('in-transit');
    conserved(state);
  });
  it('imports only affordable finite stock and resumes the same loaded truck from a parsed save', () => {
    const state = fixture();

    state.life.buildings[0]!.inventory = 0;
    state.life.buildings[1]!.cash = 55;
    state.life.economy.externalGoods = 1;
    state.life.economy.initialMoney = moneyBalance(state);
    state.life.economy.initialGoods = goodsBalance(state);
    const mobility = new RegionMobility(state);

    ticks(state, mobility, 31);
    expect(state.life.deliveries[0]!.cargo).toBe(1);
    expect(state.life.deliveries[0]!.sourceId).toBe('entry-3');
    expect(state.life.economy.externalGoods).toBe(0);
    expect(state.life.buildings[1]!.cash).toBe(23);
    mobility.step(10);
    mobility.save();
    const restored: MutableRegion = parseRegion(serializeRegion(state));
    const resumed = new RegionMobility(restored);
    const arrivals = mobility.step(1000);
    const continued = resumed.step(1000);

    for (const trip of arrivals) {
      completeDelivery(state, trip);
    }

    for (const trip of continued) {
      completeDelivery(restored, trip);
    }

    ticks(state, mobility, 30);
    ticks(restored, resumed, 30);
    mobility.save();
    resumed.save();
    expect(restored).toEqual(state);
    expect(state.life.buildings[1]!.inventory).toBe(1);
    conserved(state);
  });
  it('does not overspend, fabricate goods or create duplicate orders', () => {
    const state = fixture();

    state.life.buildings[1]!.cash = 11;
    const mobility = new RegionMobility(state);

    ticks(state, mobility, 100);
    expect(state.life.deliveries).toHaveLength(1);
    expect(state.life.deliveries[0]!.reason).toBe('insufficient-funds');
    expect(state.life.buildings[0]!.inventory).toBe(20);
    expect(state.life.buildings[1]!.cash).toBe(11);
    state.life.buildings[1]!.cash = 1000;
    state.life.buildings[0]!.inventory = 0;
    state.life.economy.externalGoods = 0;
    ticks(state, mobility, 1);
    expect(state.life.deliveries[0]!.reason).toBe('out-of-stock');
    state.externalEntries = [];
    ticks(state, mobility, 1);
    expect(state.life.deliveries[0]!.reason).toBe('no-external-entry');
  });
});

it('reserves source and destination bays through unloading and caps the active fleet', () => {
  const state = fixture();
  const factory = state.life.buildings[0]!;
  const shop = state.life.buildings[1]!;
  const factoryLot = state.parcels[0]!;
  const shopLot = state.parcels[1]!;

  state.life.buildings = [];
  state.parcels = [];
  state.externalEntries = [];
  state.life.nextId = 100;

  for (let i = 0; i < 26; i++) {
    state.life.buildings.push(
      {
        ...factory,
        id: `building-${i * 2 + 1}`,
        lotId: `factory-lot-${i}`,
        inventory: 16,
      },
      {...shop, id: `building-${i * 2 + 2}`, lotId: `shop-lot-${i}`},
    );
    state.parcels = [
      ...state.parcels,
      {
        ...factoryLot,
        id: `factory-lot-${i}`,
        center: {x: -1800 + i * 60, z: -18},
        access: {roadId: 'road-2', segment: 0, offset: (200 + i * 60) / 2300},
      },
      {
        ...shopLot,
        id: `shop-lot-${i}`,
        center: {x: -1800 + i * 60, z: 18},
        access: {roadId: 'road-2', segment: 0, offset: (200 + i * 60) / 2300},
      },
    ];
  }

  state.life.economy.initialMoney = moneyBalance(state);
  state.life.economy.initialGoods = goodsBalance(state);
  const mobility = new RegionMobility(state);

  ticks(state, mobility, 1);
  expect(state.life.deliveries).toHaveLength(26);
  const loaded = state.life.deliveries.filter(
    delivery => delivery.state === 'loading',
  );

  expect(loaded).toHaveLength(24);
  expect(new Set(loaded.map(delivery => delivery.sourceId)).size).toBe(24);
  expect(new Set(loaded.map(delivery => delivery.targetId)).size).toBe(24);
  expect(
    state.life.deliveries.filter(
      delivery => delivery.reason === 'delivery-busy',
    ),
  ).toHaveLength(2);
  conserved(state);
});

it('keeps a supplier bay occupied until the previous truck has unloaded', () => {
  const state = fixture();

  state.externalEntries = [];
  state.life.buildings[0]!.inventory = 60;
  state.life.buildings.push({
    ...state.life.buildings[1]!,
    id: 'building-3',
    lotId: 'parcel-6',
  });
  state.life.nextId = 4;
  state.parcels = [
    ...state.parcels,
    {
      ...state.parcels[1]!,
      id: 'parcel-6',
      center: {x: 100, z: -18},
      access: {roadId: 'road-2', segment: 0, offset: 2100 / 2300},
    },
  ];
  const mobility = new RegionMobility(state);

  ticks(state, mobility, 31);
  expect(state.life.deliveries[0]!.state).toBe('in-transit');
  expect(state.life.deliveries[1]!.state).toBe('waiting');
  const arrivals = mobility.step(240);

  for (const trip of arrivals) {
    completeDelivery(state, trip);
  }

  ticks(state, mobility, 29);
  expect(state.life.deliveries[1]!.state).toBe('waiting');
  expect(state.life.buildings[2]!.cash).toBe(1000);
  ticks(state, mobility, 1);
  expect(state.life.deliveries[1]!.state).toBe('loading');
  expect(state.life.buildings[0]!.inventory).toBe(28);
});

it('uses the regional treasury for warehouse purchases and honours target capacity', () => {
  const state = fixture();
  const warehouse = state.life.buildings[1]!;

  warehouse.kind = 'warehouse';
  warehouse.ownerId = 'region';
  warehouse.cash = 0;
  warehouse.inventoryCapacity = 3;
  state.cash = 1000;
  state.life.economy.initialMoney = moneyBalance(state);
  const mobility = new RegionMobility(state);

  ticks(state, mobility, 1);
  expect(state.life.deliveries[0]!.cargo).toBe(3);
  expect(warehouse.cash).toBe(0);
  // 90 in goods plus 12 carriage, with 9 sales tax returned to the treasury.
  expect(state.cash).toBe(907);
  ticks(state, mobility, 30);

  for (const trip of mobility.step(240)) {
    completeDelivery(state, trip);
  }

  ticks(state, mobility, 30);
  expect(warehouse.inventory).toBe(3);
  ticks(state, mobility, 100);
  expect(state.life.deliveries).toHaveLength(1);
  conserved(state);
});
