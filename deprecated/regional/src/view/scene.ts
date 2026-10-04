import {sampleLaneRoute} from '../../../../packages/app/src/city/trafficRoutes';
import {selectedTrip} from '../lifePanel';
import * as THREE from 'three';
import {Batch, material} from '../../../../packages/app/src/city/primitives';
import {
  pointInPolygon,
  projectSegment,
  rectangle,
  distance,
} from '../../../../packages/app/src/region/model/geometry';
import {
  WAREHOUSE_WIDTH,
  WAREHOUSE_DEPTH,
} from '../../../../packages/app/src/region/model/rules';
import {townHallReservation} from '../../../../packages/app/src/region/model/townHall';
import type {
  EntityId,
  ExternalEntry,
  Point,
  Preview,
  RegionState,
  Settlement,
} from '../../../../packages/app/src/region/model/types';
import {TerrainView} from '../../../../packages/app/src/region/view/terrainView';
import {createTownHallView} from '../../../../packages/app/src/region/view/townHallView';
import {createTerritoryView} from '../../../../packages/app/src/region/view/territoryView';
import {createWarehousePreparation} from './buildingView';
import {DevelopmentView} from './developmentView';
import {LifeView} from './lifeView';
import {createParcelView} from './parcelView';
import {createRoadView, createJunctionView, roadJunctions} from './roadView';
import {
  disposeLayer,
  EntityLayer,
} from '../../../../packages/app/src/region/view/resources';

export interface RegionView {
  group: THREE.Group;
  update(state: RegionState): void;
  animate(realSeconds: number, paused: boolean): void;
  setNight(night: boolean): void;
  setActiveSettlement(id: EntityId | null): void;
  setSelection(id: EntityId | null): void;
  setPreview(preview: Preview | null): void;
  setDetail(center: Point, radius: number): void;
  pick(point: Point): EntityId | null;
  dispose(): void;
}

function settlementView(
  settlement: Settlement,
  roadWidth: number,
): THREE.Group {
  if (settlement.townHall) {
    return createTownHallView(settlement, roadWidth);
  }

  const group = new THREE.Group();
  const batch = new Batch();

  batch.add(
    'cylinder',
    'paving',
    settlement.center.x,
    1.065,
    settlement.center.z,
    12,
    0.1,
    12,
  );
  batch.add(
    'cylinder',
    'teal',
    settlement.center.x,
    1.13,
    settlement.center.z,
    10,
    0.05,
    10,
  );
  batch.add(
    'cylinder',
    'trim',
    settlement.center.x,
    4,
    settlement.center.z,
    0.5,
    6,
    0.5,
  );
  batch.add(
    'box',
    'coral',
    settlement.center.x + 1.5,
    6,
    settlement.center.z,
    3,
    1.8,
    0.15,
  );
  batch.finish(group);

  return group;
}

