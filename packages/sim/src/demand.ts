// `RciDemand` of crates/simcity_sim/src/game/demand.rs: signed demand per zone in [-1, 1], positive meaning
// build more. Computed from stage 3b on; until then scenarios and tests set it.
import type { BuildingKind } from './commands';

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
