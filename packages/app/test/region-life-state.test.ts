import {describe, expect, it} from 'vitest';
import {createRegionalLife} from '../src/region/model/life/state';

describe('regional life state', () => {
  it('starts without residents, firms, cars, goods or undeclared private money', () => {
    const life = createRegionalLife(123_456);

    expect(life.initialized).toBe(false);
    expect(life.elapsedSeconds).toBe(0);
    expect(life.remainderSeconds).toBe(0);
    expect(life.families).toEqual([]);
    expect(life.people).toEqual([]);
    expect(life.investors).toEqual([]);
    expect(life.buildings).toEqual([]);
    expect(life.cars).toEqual([]);
    expect(life.trips).toEqual([]);
    expect(life.deliveries).toEqual([]);
    expect(life.economy.initialMoney).toBe(123_456);
    expect(life.economy.externalMoney).toBe(0);
    expect(life.economy.initialGoods).toBe(0);
  });
  it('owns independent collections for independent regions', () => {
    const first = createRegionalLife(1000);
    const second = createRegionalLife(1000);

    first.junctionKeys.push('junction');
    first.economy.externalMoney += 10;
    expect(second.junctionKeys).toEqual([]);
    expect(second.economy.externalMoney).toBe(0);
  });
});
