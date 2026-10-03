import {describe, expect, it} from 'vitest';
import * as THREE from 'three';
import {createRegion} from '../src/region/model/world';
import type {RegionState} from '../src/region/model/types';
import {createRegionView} from '../src/region/view/scene';
import {geometries, materials} from '../src/city/primitives';
import {polylineLane} from '../src/region/model/life/routes';

function isBufferGeometry(value: unknown): value is THREE.BufferGeometry {
  return value instanceof THREE.BufferGeometry;
}

function fixture(): RegionState {
  const state = createRegion('view-test', 'view-test');

  return {
    ...state,
    terrain: {...state.terrain, water: []},
    settlements: [
      {id: 'settlement-1', name: 'First', center: {x: 100, z: 100}},
    ],
    roads: [
      {
        id: 'road-1',
        points: [
          {x: -100, z: -100},
          {x: 100, z: 100},
        ],
      },
    ],
    parcels: [
      {
        id: 'parcel-1',
        settlementId: 'settlement-1',
        center: {x: -60, z: 70},
        heading: Math.PI / 2,
        width: 16,
        depth: 24,
        zone: 'residential',
        access: null,
      },
    ],
    warehouses: [
      {
        id: 'warehouse-1',
        settlementId: 'settlement-1',
        center: {x: 40, z: -40},
        heading: Math.PI / 2,
        access: null,
      },
    ],
  };
}

