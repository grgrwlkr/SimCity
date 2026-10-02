// Port of the tests in crates/simcity_sim/src/game/demand.rs. Four of them did their arithmetic inside the test body;
// here those formulas are functions of demand.ts and the tests call them.
import { describe, expect, it } from 'vitest';
import {
  classGapShift,
  commercialDensityBonus,
  commuteBonus,
  computeRciDemand,
  emptyDemand,
  industrialSaturation,
  landValuePenalty,
  taxDemandShift,
} from '../src/demand';
import { DEFAULT_TAX_PERCENT, TaxRates } from '../src/economy/economy';
import { MapGrid } from '../src/map/grid';
import { worldOn } from './buildings/helpers';

const f32 = Math.fround;

/** Demand of a city of a thousand people with no buildings, at `rates`. */
function demandWith(rates: TaxRates) {
  const w = worldOn(new MapGrid(16, 16));
  w.city.population = 1000;
  w.taxRates = rates;
  computeRciDemand(w);
  return { zone: { ...w.rciDemand }, byClass: w.classDemand };
}

describe('rci demand', () => {
  it('zoneDensityClassDemandFollowsEachClassJobGap', () => {
    expect(classGapShift('Residential', 10, 30), 'jobs without workers call for homes of that class').toBeGreaterThan(0);
    expect(classGapShift('Commercial', 10, 30)).toBeLessThan(0);
    expect(classGapShift('Industrial', 30, 10), 'workers without jobs call for workplaces of that class').toBeGreaterThan(0);
    expect(classGapShift('Residential', 30, 10)).toBeLessThan(0);
    expect(classGapShift('Residential', 20, 20)).toBe(0);
    expect(classGapShift('Commercial', 0, 0)).toBe(0);
  });

  it('rciDemandDefaultToZero', () => {
    expect(emptyDemand()).toEqual({ residential: 0, commercial: 0, industrial: 0 });
  });

  it('commuteBonusCalculatedCorrectly', () => {
    expect(commuteBonus(f32(0.1)), 'low congestion gives a bonus').toBeGreaterThan(0);
    expect(commuteBonus(f32(0.1))).toBeLessThanOrEqual(0.28);
    expect(commuteBonus(f32(0.8)), 'high congestion gives none').toBe(0);
  });

  it('landValuePenaltyCalculatedCorrectly', () => {
    expect(landValuePenalty(0.5), 'middling land costs nothing').toBe(0);
    expect(landValuePenalty(f32(0.8)), 'dear land slows growth').toBeGreaterThan(0);
  });

  it('densityBonusCappedCorrectly', () => {
    expect(commercialDensityBonus(5)).toBe(0.5);
    expect(commercialDensityBonus(100), 'capped at one half').toBe(0.5);
  });

  it('commercialDemandBootstrapsFromPopulationWithZeroShops', () => {
    // Residents are customers before any shop exists: a zero base would pin commercial demand at zero for good.
    const w = worldOn(new MapGrid(16, 16));
    w.city.population = 1000;
    computeRciDemand(w);
    expect(w.rciDemand.commercial, `a populated city with no shops wants them, got ${w.rciDemand.commercial}`).toBeGreaterThan(0);
  });

  it('pollutionSaturationCappedCorrectly', () => {
    expect(industrialSaturation(5)).toBeLessThan(f32(0.3));
    expect(industrialSaturation(100), 'capped').toBe(f32(0.3));
  });

  it('taxRateDemandShiftIsNeutralAtTheDefaultRate', () => {
    expect(taxDemandShift(DEFAULT_TAX_PERCENT)).toBe(0);
    expect(Math.abs(taxDemandShift(20) + 0.44)).toBeLessThan(1e-5);
    expect(Math.abs(taxDemandShift(0) - 0.18)).toBeLessThan(1e-5);
    expect(taxDemandShift(10)).toBeLessThan(0);
    expect(taxDemandShift(8)).toBeGreaterThan(0);
  });

  it('taxRateRaisingARateLowersThatZoneAndClassDemand', () => {
    const base = demandWith(new TaxRates());
    expect(base.byClass.get('Residential', 'Middle'), 'at the default rates every class wants what its zone wants').toBe(base.zone.residential);

    const rates = new TaxRates();
    rates.set('Residential', 'High', 20);
    const taxed = demandWith(rates);

    expect(taxed.zone.residential, `residential demand falls measurably: ${base.zone.residential} → ${taxed.zone.residential}`).toBeLessThan(
      base.zone.residential - 0.1,
    );
    expect(taxed.zone.commercial, 'other zones keep their demand').toBe(base.zone.commercial);
    expect(taxed.zone.industrial).toBe(base.zone.industrial);
    expect(taxed.byClass.get('Residential', 'High'), 'the taxed class falls hardest').toBeLessThan(base.byClass.get('Residential', 'High') - 0.4);
    expect(taxed.byClass.get('Residential', 'Low'), 'other classes keep their demand').toBe(base.byClass.get('Residential', 'Low'));
  });
});
