// Port of crates/simcity_sim/src/game/buildings/upgrade.rs: on the upgrade clock, a building nothing holds back rises a level by chance.
import { rangeF64 } from '../rng';
import type { World } from '../world';
import { upgradeBlocker } from './blockers';
import { buildingArea, profileCapacity } from './building';

/** One kind of event is one feed line: neither the zone nor the level enters it. */
export const UPGRADE_NOTICE = 'Building upgraded';
/** Chance a building nothing holds back rises on one check. */
const UPGRADE_CHANCE = 0.05;

/** `upgrade_buildings` (SimStep::Buildings, after growth). */
export function upgradeBuildings(w: World, dtNs: number): void {
  const clock = w.buildingUpgradeClock;
  clock.tick(dtNs);
  if (clock.timesFinishedThisTick === 0) return;
  for (const b of w.buildings.all()) {
    if (upgradeBlocker(b, w.grid, w.utilityNetwork, w.rciDemand, w.cityFields) !== null) continue;
    if (rangeF64(w.growthRng, 0, 1) > UPGRADE_CHANCE) continue;
    b.level += 1;
    [b.capacityResidents, b.capacityJobs] = profileCapacity(b.kind, b.level, buildingArea(b), b.profile);
    w.notifications.addAt(UPGRADE_NOTICE, 'Info', 3, b.anchor);
  }
}
