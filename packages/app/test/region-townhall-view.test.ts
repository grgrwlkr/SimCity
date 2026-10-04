import {describe, expect, it} from 'vitest';
import * as THREE from 'three';
import {geometries, materials} from '../src/city/primitives';
import {createRegion} from '../src/region/model/world';
import type {RegionState} from '../src/region/model/types';
import {createCivicFixture as createRegionView} from './helpers/civicViewFixture';

function fixture(heading = 0): RegionState {
  const state = createRegion('town-hall-view', 'town-hall-view');

  return {
    ...state,
    terrain: {...state.terrain, water: []},
    settlements: [
      {
        id: 'settlement-hall',
        name: 'Town',
        center: {x: 100, z: 200},
        townHall: {roadId: 'road-hall', heading},
      },
    ],
  };
}

function hallGroup(view: ReturnType<typeof createRegionView>): THREE.Object3D {
  const group = view.group.getObjectByName('settlement-hall');

  expect(group).toBeDefined();

  return group!;
}

describe('town hall view', () => {
  it('places the civic site at the saved position and heading without mutating the snapshot', () => {
    const state = fixture(Math.PI / 2);
    const before = structuredClone(state);
    const view = createRegionView(state);
    const hall = hallGroup(view);

    expect(hall.position.toArray()).toEqual([100, 0, 200]);
    expect(hall.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(hall.userData).toMatchObject({
      kind: 'town-hall',
      settlementId: 'settlement-hall',
    });
    expect(state).toEqual(before);
    view.dispose();
  });

  it('selects the whole rotated reservation including its empty expansion land', () => {
    const view = createRegionView(fixture(Math.PI / 2));

    expect(view.pick({x: 61, z: 247})).toBe('settlement-hall');
    expect(view.pick({x: 139, z: 153})).toBe('settlement-hall');
    expect(view.pick({x: 141, z: 200})).toBeNull();
    expect(view.pick({x: 100, z: 249})).toBeNull();
    view.dispose();
  });

  it('keeps a broad expansion lawn clear of buildings and joins the entrance to the sidewalk', () => {
    const view = createRegionView(fixture());
    const hall = hallGroup(view);

    view.group.updateMatrixWorld(true);

    const heightAt = (x: number, z: number): number | undefined => {
      const ray = new THREE.Raycaster(
        new THREE.Vector3(x, 50, z),
        new THREE.Vector3(0, -1, 0),
      );

      return ray.intersectObject(hall, true)[0]?.point.y;
    };

    expect(heightAt(100, 200)).toBeGreaterThan(8);

    for (const [x, z] of [
      [75, 180],
      [125, 180],
      [100, 170],
    ]) {
      expect(heightAt(x!, z!)).toBeGreaterThan(1);
      expect(heightAt(x!, z!)).toBeLessThan(1.4);
    }

    for (const z of [218, 230, 239, 242.4]) {
      expect(heightAt(100, z)).toBeGreaterThan(1);
      expect(heightAt(100, z)).toBeLessThan(1.5);
    }

    view.dispose();
  });

  it('adds civic wings as the saved town hall level grows within its reserved lot', () => {
    const state = fixture();
    const view = createRegionView(state);
    const heightAt = (x: number, z: number): number => {
      view.group.updateMatrixWorld(true);
      const ray = new THREE.Raycaster(
        new THREE.Vector3(x, 50, z),
        new THREE.Vector3(0, -1, 0),
      );

      return ray.intersectObject(hallGroup(view), true)[0]!.point.y;
    };
    const upgrade = (level: number): void => {
      view.update({
        ...state,
        settlements: state.settlements.map(settlement => ({
          ...settlement,
          townHall: {...settlement.townHall!, level},
        })),
      });
    };

    expect(heightAt(75, 195)).toBeLessThan(1.4);
    upgrade(2);
    expect(heightAt(75, 195)).toBeGreaterThan(8);
    expect(heightAt(125, 195)).toBeLessThan(1.4);
    upgrade(3);
    expect(heightAt(125, 195)).toBeGreaterThan(8);
    expect(heightAt(100, 176)).toBeLessThan(1.4);
    upgrade(4);
    expect(heightAt(100, 176)).toBeGreaterThan(12);
    expect(heightAt(55, 175)).toBeLessThan(1.4);
    expect(heightAt(145, 175)).toBeLessThan(1.4);
    view.dispose();
  });

  it('releases replaced hall instances while retaining shared city geometry and materials', () => {
    const state = fixture();
    const view = createRegionView(state);
    const hall = hallGroup(view);
    let instanceDisposals = 0;
    let sharedDisposals = 0;
    const shared = [...Object.values(geometries), ...materials.values()];
    const onDispose = () => {
      sharedDisposals++;
    };

    shared.forEach(resource => resource.addEventListener('dispose', onDispose));
    hall.traverse(object => {
      if (object instanceof THREE.InstancedMesh) {
        object.addEventListener('dispose', () => {
          instanceDisposals++;
        });
      }
    });
    view.update({...state, settlements: []});
    expect(instanceDisposals).toBeGreaterThan(0);
    expect(view.group.getObjectByName('settlement-hall')).toBeUndefined();
    expect(view.pick({x: 100, z: 200})).toBeNull();
    view.dispose();
    expect(sharedDisposals).toBe(0);
    shared.forEach(resource =>
      resource.removeEventListener('dispose', onDispose),
    );
  });
});
