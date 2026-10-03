import {createRegion} from '../../src/region/model/world';
import type {CommandResult, RegionState} from '../../src/region/model/types';

export function flatFixture(): RegionState {
  const state = createRegion('test-region', 'fixture');

  return {
    ...state,
    terrain: {
      ...state.terrain,
      water: [
        [
          {x: 200, z: 200},
          {x: 400, z: 200},
          {x: 400, z: 400},
          {x: 200, z: 400},
        ],
      ],
    },
  };
}

export function accepted(result: CommandResult): RegionState {
  if (!result.ok) {
    throw new Error('Rejected: ' + result.reason);
  }

  return result.state;
}
