import {describe, expect, it} from 'vitest';
import {CityLife} from '../src/city/life/world';
import {growthFixture} from './helpers/growthFixture';

describe('native world growth facts', () => {
  it('reports blocked arrivals and free housing in an authored world without an entry', () => {
    const world = CityLife.fromDefinition(growthFixture());
    const {growth} = world.frame(null);

    expect(growth.arrivalBlock).toBe('нет внешнего въезда');
    expect(growth.totalHousing).toBeGreaterThan(0);
    expect(growth.freeHousing).toBe(growth.totalHousing);
    expect(growth.totalJobs).toBeGreaterThan(0);
    expect(growth.freeJobs).toBe(growth.totalJobs);
    expect(growth.unemployed).toBe(0);
    expect(growth.nextArrivalIn).toBeGreaterThanOrEqual(0);
    expect(growth.towns['north']).toMatchObject({
      families: 0,
      residents: 0,
      employed: 0,
      freeHousing: 1,
      freeJobs: 0,
    });
    expect(growth.towns['south']).toMatchObject({
      families: 0,
      residents: 0,
      employed: 0,
      freeHousing: 0,
      freeJobs: 8,
    });
  });

  it('charges declared road upkeep once per authored day and keeps the prototype exempt', () => {
    const authored = CityLife.fromDefinition(growthFixture());
    const facts = authored.frame(null).growth;

    // One 350 m road, no warehouses: 0.35 km × 100 ◈.
    expect(facts.upkeepPerDay).toBe(35);

    const before = authored.frame(null).treasury ?? 0;
    const startDay = authored.frame(null).day;

    for (let step = 0; step < 200; step++) {
      authored.advance(300);

      if (authored.frame(null).day !== startDay) {
        break;
      }
    }

    const after = authored.frame(null).treasury ?? 0;

    expect(before - after).toBe(35);

    const prototype = new CityLife('689856');
    const prototypeBefore = prototype.frame(null).treasury ?? 0;
    const prototypeDay = prototype.frame(null).day;

    for (let step = 0; step < 200; step++) {
      prototype.advance(300);

      if (prototype.frame(null).day !== prototypeDay) {
        break;
      }
    }

    const prototypeAfter = prototype.frame(null).treasury ?? 0;

    expect(prototypeAfter).toBe(prototypeBefore);
    expect(prototype.frame(null).growth.upkeepPerDay).toBe(0);
  }, 120_000);

  it('applies a player tax rate through the definition and keeps it in the economy save', () => {
    const world = CityLife.fromDefinition(growthFixture());

    expect(world.frame(null).growth.taxRate).toBe(0.1);

    world.applyDefinitionUpdate({
      ...growthFixture(),
      economy: {rules: {taxRate: 0.2}},
    });
    expect(world.frame(null).growth.taxRate).toBe(0.2);

    const saved = world.save();

    if (saved.version !== 3) {
      throw new Error('Expected the authored native save');
    }

    expect(saved.economy?.taxRate).toBe(0.2);

    const restored = CityLife.fromSave(
      JSON.parse(JSON.stringify(saved)),
      saved.definition,
    );

    expect(restored.frame(null).growth.taxRate).toBe(0.2);
  });

  it('keeps the prototype world free of town buckets while housing counts stay real', () => {
    const world = new CityLife('689856');
    const {growth} = world.frame(null);

    expect(growth.towns).toEqual({});
    expect(growth.arrivalBlock).toBeNull();
    expect(growth.totalHousing).toBeGreaterThan(0);
    expect(growth.totalJobs).toBeGreaterThan(0);
    expect(growth.freeHousing).toBeLessThan(growth.totalHousing);
  });
});
