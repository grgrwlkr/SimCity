import * as THREE from 'three';
import {Batch} from '../../city/primitives';
import {industry} from '../../city/model';
import {buildingKit} from '../../city/assetKits';
import type {CityBuilding} from '../../city/generator';
import type {Warehouse} from '../model/types';
import {WAREHOUSE_WIDTH, WAREHOUSE_DEPTH} from '../model/rules';

export function createWarehouseView(
  warehouse: Warehouse,
  seed: string,
): THREE.Group {
  const group = new THREE.Group();
  const batch = new Batch();
  const identity = {
    id: warehouse.id,
    district: 'industrial',
    variant: 'warehouse',
  } as const;
  const building: CityBuilding = {
    ...identity,
    blockId: warehouse.settlementId,
    name: 'Склад',
    x: 0,
    z: 0,
    width: WAREHOUSE_WIDTH,
    depth: WAREHOUSE_DEPTH,
    height: 7,
    floors: 1,
    color: 'sage',
    kit: buildingKit(seed, identity),
  };

  industry(batch, building, []);
  batch.finish(group);
  group.position.set(warehouse.center.x, 0, warehouse.center.z);
  group.rotation.y = warehouse.heading;

  return group;
}
