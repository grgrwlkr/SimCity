import {createRegionalLife} from './life/state';
import {REGION_RULES} from './rules';
import {generateTerrain} from './terrain';
import type {RegionRules, RegionState} from './types';

export function createRegion(
  id: string,
  seed: string,
  rules: RegionRules = REGION_RULES,
): RegionState {
  return {
    schemaVersion: 3,
    life: createRegionalLife(rules.startingCash),
    id,
    seed,
    terrain: generateTerrain(seed, 4000),
    rules: {...rules},
    revision: 0,
    roadRevision: 0,
    nextId: 1,
    cash: rules.startingCash,
    settlements: [],
    roads: [],
    parcels: [],
    warehouses: [],
    externalEntries: [],
  };
}
