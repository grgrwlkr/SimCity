import * as THREE from 'three';
import {type Batch} from './primitives';
import {CITY_ROAD_WIDTH} from './trafficRoutes';
import {treeKit, propKit} from './assetKits';
import {addParts, treeParts, propParts} from './assetParts';
import {CURB_PARKING} from './life/streetParking';
import type {LifeProfile} from './life/types';
import type {CityBlock, CityLayout} from './generator';

/** The exact native sidewalk, park, vegetation and lamp recipe for one source block. */
export function drawNativeBlock(
  batch: Batch,
  layout: CityLayout,
  block: CityBlock,
  index: number,
  life?: LifeProfile,
  freightYard = false,
): {treeCount: number; lampPositions: THREE.Vector3[]} {
  let treeCount = 0;
  const plant = (x: number, z: number, scale: number) => {
    addParts(
      batch,
      treeParts(treeKit(layout.seed, `${x}/${z}`)),
      x,
      1,
      z,
      scale,
    );
    treeCount++;
  };
  const bench = (x: number, z: number, heading = 0) =>
    addParts(
      batch,
      propParts('bench', propKit(layout.seed, 'bench', `${x}/${z}`)),
      x,
      1.03,
      z,
      1,
      heading,
    );
  const lampPositions: THREE.Vector3[] = [];

  if (block.district === 'railway') {
    return {treeCount, lampPositions};
  }

  const bays = life?.bays.filter(bay => bay.blockId === block.id) ?? [];
  const curbParking = bays.length > 0;
  const cuts = bays.map(bay => {
    const f = life!.facilities[bay.facility]!;
    const vertical = f.road.direction % 2 === 1;
    const hx = (vertical ? CURB_PARKING.width : CURB_PARKING.pavedLength) / 2;
    const hz = (vertical ? CURB_PARKING.pavedLength : CURB_PARKING.width) / 2;

    return {
      minX: Math.max(block.x - 13, f.entrance.x - hx),
      maxX: Math.min(block.x + 13, f.entrance.x + hx),
      minZ: Math.max(block.z - 13, f.entrance.z - hz),
      maxZ: Math.min(block.z + 13, f.entrance.z + hz),
    };
  });

  if (curbParking) {
    const xs = [
      ...new Set([
        block.x - 13,
        block.x + 13,
        ...cuts.flatMap(c => [c.minX, c.maxX]),
      ]),
    ].sort((a, b) => a - b);
    const zs = [
      ...new Set([
        block.z - 13,
        block.z + 13,
        ...cuts.flatMap(c => [c.minZ, c.maxZ]),
      ]),
    ].sort((a, b) => a - b);

    for (let ix = 1; ix < xs.length; ix++) {
      for (let iz = 1; iz < zs.length; iz++) {
        const x = (xs[ix - 1]! + xs[ix]!) / 2;
        const z = (zs[iz - 1]! + zs[iz]!) / 2;

        if (
          !cuts.some(c => x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ)
        ) {
          batch.add(
            'box',
            'paving',
            x,
            0.91,
            z,
            xs[ix]! - xs[ix - 1]!,
            0.3,
            zs[iz]! - zs[iz - 1]!,
          );
        }
      }
    }
  } else {
    batch.add(
      'box',
      block.district === 'industrial' ? 'port' : 'paving',
      block.x,
      freightYard ? 0.7 : 0.91,
      block.z,
      26,
      0.3,
      26,
    );
  }

  let grassMinX = -11.8;
  let grassMaxX = 11.8;
  let grassMinZ = -11.8;
  let grassMaxZ = 11.8;
  const grassEdge =
    17 - CITY_ROAD_WIDTH / 2 - CURB_PARKING.width - CURB_PARKING.sidewalkWidth;

  for (const bay of bays) {
    const f = life!.facilities[bay.facility]!;

    if (f.road.direction % 2 === 1) {
      if (f.entrance.x > block.x) {
        grassMaxX = grassEdge;
      } else {
        grassMinX = -grassEdge;
      }
    } else if (f.entrance.z > block.z) {
      grassMaxZ = grassEdge;
    } else {
      grassMinZ = -grassEdge;
    }
  }

  if (block.district === 'park') {
    batch.add(
      'box',
      'grass',
      block.x + (grassMinX + grassMaxX) / 2,
      1.11,
      block.z + (grassMinZ + grassMaxZ) / 2,
      grassMaxX - grassMinX,
      0.1,
      grassMaxZ - grassMinZ,
    );
    batch.add('box', 'path', block.x, 1.18, block.z, 23.6, 0.05, 2.5);
    batch.add(
      'box',
      'path',
      block.x,
      1.18,
      block.z,
      2.5,
      0.05,
      grassMaxZ - grassMinZ,
    );

    for (const dx of [-8, -4, 5, 9]) {
      for (const dz of [-8, 7]) {
        plant(block.x + dx, block.z + dz, 1.2 + (index % 3) * 0.2);
      }
    }

    if (block.x >= -102) {
      addParts(
        batch,
        propParts('fountain', propKit(layout.seed, 'fountain', block.id)),
        block.x,
        1.1,
        block.z,
      );
    }

    bench(block.x - 6, block.z - 3);
    bench(block.x + 6, block.z + 3, Math.PI);
  } else if (
    block.district !== 'industrial' &&
    !layout.buildings.some(b => b.blockId === block.id && b.plot)
  ) {
    for (const [dx, dz] of [
      [-12, -10],
      [12, 10],
      [-12, 10],
      [12, -10],
    ]) {
      plant(block.x + dx!, block.z + dz!, 0.86);
    }
  }

  for (const side of [-1, 1]) {
    const verticalParking = bays.some(b => {
      const f = life!.facilities[b.facility]!;

      return (
        f.road.direction % 2 === 1 && Math.sign(f.entrance.x - block.x) === side
      );
    });
    const lx = block.x + side * (verticalParking ? 9.8 : 12.4);
    const lz = block.z + side * 4;

    addParts(
      batch,
      propParts('lamp', propKit(layout.seed, 'lamp', `${block.id}/${side}`)),
      lx,
      freightYard ? 0.87 : 1.03,
      lz,
      1,
      side > 0 ? 0 : Math.PI,
    );
    lampPositions.push(new THREE.Vector3(lx, 1.13, lz));
  }

  return {treeCount, lampPositions};
}
