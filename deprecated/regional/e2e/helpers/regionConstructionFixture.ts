import {applyRegionalAction} from '../../tools/region-playthrough';
import {zoneCandidates} from '../../../../packages/app/src/region/model/parcels';
import {advanceRegion} from '../../src/model/life/simulation';
import {
  parseRegion,
  serializeRegion,
} from '../../../../packages/app/src/region/model/save';
import {createRegion} from '../../../../packages/app/src/region/model/world';
import type {RegionState} from '../../../../packages/app/src/region/model/types';

/** Untouched seeded terrain and ordinary player commands; only the clock advances. */
export function createConstructionFixture(degrees: number): RegionState {
  let state = createRegion(`construction-${degrees}`, '689856');
  const center = {x: -1300, z: -500};

  state = applyRegionalAction(state, {
    type: 'found',
    name: `Мастерской ${degrees > 0 ? 'Восток' : 'Запад'}`,
    center,
  });
  state = applyRegionalAction(state, {
    type: 'road',
    points: [
      {x: -2000, z: -452},
      {x: -1364, z: -452},
    ],
  });
  state = applyRegionalAction(state, {
    type: 'external-entry',
    roadId: state.roads.at(-1)!.id,
    endpoint: 'start',
  });
  const angle = (degrees * Math.PI) / 180;

  state = applyRegionalAction(state, {
    type: 'road',
    points: [
      {x: -1236, z: -452},
      {x: -1236 + Math.cos(angle) * 200, z: -452 + Math.sin(angle) * 200},
    ],
  });
  const roadId = state.roads.at(-1)!.id;
  const settlement = state.settlements[0]!;
  const candidate = zoneCandidates(
    state,
    {minX: -1500, maxX: -1000, minZ: -750, maxZ: -250},
    settlement,
  ).find(
    parcel => parcel.access?.roadId === roadId && parcel.access.offset >= 0.35,
  );

  if (!candidate) {
    throw new Error(`No legal angled residential lot at ${degrees} degrees`);
  }

  state = applyRegionalAction(state, {
    type: 'zone',
    settlementId: settlement.id,
    kind: 'residential',
    selection: {
      minX: candidate.center.x - 1,
      maxX: candidate.center.x + 1,
      minZ: candidate.center.z - 1,
      maxZ: candidate.center.z + 1,
    },
  });
  state = advanceRegion(state, 900);

  return parseRegion(serializeRegion(state));
}