export function createRegionView(initialState: RegionState): RegionView {
  const group = new THREE.Group();

  group.name = 'region';
  let state = initialState;
  let activeSettlementId: EntityId | null = null;
  let terrainSignature = JSON.stringify([
    initialState.terrain,
    initialState.seed,
  ]);
  let terrain = new TerrainView(state);
  let junctions = roadJunctions(state.roads);
  let roadSignature = '';
  const roads = new EntityLayer('roads', (road: RegionState['roads'][number]) =>
    createRoadView(road, state.rules.roadWidth, junctions),
  );
  const parcels = new EntityLayer('parcels', createParcelView);
  const development = new DevelopmentView();
  const life = new LifeView();
  const warehouses = new EntityLayer(
    'warehouses',
    (warehouse: RegionState['warehouses'][number]) =>
      createWarehousePreparation(warehouse),
  );
  const settlements = new EntityLayer('settlements', (settlement: Settlement) =>
    settlementView(settlement, state.rules.roadWidth),
  );
  const territories = new EntityLayer(
    'territories',
    (entry: {id: string; settlement: Settlement; active: boolean}) =>
      createTerritoryView(entry.settlement, entry.active),
  );
  const updateTerritories = (): void => {
    territories.update(
      state.settlements.map(settlement => ({
        id: `territory-${settlement.id}`,
        settlement,
        active: settlement.id === activeSettlementId,
      })),
    );
  };
  const entries = new EntityLayer(
    'external-entries',
    (entry: ExternalEntry) => {
      const marker = new THREE.Group();
      const batch = new Batch();
      const road = state.roads.find(candidate => candidate.id === entry.roadId);
      const point =
        entry.endpoint === 'start' ? road?.points[0] : road?.points.at(-1);

      if (point) {
        batch.add('cylinder', 'gold', point.x, 1.13, point.z, 12, 0.08, 12);
        batch.add('box', 'dark', point.x, 3, point.z, 3.2, 3.8, 0.4);
        batch.add('box', 'gold', point.x, 3, point.z + 0.23, 2.4, 0.6, 0.08);
        batch.finish(marker);
      }

      return marker;
    },
  );
  let junctionLayer = new THREE.Group();
  const preview = new THREE.Group();
  const selectedRoute = new THREE.Group();
  let selectedRouteSignature = '';

  group.add(selectedRoute);

  preview.name = 'preview';
  const ambient = new THREE.HemisphereLight(0xfff1d8, 0x708274, 2.3);
  const sun = new THREE.DirectionalLight(0xffe8c9, 2.6);

  sun.position.set(-300, 650, 250);
  group.add(
    terrain.group,
    roads.group,
    parcels.group,
    warehouses.group,
    development.group,
    life.group,
    settlements.group,
    territories.group,
    entries.group,
    junctionLayer,
    preview,
    ambient,
    sun,
  );

  const update = (next: RegionState): void => {
    state = next;
    const signature = JSON.stringify([state.terrain, state.seed]);

    if (signature !== terrainSignature) {
      disposeLayer(terrain.group);
      terrain = new TerrainView(state);
      terrainSignature = signature;
      group.add(terrain.group);
    } else {
      terrain.update(state);
    }

    const nextRoadSignature = JSON.stringify([
      state.roads,
      state.rules.roadWidth,
    ]);

    if (nextRoadSignature !== roadSignature) {
      junctions = roadJunctions(state.roads);
      // Junction coordinates enter each road's render signature; unaffected roads retain their batches.
      roads.update(
        state.roads.map(road => ({
          ...road,
          width: state.rules.roadWidth,
          junctions: junctions.filter(point =>
            road.points
              .slice(1)
              .some(
                (end, index) =>
                  projectSegment(point, road.points[index]!, end).distance <
                  state.rules.roadWidth,
              ),
          ),
        })),
      );
      disposeLayer(junctionLayer);
      junctionLayer = createJunctionView(junctions, state.rules.roadWidth);
      junctionLayer.name = 'junctions';
      group.add(junctionLayer);
      roadSignature = nextRoadSignature;
    }

    updateTerritories();
    parcels.update(state.parcels);
    const developedLots = new Set(
      state.life.buildings.map(building => building.lotId),
    );

    warehouses.update(
      state.warehouses.filter(warehouse => !developedLots.has(warehouse.id)),
    );
    development.update(state);
    life.update(state);
    settlements.update(
      state.settlements.map(settlement => ({
        ...settlement,
        roadWidth: state.rules.roadWidth,
      })),
    );
    entries.update(
      state.externalEntries.map(entry => {
        const road = state.roads.find(
          candidate => candidate.id === entry.roadId,
        );

        return {
          ...entry,
          position:
            entry.endpoint === 'start' ? road?.points[0] : road?.points.at(-1),
        };
      }),
    );
  };

  update(initialState);

  return {
    group,
    update,
    animate(realSeconds, paused) {
      life.animate(realSeconds, paused);
    },
    setSelection(id) {
      const trip = id ? selectedTrip(state, id) : undefined;
      const signature = trip
        ? JSON.stringify([
            trip.id,
            trip.route,
            trip.approach?.lane,
            trip.exit?.lane,
          ])
        : '';

      if (signature === selectedRouteSignature) {
        return;
      }

      selectedRouteSignature = signature;

      for (const child of [...selectedRoute.children]) {
        disposeLayer(child);
      }

      if (!trip) {
        return;
      }

      for (const route of [
        trip.approach?.lane,
        trip.route.lane,
        trip.exit?.lane,
      ]) {
        if (!route) {
          continue;
        }

        const count = Math.max(1, Math.ceil(route.length / 5));
        const points = Array.from({length: count + 1}, (_, index) => {
          const pose = sampleLaneRoute(route, (route.length * index) / count);

          return new THREE.Vector3(pose.x, 1.35, pose.z);
        });
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({color: 0xe89631, depthTest: false}),
        );

        line.renderOrder = 8;
        selectedRoute.add(line);
      }
    },
    setActiveSettlement(id) {
      activeSettlementId = id;
      updateTerritories();
    },
    setDetail(center, radius) {
      terrain.setDetail(center, radius);
      life.setDetail(center, radius);
    },
    setNight(night) {
      ambient.color.setHex(night ? 0x8497bf : 0xfff1d8);
      ambient.intensity = night ? 1 : 2.3;
      sun.color.setHex(night ? 0xa8bcdf : 0xffe8c9);
      sun.intensity = night ? 0.7 : 2.6;
      development.syncLighting();
    },
    setPreview(value) {
      // The persistent parent remains attached when owned buffers are cleared.
      for (const child of [...preview.children]) {
        disposeLayer(child);
      }

      if (!value) {
        return;
      }

      for (const contour of value.contours) {
        if (contour.length < 2) {
          continue;
        }

        const vertices = contour.map(
          point => new THREE.Vector3(point.x, 1.3, point.z),
        );
        const geometry = new THREE.BufferGeometry().setFromPoints(vertices);
        const mat = new THREE.LineBasicMaterial({
          color: material(value.valid ? 'teal' : 'red').color,
          depthTest: false,
        });
        const outline = new THREE.LineLoop(geometry, mat);

        outline.renderOrder = 10;
        preview.add(outline);
      }
    },
    pick(point) {
      const actorId = life.pick(point) ?? development.pick(point);

      if (actorId) {
        return actorId;
      }

      for (const warehouse of state.warehouses) {
        if (
          pointInPolygon(
            point,
            rectangle(
              warehouse.center,
              WAREHOUSE_WIDTH,
              WAREHOUSE_DEPTH,
              warehouse.heading,
            ),
          )
        ) {
          return warehouse.id;
        }
      }

      for (const parcel of state.parcels) {
        if (
          pointInPolygon(
            point,
            rectangle(
              parcel.center,
              parcel.width,
              parcel.depth,
              parcel.heading,
            ),
          )
        ) {
          return parcel.id;
        }
      }

      for (const entry of state.externalEntries) {
        const road = state.roads.find(
          candidate => candidate.id === entry.roadId,
        );
        const endpoint =
          entry.endpoint === 'start' ? road?.points[0] : road?.points.at(-1);

        if (endpoint && distance(point, endpoint) <= 7) {
          return entry.id;
        }
      }

      for (const settlement of state.settlements) {
        if (
          settlement.townHall
            ? pointInPolygon(point, townHallReservation(settlement))
            : distance(point, settlement.center) <= 7
        ) {
          return settlement.id;
        }
      }

      for (const road of state.roads) {
        if (
          road.points
            .slice(1)
            .some(
              (end, index) =>
                projectSegment(point, road.points[index]!, end).distance <=
                state.rules.roadWidth / 2 + 1.6,
            )
        ) {
          return road.id;
        }
      }

      return null;
    },
    dispose() {
      disposeLayer(selectedRoute);
      development.dispose();
      life.dispose();
      disposeLayer(group);
    },
  };
}
