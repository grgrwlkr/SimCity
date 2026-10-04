import {LIFE_RULES} from './rules';
import type {LifeRegion} from './types';

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
