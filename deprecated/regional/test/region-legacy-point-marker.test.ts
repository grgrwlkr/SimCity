import {expect, it} from 'vitest';
import * as THREE from 'three';
import {createRegion} from '../../../packages/app/src/region/model/world';
import type {
  RegionState,
  Settlement,
} from '../../../packages/app/src/region/model/types';
import {createRegionView} from '../src/view/scene';
function fixture(): RegionState {
  return {...createRegion('legacy', 'legacy'), settlements: [], roads: []};
}
function hallGroup(view: ReturnType<typeof createRegionView>): THREE.Object3D {
  return view.group.getObjectByName('settlement-hall')!;
}
it('preserves the old point marker and selection radius in legacy snapshots', () => {
  const state = fixture();
  const legacy: Settlement = {
    id: 'settlement-hall',
    name: 'Legacy',
    center: {x: 100, z: 200},
  };
  const view = createRegionView({...state, settlements: [legacy]});

  expect(view.pick({x: 100, z: 206})).toBe('settlement-hall');
  expect(view.pick({x: 100, z: 220})).toBeNull();
  expect(new THREE.Box3().setFromObject(hallGroup(view)).max.y).toBeLessThan(8);
  view.dispose();
});
