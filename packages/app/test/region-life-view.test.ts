import {describe, expect, it} from 'vitest';
import * as THREE from 'three';
import {geometries, materials} from '../src/city/primitives';
import {createRegion} from '../src/region/model/world';
import {BUILDING_RULES} from '../src/region/model/life/rules';
import type {
  RegionalBuilding,
  RegionalTrip,
} from '../src/region/model/life/types';
import type {Parcel, RegionState} from '../src/region/model/types';
import {createBuildingRecipe} from '../src/region/view/buildingView';
import {DevelopmentView} from '../src/region/view/developmentView';
import {LifeView} from '../src/region/view/lifeView';
import {
  parkingPoint,
  polylineLane,
  resolvePlace,
} from '../src/region/model/life/routes';
import {CityTraffic} from '../src/city/trafficFlow';

function lot(): Parcel {
  return {
    id: 'lot',
    settlementId: 'town',
    center: {x: 100, z: 200},
    heading: Math.PI / 3,
    width: 16,
    depth: 24,
    zone: 'residential',
    access: {roadId: 'road', segment: 0, offset: 0.5},
  };
}

function building(
  kind: RegionalBuilding['kind'] = 'residential',
): RegionalBuilding {
  return {
    id: 'building',
    lotId: 'lot',
    settlementId: 'town',
    kind,
    ownerId: 'family-1',
    stage: 'constructing',
    startedAt: 60,
    progressSeconds: 0,
    durationSeconds: BUILDING_RULES[kind].durationSeconds,
    capacity: 0,
    jobs: 0,
    qualification: 0,
    parking: 0,
    inventory: 0,
    inventoryCapacity: 0,
    cash: 0,
    productionWork: 0,
  };
}

function fixture(): RegionState {
  const state = createRegion('view-life', 'view-life');

  return {
    ...state,
    parcels: [lot()],
    life: {...state.life, buildings: [building()]},
  };
}

function trip(): RegionalTrip {
  return {
    id: 'trip',
    actorId: 'person',
    passengerIds: ['passenger'],
    vehicleId: null,
    trafficIndex: null,
    fromId: 'a',
    toId: 'b',
    mode: 'walk',
    purpose: 'work',
    phase: 'travel',
    route: {
      lane: polylineLane([
        {x: 10, z: 20},
        {x: 10, z: 50},
      ]),
      roadIds: ['road'],
      roadRevision: 0,
      crossings: [],
    },
    distance: 0,
    pose: {x: 10, z: 20, dx: 0, dz: 1},
    startedAt: 0,
    waitingSeconds: 0,
    parkingSlot: null,
  };
}

