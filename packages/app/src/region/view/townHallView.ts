import * as THREE from 'three';
import {Batch} from '../../city/primitives';
import {
  ROAD_SIDEWALK_WIDTH,
  TOWN_HALL_DEPTH,
  TOWN_HALL_ROAD_OFFSET,
  TOWN_HALL_WIDTH,
} from '../model/rules';
import type {Settlement} from '../model/types';
import {townHallLevel} from '../model/territory';

/** A modest founding hall leaves most of its civic site free for later growth. */
export function createTownHallView(
  settlement: Settlement,
  roadWidth: number,
): THREE.Group {
  const group = new THREE.Group();
  const batch = new Batch();
  const halfWidth = TOWN_HALL_WIDTH / 2;
  const halfDepth = TOWN_HALL_DEPTH / 2;
  const level = townHallLevel(settlement);

  group.position.set(settlement.center.x, 0, settlement.center.z);
  group.rotation.y = settlement.townHall?.heading ?? 0;
  group.userData = {kind: 'town-hall', settlementId: settlement.id, level};

  batch.add(
    'box',
    'grass',
    0,
    1.025,
    0,
    TOWN_HALL_WIDTH,
    0.05,
    TOWN_HALL_DEPTH,
  );

  // Low edging makes the reserved land legible without fencing off the civic entrance.
  for (const side of [-1, 1]) {
    batch.add(
      'box',
      'paving',
      side * (halfWidth - 0.3),
      1.14,
      0,
      0.6,
      0.22,
      TOWN_HALL_DEPTH,
    );
    batch.add(
      'box',
      'paving',
      side * (halfWidth / 2 + 2),
      1.14,
      halfDepth - 0.3,
      halfWidth - 4,
      0.22,
      0.6,
    );
  }

  batch.add(
    'box',
    'paving',
    0,
    1.14,
    -halfDepth + 0.3,
    TOWN_HALL_WIDTH,
    0.22,
    0.6,
  );

  batch.add('box', 'paving', 0, 1.1, 22, 40, 0.14, 22);
  batch.add('box', 'path', 0, 1.18, 22, 36, 0.04, 18);
  const sidewalkEdge =
    TOWN_HALL_ROAD_OFFSET - roadWidth / 2 - ROAD_SIDEWALK_WIDTH;
  const pathStart = 31;

  batch.add(
    'box',
    'path',
    0,
    1.11,
    (pathStart + sidewalkEdge) / 2,
    8,
    0.12,
    sidewalkEdge - pathStart + 0.08,
  );

  // Two floors, a raised stone plinth, and a sheltered central entrance.
  batch.add('box', 'paving', 0, 1.3, -2, 30, 0.5, 24);
  batch.add('box', 'cream', 0, 5.8, -2, 28, 8.6, 22);
  batch.add('box', 'trim', 0, 5.6, -2, 28.5, 0.32, 22.5);
  batch.add('box', 'trim', 0, 10.2, -2, 29.2, 0.45, 23.2);
  batch.add('hip', 'roof', 0, 11.8, -2, 30, 3.2, 24);

  for (const y of [3.45, 7.65]) {
    for (const x of [-10, -6, 6, 10]) {
      for (const side of [-1, 1]) {
        batch.add('box', 'trim', x, y, -2 + side * 11.05, 2.7, 3, 0.22);
        batch.add(
          'box',
          'window',
          x,
          y + 0.05,
          -2 + side * 11.2,
          2.05,
          2.35,
          0.12,
        );
        batch.add(
          'box',
          'trim',
          x,
          y + 0.05,
          -2 + side * 11.3,
          0.13,
          2.35,
          0.08,
        );
      }
    }

    for (const side of [-1, 1]) {
      for (const z of [-9, -2, 5]) {
        batch.add('box', 'trim', side * 14.05, y, z, 0.22, 3, 2.7);
        batch.add('box', 'window', side * 14.2, y + 0.05, z, 0.12, 2.35, 2.05);
      }
    }
  }

  for (const side of [-1, 1]) {
    batch.add('box', 'trim', side * 13.4, 5.8, 9.15, 1, 8.6, 0.5);
    batch.add('box', 'trim', side * 3.3, 3.65, 11.4, 0.7, 4.3, 0.7);
  }

  batch.add('box', 'dark', 0, 3.3, 9.2, 4.4, 3.6, 0.24);
  batch.add('box', 'gold', 0, 3.3, 9.36, 0.16, 3.6, 0.1);
  batch.add('box', 'trim', 0, 5.95, 10.7, 8, 0.5, 4.4);
  batch.add('roof', 'cream', 0, 6.85, 10.7, 8, 1.4, 4.4);
  batch.add('box', 'paving', 0, 1.28, 11.8, 9, 0.3, 5);

  // The clock tower distinguishes the founding building at regional camera scales.
  batch.add('box', 'cream', 0, 13.4, 1, 5.8, 6.6, 5.8);
  batch.add('box', 'trim', 0, 16.7, 1, 6.5, 0.5, 6.5);
  batch.add('hip', 'teal', 0, 18.2, 1, 7, 2.7, 7);
  batch.add('cylinder', 'gold', 0, 19.9, 1, 0.35, 1, 0.35);

  for (const side of [-1, 1]) {
    const z = 1 + side * 2.98;

    batch.add('cylinder', 'trim', 0, 14.7, z, 2.8, 0.15, 2.8, 0, Math.PI / 2);
    batch.add('box', 'dark', 0, 15.08, z + side * 0.12, 0.14, 0.95, 0.08);
    batch.add('box', 'dark', 0.35, 14.7, z + side * 0.12, 0.8, 0.14, 0.08);
  }

  for (const side of [-1, 1]) {
    for (const z of [-28, -8, 14, 31]) {
      const x = side * 40;

      batch.add('cylinder', 'paving', x, 1.16, z, 7, 0.22, 7);
      batch.add('cylinder', 'grassDark', x, 1.31, z, 6.4, 0.12, 6.4);
      batch.add('cylinder', 'trunk', x, 3.3, z, 0.65, 4, 0.65);
      batch.add('leaf', 'green', x, 6.3, z, 6.3, 6.6, 6.3);
    }

    for (const z of [17, 27]) {
      batch.add('box', 'paving', side * 16, 1.4, z, 4, 0.55, 3);
      batch.add('leaf', 'sage', side * 16, 2, z, 3.7, 1.6, 2.7);
      batch.add('box', 'trunk', side * 11.5, 1.9, z, 0.9, 0.2, 3.6);
      batch.add('box', 'metal', side * 11.5, 1.48, z, 0.55, 0.7, 2.6);
    }
  }

  // Added wings occupy the reserved lawns as the civic building improves.
  for (const side of [-1, 1]) {
    if (level < (side === -1 ? 2 : 3)) {
      continue;
    }

    const x = side * 22;

    batch.add('box', 'paving', x, 1.3, -4, 17, 0.5, 21);
    batch.add('box', 'cream', x, 5.8, -4, 16, 8.6, 20);
    batch.add('box', 'trim', x, 5.6, -4, 16.5, 0.32, 20.5);
    batch.add('box', 'trim', x, 10.2, -4, 17, 0.45, 21);
    batch.add('hip', 'roof', x, 11.6, -4, 17.5, 2.8, 21.5);

    for (const y of [3.45, 7.65]) {
      for (const offset of [-5, 0, 5]) {
        batch.add('box', 'trim', x + offset, y, 6.1, 2.7, 3, 0.22);
        batch.add(
          'box',
          'window',
          x + offset,
          y + 0.05,
          6.25,
          2.05,
          2.35,
          0.12,
        );
        batch.add('box', 'trim', side * 30.1, y, -4 + offset, 0.22, 3, 2.7);
        batch.add(
          'box',
          'window',
          side * 30.25,
          y + 0.05,
          -4 + offset,
          0.12,
          2.35,
          2.05,
        );
      }
    }
  }

  if (level >= 4) {
    batch.add('box', 'paving', 0, 1.3, -22, 61, 0.5, 21);
    batch.add('box', 'cream', 0, 7.5, -22, 60, 12, 20);
    batch.add('box', 'trim', 0, 13.6, -22, 61, 0.45, 21);
    batch.add('hip', 'roof', 0, 15, -22, 62, 2.6, 22);

    for (const y of [3.6, 7.5, 11.4]) {
      for (const x of [-25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25]) {
        batch.add('box', 'trim', x, y, -32.1, 2.7, 3, 0.22);
        batch.add('box', 'window', x, y + 0.05, -32.25, 2.05, 2.35, 0.12);
      }
    }
  }

  batch.finish(group);

  return group;
}
