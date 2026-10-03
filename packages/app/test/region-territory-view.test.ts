import {describe, expect, it} from 'vitest';
import * as THREE from 'three';
import {createRegion} from '../src/region/model/world';
import type {RegionState} from '../src/region/model/types';
import {createRegionView} from '../src/region/view/scene';

function fixture(level = 1): RegionState {
  const state = createRegion('territory-view', 'territory-view');

  return {
    ...state,
    terrain: {...state.terrain, water: []},
    settlements: ['first', 'second'].map((id, index) => ({
      id,
      name: id,
      center: {x: index * 1000, z: 200},
      townHall: {roadId: `road-${id}`, heading: 0, level},
    })),
  };
}

function territory(view: ReturnType<typeof createRegionView>, id: string) {
  const group = view.group.getObjectByName(`territory-${id}`);

  expect(group).toBeDefined();

  return group!;
}

function fill(view: ReturnType<typeof createRegionView>, id: string) {
  const mesh = territory(view, id).getObjectByName('territory-fill');

  expect(mesh).toBeInstanceOf(THREE.Mesh);

  return mesh!;
}

describe('city territory view', () => {
  it('draws each city radius around its town hall without selecting the empty territory as a building', () => {
    const view = createRegionView(fixture());
    const area = new THREE.Box3().setFromObject(territory(view, 'first'));

    expect(area.min.x).toBeCloseTo(-300);
    expect(area.max.x).toBeCloseTo(300);
    expect(area.min.z).toBeCloseTo(-100);
    expect(area.max.z).toBeCloseTo(500);
    expect(fill(view, 'first').visible).toBe(false);
    expect(fill(view, 'second').visible).toBe(false);
    expect(view.pick({x: 200, z: 200})).toBeNull();
    view.dispose();
  });

  it('emphasizes only the active city and returns to unfilled outlines in region mode', () => {
    const view = createRegionView(fixture());

    view.setActiveSettlement('first');
    expect(fill(view, 'first').visible).toBe(true);
    expect(fill(view, 'second').visible).toBe(false);
    view.setActiveSettlement('second');
    expect(fill(view, 'first').visible).toBe(false);
    expect(fill(view, 'second').visible).toBe(true);
    view.setActiveSettlement(null);
    expect(fill(view, 'second').visible).toBe(false);
    view.dispose();
  });

  it('expands the active radius from saved levels and releases replaced and removed buffers', () => {
    const view = createRegionView(fixture());
    let disposed = 0;
    const watchDisposal = (group: THREE.Object3D) => {
      group.traverse(object => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
          const geometry: unknown = object.geometry;

          if (geometry instanceof THREE.BufferGeometry) {
            geometry.addEventListener('dispose', () => disposed++);
          }
        }
      });
    };

    view.setActiveSettlement('first');
    watchDisposal(territory(view, 'first'));
    view.update(fixture(4));
    expect(disposed).toBeGreaterThan(0);
    const area = new THREE.Box3().setFromObject(territory(view, 'first'));

    expect(area.max.x).toBeCloseTo(900);
    expect(area.min.z).toBeCloseTo(-700);
    expect(fill(view, 'first').visible).toBe(true);
    const prior = disposed;

    watchDisposal(territory(view, 'first'));
    view.update({...fixture(4), settlements: []});
    expect(disposed).toBeGreaterThan(prior);
    expect(view.group.getObjectByName('territory-first')).toBeUndefined();
    view.dispose();
  });
});
