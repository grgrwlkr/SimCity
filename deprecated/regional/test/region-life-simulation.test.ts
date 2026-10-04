import {describe, expect, it} from 'vitest';
import {advanceRegion} from '../src/model/life/simulation';
import {goodsBalance, moneyBalance} from '../src/model/life/economy';
import {regionalPopulation} from '../src/model/life/residents';
import {
  parseRegion,
  serializeRegion,
} from '../../../packages/app/src/region/model/save';
import {createRegion} from '../../../packages/app/src/region/model/world';
import {regionalLayout} from './helpers/regionLifeFixture';

describe('regional simulation', () => {
  it('keeps zero population without an entry and uses a persisted fixed-step remainder', () => {
    const state = createRegion('empty', '689856');
    const advanced = advanceRegion(state, 20.4);

    expect(state.life.elapsedSeconds).toBe(0);
    expect(advanced.life.elapsedSeconds).toBe(20);
    expect(advanced.life.remainderSeconds).toBeCloseTo(0.4, 9);
    expect(regionalPopulation(advanced)).toBe(0);
    expect(advanced.life.buildings).toEqual([]);
    expect(advanceRegion(advanceRegion(state, 0.4), 20)).toEqual(advanced);

    for (const bad of [-1, NaN, Infinity, 604801]) {
      expect(() => advanceRegion(state, bad)).toThrow();
    }

    expect(advanceRegion(state, 0)).toBe(state);
  });
  it('funds, constructs and physically populates two cities with exact save continuation', () => {
    const initial = regionalLayout();
    const once = advanceRegion(initial, 5000.25);
    const midway = advanceRegion(initial, 2800.1);
    const restored = parseRegion(serializeRegion(midway));
    const partitioned = advanceRegion(restored, 2200.15);

    expect(partitioned).toEqual(once);
    expect(regionalPopulation(once)).toBeGreaterThan(0);
    expect(once.life.buildings.some(b => b.stage === 'ready')).toBe(true);
    expect(once.life.completedDeliveries).toBeGreaterThan(0);
    expect(moneyBalance(once)).toBe(once.life.economy.initialMoney);
    expect(goodsBalance(once)).toBe(once.life.economy.initialGoods);
    expect(parseRegion(serializeRegion(once))).toEqual(once);
    expect(initial.life.initialized).toBe(false);
  }, 30000);
  it('runs a working day with intercity employment, real purchases and no stranded journeys', () => {
    const initial = regionalLayout();
    const morning = advanceRegion(initial, 7200);
    const evening = advanceRegion(morning, 43200);
    const buildings = new Map(evening.life.buildings.map(b => [b.id, b]));
    const families = new Map(evening.life.families.map(f => [f.id, f]));
    const intercity = evening.life.people.filter(person => {
      const home = buildings.get(families.get(person.familyId)?.homeId ?? '');
      const work = buildings.get(person.jobId ?? '');

      return home && work && home.settlementId !== work.settlementId;
    });

    expect(intercity.length).toBeGreaterThan(0);
    expect(intercity.some(p => p.workedSeconds > 0)).toBe(true);
    expect(evening.life.economy.wagesPaid).toBeGreaterThan(0);
    expect(evening.life.economy.taxesPaid).toBeGreaterThan(0);
    expect(evening.life.families.some(f => f.goods > 0)).toBe(true);
    expect(
      evening.life.trips.filter(
        t => evening.life.elapsedSeconds - t.startedAt > 7200,
      ),
    ).toEqual([]);
    expect(moneyBalance(evening)).toBe(evening.life.economy.initialMoney);
    expect(goodsBalance(evening)).toBe(evening.life.economy.initialGoods);
    expect(parseRegion(serializeRegion(evening))).toEqual(evening);
  }, 60000);
});