describe('region snapshot view', () => {
  it('keeps a selected trip visible in the scene while replacing and clearing its route', () => {
    const state = fixture();

    state.life.trips.push({
      id: 'trip-1',
      actorId: 'person-1',
      passengerIds: [],
      vehicleId: null,
      trafficIndex: null,
      fromId: 'home',
      toId: 'work',
      mode: 'walk',
      purpose: 'work',
      phase: 'travel',
      route: {
        lane: polylineLane([
          {x: 0, z: 0},
          {x: 100, z: 0},
        ]),
        roadIds: ['road-1'],
        roadRevision: state.roadRevision,
        crossings: [],
      },
      distance: 0,
      pose: {x: 0, z: 0, dx: 1, dz: 0},
      startedAt: 0,
      waitingSeconds: 0,
      parkingSlot: null,
    });
    const view = createRegionView(state);
    const routes = () => {
      const lines: THREE.BufferGeometry[] = [];

      view.group.traverse(object => {
        if (
          object instanceof THREE.Line &&
          object.material instanceof THREE.LineBasicMaterial &&
          object.material.color.getHex() === 0xe89631
        ) {
          const geometry: unknown = object.geometry;

          if (isBufferGeometry(geometry)) {
            lines.push(geometry);
          }
        }
      });

      return lines;
    };

    view.setSelection('trip-1');
    expect(routes()).toHaveLength(1);
    let disposed = false;

    routes()[0]!.addEventListener('dispose', () => {
      disposed = true;
    });
    view.setSelection(null);
    expect(routes()).toHaveLength(0);
    expect(disposed).toBe(true);
    view.setSelection('trip-1');
    expect(routes()).toHaveLength(1);
    view.dispose();
  });
  it('does not render an end cap beyond a butt-ended road', () => {
    const state = {
      ...fixture(),
      roads: [
        {
          id: 'road-end',
          points: [
            {x: 100, z: 300},
            {x: 199, z: 300},
          ],
        },
      ],
    };
    const view = createRegionView(state);
    const layer = view.group.getObjectByName('roads');

    expect(layer).toBeDefined();
    view.group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(
      new THREE.Vector3(201, 10, 300),
      new THREE.Vector3(0, -1, 0),
    );

    expect(ray.intersectObjects([layer!], true)).toHaveLength(0);
    view.dispose();
  });
  it('places the original warehouse assembly at its saved center and rotation', () => {
    const view = createRegionView(fixture());
    const building = view.group.getObjectByName('warehouse-1');

    expect(building).toBeDefined();
    expect(building!.position.toArray()).toEqual([40, 0, -40]);
    expect(building!.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(new THREE.Box3().setFromObject(building!).min.y).toBeCloseTo(0.91);
    expect(view.pick({x: 51, z: -40})).toBe('warehouse-1');
    expect(view.pick({x: 40, z: -29})).toBeNull();
    view.dispose();
  });
  it('picks rotated parcels and actual diagonal roads rather than their bounding boxes', () => {
    const view = createRegionView(fixture());

    expect(view.pick({x: -49, z: 70})).toBe('parcel-1');
    expect(view.pick({x: -60, z: 79})).toBeNull();
    expect(view.pick({x: -30, z: -30})).toBe('road-1');
    expect(view.pick({x: -30, z: 30})).toBeNull();
    view.dispose();
  });
  it('removes deleted objects but preserves unchanged warehouse geometry and all model fields', () => {
    const state = fixture();
    const original = structuredClone(state);
    const view = createRegionView(state);
    const building = view.group.getObjectByName('warehouse-1');

    expect(building).toBeDefined();
    view.update({
      ...state,
      roads: [],
      parcels: [],
      revision: 1,
      roadRevision: 1,
    });
    expect(view.group.getObjectByName('road-1')).toBeUndefined();
    expect(view.pick({x: -30, z: -30})).toBeNull();
    expect(view.group.getObjectByName('warehouse-1')).toBe(building);
    expect(state).toEqual(original);
    view.dispose();
  });
  it('reuses the seeded warehouse shape after unrelated neighbors are inserted', () => {
    const state = fixture();
    const view = createRegionView(state);
    const warehouse = view.group.getObjectByName('warehouse-1');

    expect(warehouse).toBeDefined();
    const before = new THREE.Box3().setFromObject(warehouse!).clone();

    view.update({
      ...state,
      revision: 1,
      warehouses: [
        ...state.warehouses,
        {...state.warehouses[0]!, id: 'warehouse-2', center: {x: 300, z: 300}},
      ],
    });
    expect(
      new THREE.Box3().setFromObject(
        view.group.getObjectByName('warehouse-1')!,
      ),
    ).toEqual(before);
    view.dispose();
  });
  it('keeps the carriageway open through an X junction without a crossing sidewalk', () => {
    const base = fixture();
    const state = {
      ...base,
      warehouses: [],
      parcels: [],
      settlements: [],
      roads: [
        {
          id: 'east-west',
          points: [
            {x: -50, z: 0},
            {x: 50, z: 0},
          ],
        },
        {
          id: 'north-south',
          points: [
            {x: 0, z: -50},
            {x: 0, z: 50},
          ],
        },
      ],
    };
    const view = createRegionView(state);

    view.group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(
      new THREE.Vector3(4.5, 20, 0),
      new THREE.Vector3(0, -1, 0),
    );
    const surface = ray.intersectObjects(
      view.group.getObjectByName('roads')!.children,
      true,
    )[0];

    expect(surface).toBeDefined();
    expect(surface!.point.y).toBeLessThanOrEqual(1.111);
    view.dispose();
  });
  it('rebuilds road width and external markers when a saved layout replaces matching IDs', () => {
    const state = fixture();
    const view = createRegionView({
      ...state,
      externalEntries: [{id: 'entry-1', roadId: 'road-1', endpoint: 'start'}],
    });
    const firstRoad = view.group.getObjectByName('road-1');

    view.update({
      ...state,
      rules: {...state.rules, roadWidth: 16},
      externalEntries: [{id: 'entry-1', roadId: 'road-1', endpoint: 'start'}],
    });
    expect(view.group.getObjectByName('road-1')).not.toBe(firstRoad);
    view.update({
      ...state,
      externalEntries: [{id: 'entry-1', roadId: 'road-1', endpoint: 'start'}],
      roads: [
        {
          id: 'road-1',
          points: [
            {x: -500, z: -100},
            {x: -300, z: 100},
          ],
        },
      ],
    });
    const marker = new THREE.Box3().setFromObject(
      view.group.getObjectByName('entry-1')!,
    );

    expect(marker.getCenter(new THREE.Vector3()).x).toBeCloseTo(-500);
    view.dispose();
  });
  it('disposes instance buffers and owned preview geometry while preserving shared city resources', () => {
    const view = createRegionView(fixture());
    let sharedDisposals = 0;
    let instanceDisposals = 0;
    const listener = () => {
      sharedDisposals++;
    };

    for (const geometry of Object.values(geometries)) {
      geometry.addEventListener('dispose', listener);
    }

    for (const mat of materials.values()) {
      mat.addEventListener('dispose', listener);
    }

    view.group.traverse(object => {
      if (object instanceof THREE.InstancedMesh) {
        object.addEventListener('dispose', () => {
          instanceDisposals++;
        });
      }
    });
    view.setPreview({
      valid: false,
      reason: 'water',
      cost: 0,
      contours: [
        [
          {x: 0, z: 0},
          {x: 10, z: 0},
          {x: 10, z: 10},
          {x: 0, z: 10},
        ],
      ],
    });
    expect(
      view.group.getObjectByName('preview')!.children.length,
    ).toBeGreaterThan(0);
    view.setPreview(null);
    expect(view.group.getObjectByName('preview')!.children).toHaveLength(0);
    view.dispose();
    expect(sharedDisposals).toBe(0);
    expect(instanceDisposals).toBeGreaterThan(0);
    expect(view.group.children).toHaveLength(0);

    for (const geometry of Object.values(geometries)) {
      geometry.removeEventListener('dispose', listener);
    }

    for (const mat of materials.values()) {
      mat.removeEventListener('dispose', listener);
    }
  });
});
