import {roadLength} from '../roads';
import {LIFE_RULES} from './rules';
import type {
  LifeRegion,
  MutableRegion,
  RegionalBuilding,
  RegionalFamily,
  RegionalFamilyFinance,
} from './types';

/** Historical counters mirror completed transfers; they are never additional accounts. */
export function recordFamilyFinance(
  state: LifeRegion,
  family: RegionalFamily,
  category: Exclude<keyof RegionalFamilyFinance, 'sinceSeconds'>,
  value: number,
): void {
  if (value <= 0) {
    return;
  }

  family.finance ??= {
    sinceSeconds: state.life.elapsedSeconds,
    construction: 0,
    goods: 0,
    travel: 0,
    wages: 0,
  };
  family.finance[category] += value;
}

export function moneyBalance(state: LifeRegion): number {
  const life = state.life;

  return (
    state.cash +
    life.economy.externalMoney +
    life.families.reduce((sum, family) => sum + family.cash, 0) +
    life.investors.reduce((sum, investor) => sum + investor.cash, 0) +
    life.buildings.reduce((sum, building) => sum + building.cash, 0)
  );
}

/** Initial stock equals current stock plus consumption minus explicit production. */
export function goodsBalance(state: LifeRegion): number {
  const life = state.life;

  return (
    life.economy.externalGoods +
    life.economy.consumed -
    life.economy.produced +
    life.families.reduce((sum, family) => sum + family.goods, 0) +
    life.buildings.reduce((sum, building) => sum + building.inventory, 0) +
    life.deliveries.reduce((sum, delivery) => sum + delivery.cargo, 0)
  );
}

export function buildingBalance(
  state: LifeRegion,
  building: RegionalBuilding,
): number {
  return building.kind === 'warehouse' ? state.cash : building.cash;
}

export function debitBuilding(
  state: MutableRegion,
  building: RegionalBuilding,
  value: number,
): boolean {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    buildingBalance(state, building) < value
  ) {
    return false;
  }
  if (building.kind === 'warehouse') {
    state.cash -= value;
  } else {
    building.cash -= value;
  }

  return true;
}

function creditBuilding(
  state: MutableRegion,
  building: RegionalBuilding,
  value: number,
): void {
  if (building.kind === 'warehouse') {
    state.cash += value;
  } else {
    building.cash += value;
  }
}

function taxSale(
  state: MutableRegion,
  seller: RegionalBuilding,
  value: number,
): void {
  if (seller.kind === 'commercial' || seller.kind === 'industrial') {
    const tax = Math.floor(value * LIFE_RULES.taxRate);

    seller.cash -= tax;
    state.cash += tax;
    state.life.economy.taxesPaid += tax;
  }

  state.life.economy.salesValue += value;
}

export function payBuildingSale(
  state: MutableRegion,
  buyerId: string,
  sellerId: string,
  value: number,
): boolean {
  const buyer = state.life.buildings.find(building => building.id === buyerId);
  const seller = state.life.buildings.find(
    building => building.id === sellerId,
  );
  const external = state.externalEntries.some(entry => entry.id === sellerId);

  if (
    !buyer ||
    buyerId === sellerId ||
    (!seller && !external) ||
    !debitBuilding(state, buyer, value)
  ) {
    return false;
  }
  if (seller) {
    creditBuilding(state, seller, value);
    taxSale(state, seller, value);
  } else {
    state.life.economy.externalMoney += value;
    state.life.economy.importsPaid += value;
  }

  return true;
}

export function buyHouseholdGoods(
  state: MutableRegion,
  familyId: string,
  shopId: string,
): number {
  const family = state.life.families.find(
    candidate => candidate.id === familyId,
  );
  const shop = state.life.buildings.find(building => building.id === shopId);
  const present = state.life.people.some(
    person =>
      person.familyId === familyId &&
      person.placeId === shopId &&
      person.activity === 'shopping',
  );

  if (
    !family ||
    family.status !== 'settled' ||
    !shop ||
    shop.kind !== 'commercial' ||
    shop.stage !== 'ready' ||
    !present
  ) {
    return 0;
  }

  const quantity = Math.max(
    0,
    Math.min(
      family.memberIds.length - family.goods,
      shop.inventory,
      Math.floor(family.cash / LIFE_RULES.retailPrice),
    ),
  );
  const value = quantity * LIFE_RULES.retailPrice;

  family.cash -= value;
  recordFamilyFinance(state, family, 'goods', value);
  family.goods += quantity;
  shop.cash += value;
  shop.inventory -= quantity;
  taxSale(state, shop, value);

  return quantity;
}