describe('regional life rendering', () => {
  it('uses modular complete buildings inside the actual sixteen by twenty-four meter lot', () => {
    for (const kind of ['residential', 'commercial', 'industrial'] as const) {
      const recipe = createBuildingRecipe(building(kind), lot(), 'view-life');

      expect(recipe.parts.length).toBeGreaterThan(20);
      const bounds = new THREE.Box3();

      for (const part of recipe.parts) {
        const geometry = geometries[part.shape];

        geometry.computeBoundingBox();
        bounds.union(geometry.boundingBox!.clone().applyMatrix4(part.matrix));
      }

      expect(bounds.min.x).toBeGreaterThanOrEqual(-8);
      expect(bounds.max.x).toBeLessThanOrEqual(8);
      expect(bounds.min.z).toBeGreaterThanOrEqual(-12);
      expect(bounds.max.z).toBeLessThanOrEqual(12);
      expect(bounds.max.y).toBeGreaterThan(6);
    }
  });
  it('changes actual construction height without rebuilding batches and reveals the same ready building', () => {
    const state = fixture();
    const view = new DevelopmentView();

    view.update(state);
    const staticLayer = view.group.getObjectByName('completed-buildings')!;

    expect(staticLayer.children.length).toBeGreaterThan(0);
    const meshes = [...staticLayer.children];

    expect(view.group.getObjectByName('construction-site')).toBeDefined();

    const clipping = (): number[] => {
      const planes: number[] = [];

      view.group.traverse(object => {
        if (
          object instanceof THREE.Mesh &&
          object.material instanceof THREE.Material
        ) {
          planes.push(
            ...(object.material.clippingPlanes ?? []).map(
              plane => plane.constant,
            ),
          );
        }
      });

      return planes;
    };

    expect(clipping().every(height => height === 0)).toBe(true);
    const halfway = {
      ...state,
      life: {...state.life, buildings: [{...building(), progressSeconds: 900}]},
    };

    view.update(halfway);
    expect(clipping().some(height => height > 3)).toBe(true);
    expect(staticLayer.children).toEqual(meshes);
    const ready = {
      ...state,
      life: {
        ...state.life,
        buildings: [
          {...building(), stage: 'ready' as const, progressSeconds: 1800},
        ],
      },
    };

    view.update(ready);
    expect(staticLayer.children).toEqual(meshes);
    expect(view.group.getObjectByName('construction-site')).toBeUndefined();
    expect(view.pick(lot().center)).toBe('building');
    view.dispose();
  });
  it('shows only actual walkers, follows saved poses, and leaves buffers and paused poses stable', () => {
    const state = fixture();

    state.life.trips = [trip()];
    state.life.people = ['person', 'outside', 'passenger'].map(id => ({
      id,
      familyId: 'family',
      name: id,
      age: 30,
      qualification: 0,
      jobId: null,
      placeId: null,
      tripId: id === 'outside' ? null : 'trip',
      activity:
        id === 'person'
          ? 'walking'
          : id === 'passenger'
            ? 'passenger'
            : 'outside',
      reason: null,
      workedSeconds: 0,
      wageSeconds: 0,
    }));
    const view = new LifeView();

    view.update(state);
    expect(view.pick({x: 10, z: 20})).toBe('person');
    const meshes = [...view.group.children];

    state.life.trips[0]!.pose = {x: 10, z: 35, dx: 0, dz: 1};
    state.life.elapsedSeconds = 30;
    view.update(state);
    expect(view.pick({x: 10, z: 20})).toBeNull();
    expect(view.pick({x: 10, z: 35})).toBe('person');
    expect(view.group.children).toEqual(meshes);
    const before = view.group.children
      .filter(
        (object): object is THREE.InstancedMesh =>
          object instanceof THREE.InstancedMesh,
      )
      .map(mesh => Array.from(mesh.instanceMatrix.array));

    view.animate(10, true);
    expect(
      view.group.children
        .filter(
          (object): object is THREE.InstancedMesh =>
            object instanceof THREE.InstancedMesh,
        )
        .map(mesh => Array.from(mesh.instanceMatrix.array)),
    ).toEqual(before);
    view.dispose();
  });
  it('disposes owned construction copies and instance buffers while preserving shared assets', () => {
    const view = new DevelopmentView();

    view.update(fixture());
    let shared = 0;
    let owned = 0;
    const listener = (): void => {
      shared++;
    };

    for (const material of materials.values()) {
      material.addEventListener('dispose', listener);
    }

    for (const geometry of Object.values(geometries)) {
      geometry.addEventListener('dispose', listener);
    }

    view.group.traverse(object => {
      if (object instanceof THREE.InstancedMesh) {
        object.addEventListener('dispose', () => {
          owned++;
        });
      }
    });
    view.dispose();
    expect(shared).toBe(0);
    expect(owned).toBeGreaterThan(0);
    expect(view.group.children).toHaveLength(0);

    for (const material of materials.values()) {
      material.removeEventListener('dispose', listener);
    }

    for (const geometry of Object.values(geometries)) {
      geometry.removeEventListener('dispose', listener);
    }
  });
  it('restores an earlier construction snapshot after the same building was completed', () => {
    const state = fixture();
    const ready: RegionState = {
      ...state,
      life: {
        ...state.life,
        buildings: [{...building(), stage: 'ready', progressSeconds: 1800}],
      },
    };
    const view = new DevelopmentView();

    view.update(ready);
    expect(view.group.getObjectByName('construction-site')).toBeUndefined();
    view.update(state);
    expect(view.group.getObjectByName('construction-site')).toBeDefined();
    view.dispose();
  });
  it('batches two hundred completed buildings into shared material draws', () => {
    const state = fixture();
    const parcels = Array.from({length: 200}, (_, index) => ({
      ...lot(),
      id: `lot-${index}`,
      center: {x: index * 20, z: 0},
    }));
    const buildings = parcels.map((parcel, index) => ({
      ...building(),
      id: `building-${index}`,
      lotId: parcel.id,
      stage: 'ready' as const,
      progressSeconds: 1800,
    }));
    const view = new DevelopmentView();

    view.update({...state, parcels, life: {...state.life, buildings}});
    const counts: number[] = [];

    view.group.traverse(object => {
      if (object instanceof THREE.InstancedMesh) {
        counts.push(object.count);
      }
    });
    expect(counts.length).toBeLessThan(40);
    expect(counts.reduce((total, count) => total + count, 0)).toBeGreaterThan(
      4000,
    );
    view.dispose();
  });
  it('keeps parked cars at their actual bay while drivers walk and selects saved delivery trucks', () => {
    const base = fixture();
    const state: RegionState = {
      ...base,
      parcels: [{...lot(), center: {x: 0, z: 0}, heading: 0}],
      roads: [
        {
          id: 'road',
          points: [
            {x: -100, z: 20},
            {x: 100, z: 20},
          ],
        },
      ],
    };

    state.life.buildings[0] = {...building(), stage: 'ready', parking: 4};
    state.life.cars = [
      {
        id: 'car',
        familyId: 'family',
        driverId: 'person',
        parkedAt: 'building',
        parkingSlot: 0,
        tripId: 'trip',
        trafficIndex: 0,
      },
    ];
    state.life.people = [
      {
        id: 'person',
        familyId: 'family',
        name: 'Иван',
        age: 30,
        qualification: 0,
        jobId: null,
        placeId: 'building',
        tripId: 'trip',
        activity: 'walking',
        reason: null,
        workedSeconds: 0,
        wageSeconds: 0,
      },
    ];
    state.life.trips = [
      {
        ...trip(),
        mode: 'car',
        phase: 'approach',
        vehicleId: 'car',
        trafficIndex: 0,
        pose: {x: 0, z: 5, dx: -1, dz: 0},
      },
      {
        ...trip(),
        id: 'delivery-trip',
        actorId: 'order',
        passengerIds: [],
        mode: 'truck',
        trafficIndex: 1,
        pose: {x: 80, z: 80, dx: 0, dz: 1},
      },
    ];
    const traffic = new CityTraffic([], {roads: []});

    traffic.addCar({length: 4.2, width: 1.8}, {x: 900, z: 900, dx: 0, dz: 1});
    traffic.addCar({length: 6.5, width: 2.3}, {x: 80, z: 80, dx: 0, dz: 1});
    state.life.traffic = traffic.save();
    const view = new LifeView();

    view.update(state);
    const bay = parkingPoint(resolvePlace(state, 'building')!, 0);

    expect(view.pick(bay)).toBe('car');
    expect(view.pick({x: 0, z: 5})).toBe('person');
    expect(view.pick({x: 80, z: 80})).toBe('delivery-trip');
    expect(view.pick({x: 900, z: 900})).toBeNull();
    state.life.trips[0]!.phase = 'travel';
    state.life.cars[0]!.parkedAt = null;
    state.life.traffic.vehicles[0]!.pose = {x: 20, z: 20, dx: 1, dz: 0};
    view.update(state);
    expect(view.pick({x: 0, z: 5})).toBeNull();
    expect(view.pick(bay)).toBeNull();
    expect(view.pick({x: 20, z: 20})).toBe('car');
    view.dispose();
  });
});
