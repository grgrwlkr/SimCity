// Port of crates/simcity_sim/src/game/demand.rs: signed demand per zone and per wealth class in [-1, 1], positive meaning
// build more. Residential follows jobs against population and the commute, commercial the unmet shopping and the
// density of people, industrial the employment gap; every class is then moved by its tax rate and its own job gap.
import type { BuildingKind } from './commands';
import { DEFAULT_TAX_PERCENT, TAX_ZONES, type TaxZone } from './economy/economy';
import { WEALTH_CLASSES, type WealthClass } from './economy/wealth';
import type { World } from './world';

const f32 = Math.fround;
const clampUnit = (value: number) => Math.min(Math.max(value, -1), 1);
const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

export interface RciDemand {
  residential: number;
  commercial: number;
  industrial: number;
}

export function emptyDemand(): RciDemand {
  return { residential: 0, commercial: 0, industrial: 0 };
}

/** Demand of the zone a building kind grows in; services have none. */
export function zoneDemand(demand: RciDemand, kind: BuildingKind): number {
  switch (kind) {
    case 'Residential':
      return demand.residential;
    case 'Commercial':
      return demand.commercial;
    case 'Industrial':
      return demand.industrial;
    default:
      return 0;
  }
}

/** Demand of every zone and wealth class. */
export class ClassDemand {
  readonly byClass: Record<TaxZone, Record<WealthClass, number>> = {
    Residential: { Low: 0, Middle: 0, High: 0 },
    Commercial: { Low: 0, Middle: 0, High: 0 },
    Industrial: { Low: 0, Middle: 0, High: 0 },
  };

  get(zone: TaxZone, wealth: WealthClass): number {
    return this.byClass[zone][wealth];
  }
}

/** Residents one shop serves: residents are customers before any shop exists, so commercial demand can start from them. */
const COMMERCIAL_RESIDENTS_PER_BUILDING = 40;
const TARGET_EMPLOYMENT_RATE = f32(0.85);

/** How far a tax rate moves demand: nothing at the default rate, down 0.04 a point above it, up 0.02 a point below. */
export function taxDemandShift(percent: number): number {
  const below = DEFAULT_TAX_PERCENT - percent;
  return f32(below * (below > 0 ? f32(0.02) : f32(0.04)));
}

/** How far one class's job gap moves its demand: homes are wanted where it has more jobs than workers, workplaces where it has more workers. */
export function classGapShift(zone: TaxZone, workers: number, jobs: number): number {
  const scale = Math.max(workers, jobs, 1);
  const gap = f32(clampUnit(f32((jobs - workers) / scale)) * f32(0.5));
  return zone === 'Residential' ? gap : f32(0 - gap);
}

/** Up to +0.28 residential demand while roads flow: a short commute makes a place worth living in. */
export function commuteBonus(avgCongestion: number): number {
  return f32(Math.max(f32(f32(0.7) - avgCongestion), 0) * f32(0.4));
}

/** Up to −0.2 residential demand where land is dear on average. */
export function landValuePenalty(avgLandValue: number): number {
  return avgLandValue > f32(0.6) ? Math.min(f32(f32(avgLandValue - f32(0.6)) / f32(0.4)), f32(0.2)) : 0;
}

/** Up to +0.5 on commercial demand for people per home: more customers. */
export function commercialDensityBonus(residentsPerHome: number): number {
  return Math.min(f32(residentsPerHome / 10), f32(0.5));
}

/** Up to −0.3 industrial demand for the industry already there. */
export function industrialSaturation(industrialBuildings: number): number {
  return Math.min(f32(industrialBuildings / 20), f32(0.3));
}

/** Demand of each zone before tax; with nobody in town, homes only, so the city can start. */
function preTaxDemand(w: World): readonly [number, number, number] {
  if (w.city.population === 0) return [1, 0, 0];
  const citizens = f32(Math.max(w.city.population, 1));
  let jobsCapacity = 0;
  let homes = 0;
  let shops = 0;
  let factories = 0;
  for (const b of w.buildings.all()) {
    jobsCapacity = f32(jobsCapacity + b.capacityJobs);
    if (b.kind === 'Residential') homes += 1;
    else if (b.kind === 'Commercial') shops += 1;
    else if (b.kind === 'Industrial') factories += 1;
  }
  const land = w.landValue.values;
  let avgLandValue = f32(0.5);
  if (land.length > 0) {
    let sum = 0;
    for (const value of land) sum = f32(sum + value);
    avgLandValue = f32(sum / land.length);
  }
  const congestion = w.trafficIndex.avgCongestion;
  const unmetShopping = w.shoppingStats.unmetRatio;

  const residentialBase = clampUnit(f32(f32(f32(jobsCapacity / citizens) - 1) * f32(0.5)));
  const residential = clampUnit(f32(f32(residentialBase + commuteBonus(congestion)) - landValuePenalty(avgLandValue)));

  const targetShops = f32(citizens / COMMERCIAL_RESIDENTS_PER_BUILDING);
  const shortfall = clamp01(f32(f32(targetShops - shops) / Math.max(targetShops, 1)));
  const commercialBase = clamp01(Math.max(unmetShopping, shortfall));
  const multiplier = f32(f32(1 + commercialDensityBonus(f32(citizens / (homes + 1)))) + Math.min(f32(factories / 10), f32(0.3)));
  const commercial = clampUnit(f32(f32(commercialBase * multiplier) - f32(congestion * f32(0.3))));

  const industrialBase = clampUnit(f32(f32(TARGET_EMPLOYMENT_RATE - w.employmentStats.employmentRate) / TARGET_EMPLOYMENT_RATE));
  const industrial = clampUnit(f32(f32(industrialBase + f32(unmetShopping * f32(0.4))) - industrialSaturation(factories)));

  return [residential, commercial, industrial];
}

/** `compute_rci_demand` (PostSimStep::Demand): every class by its own rate and job gap, every zone by the mean of its classes' rates. */
export function computeRciDemand(w: World): void {
  const preTax = preTaxDemand(w);
  const employment = w.employmentStats;
  const zone = [0, 0, 0];
  TAX_ZONES.forEach((taxZone, i) => {
    const base = preTax[i]!;
    let shiftSum = 0;
    for (const wealth of WEALTH_CLASSES) {
      const shift = taxDemandShift(w.taxRates.get(taxZone, wealth));
      const gap = classGapShift(taxZone, employment.workersByClass[wealth], employment.jobsByClass[wealth]);
      w.classDemand.byClass[taxZone][wealth] = clampUnit(f32(f32(base + shift) + gap));
      shiftSum = f32(shiftSum + shift);
    }
    zone[i] = clampUnit(f32(base + f32(shiftSum / WEALTH_CLASSES.length)));
  });
  const demand = w.rciDemand;
  demand.residential = zone[0]!;
  demand.commercial = zone[1]!;
  demand.industrial = zone[2]!;
}
