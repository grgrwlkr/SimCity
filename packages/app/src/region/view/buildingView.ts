import * as THREE from 'three';
import {Batch, type BatchPart} from '../../city/primitives';
import {buildingKit} from '../../city/assetKits';
import {lowriseModules} from '../../city/buildingModules';
import {industry} from '../../city/model';
import type {CityBuilding} from '../../city/generator';
import type {ConstructionPlot} from '../../city/constructionSite';
import {parkingPoint} from '../model/life/routes';
import {BUILDING_RULES} from '../model/life/rules';
import type {RegionalBuilding} from '../model/life/types';
import {WAREHOUSE_DEPTH, WAREHOUSE_WIDTH} from '../model/rules';
import type {Parcel, Warehouse} from '../model/types';

export interface BuildingRecipe {
  parts: BatchPart[];
  plot: ConstructionPlot;
}

export function lotDimensions(lot: Parcel | Warehouse): {
  width: number;
  depth: number;
} {
  return 'width' in lot
    ? {width: lot.width, depth: lot.depth}
    : {width: WAREHOUSE_WIDTH, depth: WAREHOUSE_DEPTH};
}

/** Reuse the approved city's modular recipes inside a road-facing regional parcel. */
export function createBuildingRecipe(
  building: RegionalBuilding,
  lot: Parcel | Warehouse,
  seed: string,
): BuildingRecipe {
  const {width, depth} = lotDimensions(lot);
  const commercial = building.kind === 'commercial';
  const industrial =
    building.kind === 'industrial' || building.kind === 'warehouse';
  const identity = {
    id: building.id,
    district: industrial
      ? ('industrial' as const)
      : commercial
        ? ('commercial' as const)
        : ('residential' as const),
    variant: industrial
      ? building.kind === 'warehouse'
        ? ('warehouse' as const)
        : ('sawtooth' as const)
      : commercial
        ? ('store' as const)
        : ('terrace' as const),
  };
  const body: CityBuilding = {
    ...identity,
    blockId: building.settlementId,
    name: building.id,
    x: 0,
    z: -3,
    width: width - 4,
    depth: depth - 10,
    height: industrial ? 6 : commercial ? 5.5 : 8.4,
    floors: industrial || commercial ? 1 : 3,
    color: industrial ? 'sage' : commercial ? 'cream' : 'coral',
    kit: buildingKit(seed, identity),
  };
  const batch = new Batch();
  const object = batch.capture(sink => {
    if (industrial) {
      industry(sink, body, []);
    } else {
      lowriseModules(sink, body);
    }

    sink.add('box', 'paving', 0, 1.04, depth / 2 - 4, width - 0.5, 0.12, 7.5);
    sink.add('box', 'path', 0, 1.115, depth / 2 - 4, 1.5, 0.04, 7.5);
    const parking = BUILDING_RULES[building.kind].parking;
    const place = {
      id: building.id,
      roadId: lot.access?.roadId ?? '',
      road: {x: 0, z: depth / 2},
      door: {x: 0, z: depth / 2 - 7},
      heading: 0,
      width,
      parking,
      entry: false,
    };
    const spaces = parking + (industrial || commercial ? 1 : 0);

    for (let slot = 0; slot < spaces; slot++) {
      const point = parkingPoint(place, slot);
      const loading = slot === parking;
      const bayWidth = loading ? 2.7 : 2.3;
      const bayDepth = loading ? 6.5 : 4.5;
      const z = loading ? depth / 2 - bayDepth / 2 - 0.2 : point.z;

      sink.add('box', 'asphalt', point.x, 1.115, z, bayWidth, 0.04, bayDepth);

      for (const side of [-1, 1]) {
        sink.add(
          'box',
          loading ? 'gold' : 'white',
          point.x + (side * bayWidth) / 2,
          1.14,
          z,
          0.08,
          0.025,
          bayDepth,
        );
      }

      sink.add(
        'box',
        loading ? 'gold' : 'white',
        point.x,
        1.14,
        z - bayDepth / 2,
        bayWidth,
        0.025,
        0.08,
      );
    }
  });

  return {
    parts: object.parts,
    plot: {
      x: body.x,
      z: body.z,
      width: body.width,
      depth: body.depth,
      minX: -width / 2 + 0.15,
      maxX: width / 2 - 0.15,
      minZ: -depth / 2 + 0.15,
      maxZ: depth / 2 - 0.15,
    },
  };
}

/** The editor places a preparation pad; only a life record can make an operational warehouse. */
export function createWarehousePreparation(warehouse: Warehouse): THREE.Group {
  const group = new THREE.Group();
  const batch = new Batch();

  batch.add(
    'box',
    'paving',
    0,
    1.02,
    0,
    WAREHOUSE_WIDTH,
    0.22,
    WAREHOUSE_DEPTH,
  );

  for (const side of [-1, 1]) {
    batch.add(
      'box',
      'gold',
      side * (WAREHOUSE_WIDTH / 2 - 0.1),
      1.15,
      0,
      0.15,
      0.05,
      WAREHOUSE_DEPTH,
    );
    batch.add(
      'box',
      'gold',
      0,
      1.15,
      side * (WAREHOUSE_DEPTH / 2 - 0.1),
      WAREHOUSE_WIDTH,
      0.05,
      0.15,
    );
  }

  batch.finish(group);
  group.position.set(warehouse.center.x, 0, warehouse.center.z);
  group.rotation.y = warehouse.heading;

  return group;
}