export function gameMinute(state: LifeRegion): number {
  return (
    LIFE_RULES.startingMinute +
    state.life.elapsedSeconds / LIFE_RULES.secondsPerMinute
  );
}

export function gameDay(state: LifeRegion): number {
  return Math.floor(
    gameMinute(state) /
      (LIFE_RULES.secondsPerDay / LIFE_RULES.secondsPerMinute),
  );
}

export function stepEconomy(state: MutableRegion): void {
  const {life} = state;

  if (
    life.elapsedSeconds === 0 ||
    life.elapsedSeconds % LIFE_RULES.secondsPerMinute !== 0
  ) {
    return;
  }

  const families = new Map(life.families.map(family => [family.id, family]));
  const workers = new Map<string, number>();
  const buildings = new Map(
    life.buildings.map(building => [building.id, building]),
  );

  for (const person of life.people) {
    if (
      person.activity !== 'work' ||
      !person.jobId ||
      person.placeId !== person.jobId
    ) {
      continue;
    }

    const employer = buildings.get(person.jobId);
    const family = families.get(person.familyId);

    if (!employer || employer.stage !== 'ready' || !family) {
      continue;
    }

    person.workedSeconds += LIFE_RULES.secondsPerMinute;
    person.wageSeconds += LIFE_RULES.secondsPerMinute;
    workers.set(employer.id, (workers.get(employer.id) ?? 0) + 1);

    while (person.wageSeconds >= LIFE_RULES.wagePeriodSeconds) {
      if (!debitBuilding(state, employer, LIFE_RULES.wagePerPeriod)) {
        person.reason = 'unpaid-wages';
        break;
      }

      person.wageSeconds -= LIFE_RULES.wagePeriodSeconds;
      family.cash += LIFE_RULES.wagePerPeriod;
      recordFamilyFinance(state, family, 'wages', LIFE_RULES.wagePerPeriod);
      life.economy.wagesPaid += LIFE_RULES.wagePerPeriod;
      person.reason = null;
    }
  }

  for (const building of life.buildings) {
    if (building.kind !== 'industrial' || building.stage !== 'ready') {
      continue;
    }
    if (
      building.inventory >= building.inventoryCapacity ||
      building.cash < LIFE_RULES.productionUnitCost
    ) {
      continue;
    }

    building.productionWork +=
      (workers.get(building.id) ?? 0) * LIFE_RULES.secondsPerMinute;

    while (
      building.productionWork >= LIFE_RULES.productionWorkerSeconds &&
      building.inventory < building.inventoryCapacity &&
      building.cash >= LIFE_RULES.productionUnitCost
    ) {
      building.productionWork -= LIFE_RULES.productionWorkerSeconds;
      building.inventory++;
      building.cash -= LIFE_RULES.productionUnitCost;
      life.economy.externalMoney += LIFE_RULES.productionUnitCost;
      life.economy.produced++;
    }

    building.productionWork = Math.min(
      building.productionWork,
      LIFE_RULES.productionWorkerSeconds - 1,
    );
  }

  if (
    (life.elapsedSeconds +
      LIFE_RULES.startingMinute * LIFE_RULES.secondsPerMinute) %
      LIFE_RULES.secondsPerDay ===
    0
  ) {
    for (const family of life.families) {
      if (family.status !== 'settled') {
        continue;
      }

      const used = Math.min(family.memberIds.length, family.goods);

      family.goods -= used;
      life.economy.consumed += used;
      family.reason = used < family.memberIds.length ? 'no-goods' : null;
    }

    const roads = state.roads.reduce(
      (sum, road) => sum + roadLength(road.points),
      0,
    );
    const upkeep =
      Math.ceil((roads / 1000) * LIFE_RULES.roadUpkeepPerKm) +
      state.warehouses.length * LIFE_RULES.warehouseUpkeep;

    life.economy.maintenanceDebt += upkeep;
  }

  const maintenance = Math.min(state.cash, life.economy.maintenanceDebt);

  state.cash -= maintenance;
  life.economy.maintenanceDebt -= maintenance;
  life.economy.externalMoney += maintenance;
  life.economy.maintenancePaid += maintenance;
}
