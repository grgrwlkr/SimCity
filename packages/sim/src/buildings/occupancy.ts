// Port of crates/simcity_sim/src/game/buildings/occupancy.rs: how full a building gets from demand, and
// how fast it fills (GDD 10.3.5).
import { zoneDemand } from '../demand';
import { expF64, powIntF32, sqrtF32 } from '../math';
import type { World } from '../world';
import { anyFootprintTile, buildingArea, hasAdjacentRoad, isOperational, isZonedKind } from './building';

const f32 = Math.fround;

/** Demand at which occupancy pressure is one half (GDD 10.3.5.1). */
export const OCCUPANCY_D_MID = f32(0.3);
/** Steepness of the occupancy pressure curve (GDD 10.3.5.1). */
export const OCCUPANCY_K = 6;

/** pressure(d) = 1 / (1 + e^(−k(d − d_mid))). */
export function calculatePressure(demand: number, dMid: number, k: number): number {
  const arg = f32(f32(-k) * f32(demand - dMid));
  return f32(1 / f32(1 + f32(expF64(arg))));
}

/** target_ratio = clamp(2 × pressure, 0, 1) (GDD 10.3.5.2). */
export function calculateTargetRatio(pressure: number): number {
  return Math.min(Math.max(f32(2 * pressure), 0), 1);
}

/** fill_days = base(level) × √(area / 9) × (0.5 / max(0.05, pressure))³, held to 1..=60 (GDD 10.3.5.3). */
export function calculateFillDays(level: number, area: number, pressure: number): number {
  const base = level === 2 ? 2 : level === 3 ? f32(3.5) : 1;
  const mid = f32(base * sqrtF32(f32(area / 9)));
  const days = f32(mid * powIntF32(f32(0.5 / Math.max(pressure, f32(0.05))), 3));
  return Math.min(Math.max(days, 1), 60);
}

/**
 * How many occupants a building can be expected to hold `daysOpen` days after it opened: its target,
 * reached at the pace occupancy fills. A new building is not unhappy for being empty before it had the days.
 */
export function expectedOccupancy(target: number, level: number, area: number, demand: number, daysOpen: number): number {
  const pressure = calculatePressure(demand, OCCUPANCY_D_MID, OCCUPANCY_K);
  const fillDays = calculateFillDays(level, area, pressure);
  // Occupancy moves by at least one head a day, as `updateOccupancy` steps it.
  const perDay = Math.max(Math.ceil(f32(target / Math.max(fillDays, 1))), 1);
  return Math.min(f32(perDay * daysOpen), target);
}

function stepTowards(current: number, target: number, changePerDay: number): number {
  if (current < target) {
    const step = Math.max(Math.ceil(f32(target * changePerDay)), 1);
    return Math.round(Math.min(f32(current + step), target));
  }
  if (current > target) {
    // Scaled by the current headcount, so a building does not stall near empty.
    const step = Math.max(Math.ceil(f32(current * changePerDay)), 1);
    return Math.round(Math.max(f32(current - step), target));
  }
  return current;
}

/** `update_occupancy`, once per advanced day: operational buildings move towards the occupancy demand gives them. */
export function updateOccupancy(w: World): void {
  const grid = w.grid;
  for (let day = 0; day < w.events.dayAdvanced.length; day++) {
    for (const b of w.buildings.all()) {
      if (!isOperational(b)) continue;
      // GDD 10.5.1: a building without road access cannot function, and a zoned one without power empties the same way.
      const roadAccess = anyFootprintTile(b.anchor, b.width, b.length, (tile) => hasAdjacentRoad(grid, tile));
      const power = !isZonedKind(b.kind) || w.utilityNetwork.footprintHas(grid, b.anchor, b.width, b.length, 'Power');
      if (!roadAccess || !power) {
        b.targetOccupancyResidents = 0;
        b.targetOccupancyJobs = 0;
        b.occupancyResidents = Math.max(b.occupancyResidents - 1, 0);
        b.occupancyJobs = Math.max(b.occupancyJobs - 1, 0);
        continue;
      }
      const pressure = calculatePressure(zoneDemand(w.rciDemand, b.kind), OCCUPANCY_D_MID, OCCUPANCY_K);
      const ratio = calculateTargetRatio(pressure);
      b.targetOccupancyResidents = Math.round(f32(b.capacityResidents * ratio));
      b.targetOccupancyJobs = Math.round(f32(b.capacityJobs * ratio));
      const changePerDay = f32(1 / Math.max(calculateFillDays(b.level, buildingArea(b), pressure), 1));
      b.occupancyResidents = stepTowards(b.occupancyResidents, b.targetOccupancyResidents, changePerDay);
      b.occupancyJobs = stepTowards(b.occupancyJobs, b.targetOccupancyJobs, changePerDay);
    }
  }
}
