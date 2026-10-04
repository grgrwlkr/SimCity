import * as THREE from 'three';
import {Batch, material} from './primitives';
import {drawNativePortFoundation} from './nativePortParts';
import {industry} from './model';
import {propKit} from './assetKits';
import {addParts, propParts} from './assetParts';
import {createHarborView} from './harborView';
import {createRailwayView} from './railwayView';
import {ORIGINAL_HARBOR_LAYOUT, WAREHOUSES} from './harborLayout';
import {
  nativePortWarehouseTemplates,
  nativeRailwayCrossings,
} from './life/nativeInfrastructure';
import {nativePlacementTransform} from './nativeInfrastructurePlacement';
import type {NativeInfrastructurePlacement} from './nativeInfrastructurePlacement';
import type {
  AuthoredWorldDefinition,
  NativePortPlacement,
} from './life/definition';
import type {HarborSnapshot, HarborStatus} from './harbor';
import type {RailwaySnapshot, RailwayStatus} from './railway';

export interface NativeInfrastructureSnapshots {
  ports?: ReadonlyArray<{id: string; snapshot: HarborSnapshot}>;
  railways?: ReadonlyArray<{
    id: string;
    snapshot: RailwaySnapshot;
    status: RailwayStatus;
  }>;
}

function worldMatrix(
  placement: NativeInfrastructurePlacement,
  pivot: {x: number; z: number},
): THREE.Matrix4 {
  const source = placement.source ?? pivot;

  return new THREE.Matrix4()
    .makeTranslation(placement.center.x, 0, placement.center.z)
    .multiply(new THREE.Matrix4().makeRotationY(placement.yaw))
    .multiply(new THREE.Matrix4().makeTranslation(-source.x, 0, -source.z));
}

function initialPortSnapshot(placement: NativePortPlacement): HarborSnapshot {
  const transform = nativePlacementTransform(placement, {x: 85, z: 135});
  const status: HarborStatus = {
    shipPhase: 'away',
    berth: 0,
    shipCargo: 0,
    yardCargo: 0,
    freightTrucks: 0,
    delivered: 0,
    exported: 0,
    departedEmpty: 0,
    departedLoaded: 0,
    created: 0,
    activeCargo: 0,
  };

  return {
    ship: {
      ...transform.toWorld({x: 85, z: 151}),
      visible: false,
      mode: 'import',
      yaw: placement.yaw,
    },
    cargo: [],
    hooks: [
      {x: 72, z: 138, y: 11, yaw: Math.PI / 2},
      {x: 104, z: 138, y: 11, yaw: Math.PI / 2},
      {x: 68, z: 74, y: 8.8, yaw: Math.PI / 2},
      {x: 102, z: 108, y: 8.8, yaw: Math.PI / 2},
    ].map(pose => ({
      ...transform.toWorld(pose),
      yaw: pose.yaw + placement.yaw,
    })),
    status,
  };
}

export function createNativeInfrastructureView(
  definition: AuthoredWorldDefinition,
) {
  const group = new THREE.Group();
  const ports = new Map<string, ReturnType<typeof createHarborView>>();
  const railways = new Map<string, ReturnType<typeof createRailwayView>>();
  const targets: THREE.Object3D[] = [];
  const lampPositions: THREE.Vector3[] = [];
  const owned: THREE.BufferGeometry[] = [];
  const hitGeometry = new THREE.BoxGeometry(1, 1, 1);
  const hitboxes: THREE.Mesh[] = [];

  group.name = 'native-infrastructure';
  owned.push(hitGeometry);

  for (const placement of definition.infrastructure?.ports ?? []) {
    const root = new THREE.Group();
    const matrix = worldMatrix(placement, {x: 85, z: 135});
    const transform = nativePlacementTransform(placement, {x: 85, z: 135});
    const batch = new Batch();

    root.name = `native-port-${placement.id}`;
    const surfaces = new THREE.Group();

    surfaces.name = 'native-port-foundation';
    drawNativePortFoundation(batch);

    for (const warehouse of WAREHOUSES) {
      batch.add('box', 'port', warehouse.x, 0.7, warehouse.z, 26, 0.3, 26);

      for (const side of [-1, 1]) {
        const x = warehouse.x + side * 12.4;
        const z = warehouse.z + side * 4;

        addParts(
          batch,
          propParts(
            'lamp',
            propKit(definition.seed, 'lamp', `${warehouse.blockId}/${side}`),
          ),
          x,
          0.87,
          z,
          1,
          side > 0 ? 0 : Math.PI,
        );
        const point = transform.toWorld({x, z});

        lampPositions.push(new THREE.Vector3(point.x, 1.13, point.z));
      }
    }

    for (const [x, north] of [
      [51, 55],
      [85, 55],
      [119, 89],
    ]) {
      batch.add(
        'box',
        'asphalt',
        x!,
        0.79,
        (north! + 119) / 2,
        8,
        0.12,
        119 - north!,
      );
    }

    const templates = nativePortWarehouseTemplates(definition.seed);

    for (const [index, building] of templates.entries()) {
      industry(batch, building, []);
      const id = placement.warehouseBuildingIds[index];
      const actual = definition.layout.buildings.find(
        candidate => candidate.id === id,
      );

      if (actual) {
        const hit = new THREE.Mesh(hitGeometry, material('cream'));

        hit.scale.set(building.width, building.height, building.depth);
        hit.position.set(building.x, building.height / 2, building.z);
        hit.updateMatrix();
        hit.applyMatrix4(matrix);
        hit.userData['building'] = actual;
        hit.updateMatrixWorld(true);
        hitboxes.push(hit);
      }
    }

    batch.finish(surfaces);
    surfaces.applyMatrix4(matrix);
    root.add(surfaces);
    group.add(root);
    const extent = placement.navigation
      ? [...placement.navigation.arrivals, ...placement.navigation.departures]
          .flat()
          .map(point => point.x)
      : [];
    const layout = extent.length
      ? {
          ...ORIGINAL_HARBOR_LAYOUT,
          clipX: [Math.min(...extent) - 16, Math.max(...extent) + 16] as const,
        }
      : ORIGINAL_HARBOR_LAYOUT;
    const harbor = createHarborView(definition.seed, {placement, layout});

    harbor.update(initialPortSnapshot(placement), 0);
    root.add(harbor.group);
    ports.set(placement.id, harbor);
  }

  for (const placement of definition.infrastructure?.railways ?? []) {
    const crossings = nativeRailwayCrossings(placement, definition.roads);
    const view = createRailwayView({placement, crossings});

    view.group.name = `native-railway-${placement.id}`;

    for (const target of view.targets) {
      target.userData['infrastructureId'] = placement.id;
    }

    targets.push(...view.targets);
    group.add(view.group);
    railways.set(placement.id, view);
  }

  return {
    group,
    targets,
    hitboxes,
    lampPositions,
    update(frame: NativeInfrastructureSnapshots, seconds: number) {
      for (const item of frame.ports ?? []) {
        ports.get(item.id)?.update(item.snapshot, seconds);
      }

      for (const item of frame.railways ?? []) {
        railways.get(item.id)?.update(item.snapshot, seconds);
      }
    },
    setNight() {
      for (const view of ports.values()) {
        view.syncLighting();
      }

      for (const view of railways.values()) {
        view.syncLighting();
      }
    },
    dispose() {
      for (const view of ports.values()) {
        view.dispose();
      }

      for (const view of railways.values()) {
        view.dispose();
      }

      group.traverse(object => {
        if (object instanceof THREE.InstancedMesh) {
          object.dispose();
        }
      });
      owned.forEach(geometry => geometry.dispose());
    },
  };
}
