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
