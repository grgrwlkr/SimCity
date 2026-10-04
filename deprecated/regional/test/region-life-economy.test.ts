import {describe, expect, it} from 'vitest';
import {createRegionalLife} from '../../../packages/app/src/region/model/life/state';
import {
  goodsBalance,
  moneyBalance,
  buyHouseholdGoods,
  payBuildingSale,
  stepEconomy,
} from '../src/model/life/economy';
import type {
  MutableRegion,
  RegionalBuilding,
} from '../../../packages/app/src/region/model/life/types';
import {flatFixture} from '../../../packages/app/test/helpers/regionFixture';

function fixture(): MutableRegion {
  const state = flatFixture();
  const life = createRegionalLife(state.cash + 1300);

  life.initialized = true;
  life.families.push({
    id: 'family-1',
    memberIds: ['person-1'],
    cash: 300,
    homeId: 'home',
    status: 'settled',
    availableAt: 0,
    carId: null,
    goods: 0,
    lastShopDay: -1,
    reason: null,
  });
  life.people.push({
    id: 'person-1',
    familyId: 'family-1',
    name: 'Анна',
    age: 30,
    qualification: 1,
    jobId: 'factory',
    placeId: 'factory',
    tripId: null,
    activity: 'work',
    reason: null,
    workedSeconds: 0,
    wageSeconds: 0,
  });
  const building = (
    id: string,
    kind: RegionalBuilding['kind'],
  ): RegionalBuilding => ({
    id,
    lotId: id,
    settlementId: 'settlement-1',
    kind,
    ownerId: 'investor-1',
    stage: 'ready',
    startedAt: 0,
    progressSeconds: 60,
    durationSeconds: 60,
    capacity: 0,
    jobs: 8,
    qualification: 0,
    parking: 2,
    inventory: 0,
    inventoryCapacity: 96,
    cash: 500,
    productionWork: 0,
  });

  life.buildings.push(
    building('factory', 'industrial'),
    building('shop', 'commercial'),
  );

  return {...state, schemaVersion: 3, life};
}

describe('regional goods and money', () => {
  it('produces only with workers and pays explicit wages and production costs', () => {
    const state = fixture();
    const initial = moneyBalance(state);

    for (let minute = 1; minute <= 96; minute++) {
      state.life.elapsedSeconds = minute * 60;
      stepEconomy(state);
    }

    expect(state.life.buildings[0]!.inventory).toBe(1);
    expect(state.life.economy.produced).toBe(1);
    expect(state.life.economy.wagesPaid).toBe(18);
    expect(state.life.families[0]!.cash).toBe(318);
    expect(moneyBalance(state)).toBe(initial);
    expect(goodsBalance(state)).toBe(0);
    state.life.people[0]!.activity = 'home';

    for (let minute = 97; minute <= 200; minute++) {
      state.life.elapsedSeconds = minute * 60;
      stepEconomy(state);
    }

    expect(state.life.economy.produced).toBe(1);
  });
  it('purchases only real shop stock and taxes paid revenue', () => {
    const state = fixture();
    const shop = state.life.buildings[1]!;

    shop.inventory = 2;
    state.life.economy.initialGoods = 2;
    const initial = moneyBalance(state);

    expect(buyHouseholdGoods(state, 'family-1', 'shop')).toBe(0);
    state.life.people[0]!.placeId = 'shop';
    state.life.people[0]!.activity = 'shopping';
    expect(buyHouseholdGoods(state, 'family-1', 'shop')).toBe(1);
    expect(state.life.families[0]!.goods).toBe(1);
    expect(shop.inventory).toBe(1);
    expect(state.life.economy.taxesPaid).toBe(7);
    expect(state.life.families[0]!.cash).toBe(230);
    expect(moneyBalance(state)).toBe(initial);
    expect(goodsBalance(state)).toBe(2);
    state.life.families[0]!.cash = 0;
    expect(buyHouseholdGoods(state, 'family-1', 'shop')).toBe(0);
    expect(shop.inventory).toBe(1);
  });
  it('records an unpaid obligation instead of silently overdrawing the treasury', () => {
    const state = fixture();

    state.cash = 10;
    state.roads = [
      {
        id: 'road-1',
        points: [
          {x: 0, z: 0},
          {x: 1000, z: 0},
        ],
      },
    ];
    state.life.elapsedSeconds = 86400 - 21600;
    stepEconomy(state);
    expect(state.cash).toBeGreaterThanOrEqual(0);
    expect(state.life.economy.maintenancePaid).toBe(10);
    expect(state.life.economy.maintenanceDebt).toBe(90);
    expect(state.life.economy.externalMoney).toBe(10);
  });
  it('charges only an affordable sale and conserves both counterparties', () => {
    const state = fixture();
    const [factory, shop] = state.life.buildings;
    const initial = moneyBalance(state);

    expect(payBuildingSale(state, shop!.id, factory!.id, 600)).toBe(false);
    expect(moneyBalance(state)).toBe(initial);
    expect(payBuildingSale(state, shop!.id, factory!.id, 100)).toBe(true);
    expect(shop!.cash).toBe(400);
    expect(factory!.cash).toBe(590);
    expect(state.life.economy.taxesPaid).toBe(10);
    expect(moneyBalance(state)).toBe(initial);
  });
});
