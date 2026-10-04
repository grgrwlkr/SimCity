import {applyAction} from '../../../../packages/app/src/region/model/commands';
import type {
  RegionAction,
  RegionState,
} from '../../../../packages/app/src/region/model/types';
import {
  accepted,
  flatFixture,
} from '../../../../packages/app/test/helpers/regionFixture';

export function regionalLayout(): RegionState {
  let state = flatFixture();
  const apply = (action: RegionAction): void => {
    state = accepted(applyAction(state, action, state.revision));
  };

  apply({type: 'found', name: 'Север', center: {x: -600, z: -400}});
  apply({type: 'found', name: 'Юг', center: {x: 0, z: -400}});
  const first = state.settlements[0]!.id;
  const second = state.settlements[1]!.id;

  apply({
    type: 'road',
    points: [
      {x: -2000, z: -352},
      {x: -664, z: -352},
    ],
  });
  const entryRoad = state.roads.at(-1)!.id;

  apply({type: 'external-entry', roadId: entryRoad, endpoint: 'start'});
  apply({
    type: 'road',
    points: [
      {x: -536, z: -352},
      {x: -64, z: -352},
    ],
  });
  apply({
    type: 'road',
    points: [
      {x: 64, z: -352},
      {x: 245, z: -352},
    ],
  });
  apply({
    type: 'zone',
    settlementId: first,
    kind: 'residential',
    selection: {minX: -790, maxX: -668, minZ: -344, maxZ: -315},
  });
  apply({
    type: 'zone',
    settlementId: first,
    kind: 'commercial',
    selection: {minX: -515, maxX: -385, minZ: -344, maxZ: -315},
  });
  apply({
    type: 'zone',
    settlementId: second,
    kind: 'industrial',
    selection: {minX: 75, maxX: 235, minZ: -344, maxZ: -315},
  });
  apply({type: 'warehouse', settlementId: first, center: {x: -460, z: -376}});

  return state;
}
