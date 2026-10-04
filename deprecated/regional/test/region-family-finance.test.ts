import {describe, expect, it} from 'vitest';
import {stepDevelopment} from '../src/model/life/development';
import {
  buyHouseholdGoods,
  moneyBalance,
  stepEconomy,
} from '../src/model/life/economy';
import {RegionMobility} from '../src/model/life/mobility';
import {stepResidents} from '../src/model/life/residents';
import {
  parseRegion,
  serializeRegion,
} from '../../../packages/app/src/region/model/save';
import {LIFE_RULES} from '../../../packages/app/src/region/model/life/rules';
import type {MutableRegion} from '../../../packages/app/src/region/model/life/types';
import {regionalLayout} from './helpers/regionLifeFixture';

function developed(): MutableRegion {
  const state: MutableRegion = regionalLayout();

  for (let second = 1; second <= 2800; second++) {
    state.life.elapsedSeconds = second;
    stepDevelopment(state);
  }

  return state;
}

describe('family expense history', () => {
  it('records actual construction, shopping and wages without changing the money balance', () => {
    const state = developed();
    const family = state.life.families[0]!;

    expect(family.finance?.construction).toBe(32_000);
    expect(family.finance?.sinceSeconds).toBe(0);
    const person = state.life.people.find(
      value => value.familyId === family.id,
    )!;
    const shop = state.life.buildings.find(
      value => value.kind === 'commercial',
    )!;

    family.status = 'settled';
    person.activity = 'shopping';
    person.placeId = shop.id;
    shop.inventory = 4;
    const initial = moneyBalance(state);

    expect(buyHouseholdGoods(state, family.id, shop.id)).toBe(4);
    expect(family.finance?.goods).toBe(4 * LIFE_RULES.retailPrice);
    expect(buyHouseholdGoods(state, family.id, shop.id)).toBe(0);
    expect(family.finance?.goods).toBe(4 * LIFE_RULES.retailPrice);
    person.jobId = shop.id;
    person.activity = 'work';
    person.wageSeconds =
      LIFE_RULES.wagePeriodSeconds - LIFE_RULES.secondsPerMinute;
    state.life.elapsedSeconds = 2820;
    stepEconomy(state);
    expect(family.finance?.wages).toBe(LIFE_RULES.wagePerPeriod);
    expect(moneyBalance(state)).toBe(initial);
  });
  it('preserves optional history through saves and starts old-family history at the first actual transaction', () => {
    const state = developed();
    const first = state.life.families[0]!;
    const roundtrip = parseRegion(serializeRegion(state));

    expect(roundtrip.life.families[0]!.finance).toEqual(first.finance);
    delete first.finance;
    const legacy = parseRegion(serializeRegion(state));

    expect(legacy.life.families[0]!).not.toHaveProperty('finance');
    const family = legacy.life.families[0]!;
    const person = legacy.life.people.find(
      value => value.familyId === family.id,
    )!;
    const shop = legacy.life.buildings.find(
      value => value.kind === 'commercial',
    )!;

    family.status = 'settled';
    person.activity = 'shopping';
    person.placeId = shop.id;
    expect(buyHouseholdGoods(legacy, family.id, shop.id)).toBe(0);
    expect(family).not.toHaveProperty('finance');
    shop.inventory = 1;
    expect(buyHouseholdGoods(legacy, family.id, shop.id)).toBe(1);
    expect(family.finance).toEqual({
      sinceSeconds: legacy.life.elapsedSeconds,
      construction: 0,
      goods: LIFE_RULES.retailPrice,
      travel: 0,
      wages: 0,
    });
    const invalid = JSON.parse(serializeRegion(state)) as {
      state: {life: {families: Array<{finance?: unknown}>}};
    };

    invalid.state.life.families[0]!.finance = {
      sinceSeconds: 0,
      construction: -1,
      goods: 0,
      travel: 0,
      wages: 0,
    };
    expect(() => parseRegion(invalid)).toThrow();
  });
  it('records travel only when an actual arrival starts, without charging a waiting retry', () => {
    const state = developed();

    state.life.elapsedSeconds = 2820;
    const initial = moneyBalance(state);
    const mobility = new RegionMobility(state);

    stepResidents(state, mobility);
    const family = state.life.families.find(
      value => value.status === 'arriving',
    )!;

    expect(family).toBeDefined();
    expect(family.finance?.travel).toBeGreaterThan(0);
    const travel = family.finance?.travel;

    stepResidents(state, mobility);
    expect(family.finance?.travel).toBe(travel);
    expect(moneyBalance(state)).toBe(initial);
  });
});
