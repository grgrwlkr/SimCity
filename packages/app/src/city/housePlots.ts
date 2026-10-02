import type { CityBuilding } from './generator';
import type { Batch } from './primitives';
import { addParts, treeParts } from './assetParts';
import { treeKit } from './assetKits';
import { lowriseModules } from './buildingModules';

type Sink = Pick<Batch, 'add'>;

function plotSpace(batch: Sink, b: CityBuilding): { batch: Sink; house: CityBuilding } {
  const p = b.plot;
  if (!p || p.front === 'south') {
    return { batch, house: b };
  }
  // Rotate the complete assembly towards the street, including gates, paths and annex doors.
  return {
    house: { ...b, x: 2 * p.x - b.x, z: 2 * p.z - b.z },
    batch: {
      add: (shape, color, x, y, z, w, h, d, ry = 0, rx = 0, rz = 0) =>
        batch.add(shape, color, 2 * p.x - x, y, 2 * p.z - z, w, h, d, ry + Math.PI, -rx, rz),
    },
  };
}

export function houseBodyModules(batch: Sink, b: CityBuilding): void {
  const local = plotSpace(batch, b);
  lowriseModules(local.batch, local.house);
}

export function houseAnnexModules(batch: Sink, b: CityBuilding): void {
  const local = plotSpace(batch, b);
  batch = local.batch;
  b = local.house;
  const p = b.plot;
  if (!p || p.annex === 'none') {
    return;
  }
  const garage = p.annex === 'garage',
    x = p.x + 3.6,
    z = p.z + (garage ? -1.8 : -3.2);
  const w = garage ? 2.7 : 2.2,
    d = garage ? 4.4 : 2.4,
    h = garage ? 2.5 : 2;
  batch.add('box', 'paving', x, 1.1, z, w + 0.2, 0.16, d + 0.2);
  batch.add('box', garage ? b.color : 'trunk', x, 1.08 + h / 2, z, w, h, d);
  batch.add(
    garage ? 'box' : 'roof',
    p.roofColor,
    x,
    1.18 + h + (garage ? 0 : 0.3),
    z,
    w + 0.3,
    garage ? 0.2 : 0.65,
    d + 0.3,
  );
  batch.add('box', 'dark', x, 2.08, z + d / 2 + 0.025, garage ? 2.08 : 0.75, garage ? 1.9 : 1.6, 0.08);
  if (garage) {
    for (let i = 0; i < 6; i++) {
      batch.add('box', 'metal', x, 2.83 + i * 0.045, z + d / 2 + 0.08, 2, 0.035, 0.035);
    }
  } else {
    batch.add('box', 'gold', x + 0.23, 1.95, z + d / 2 + 0.08, 0.06, 0.16, 0.05);
  }
}

/** Garden modules belong to the completed home and disappear while its fenced building site is active. */
export function houseGardenModules(batch: Sink, b: CityBuilding, seed: string): number {
  const local = plotSpace(batch, b);
  batch = local.batch;
  b = local.house;
  const p = b.plot;
  if (!p) {
    return 0;
  }
  const y = 1.08,
    left = p.x - p.width / 2 + 0.3,
    right = p.x + p.width / 2 - 0.3;
  const back = p.z - p.depth / 2 + 0.3,
    front = p.z + p.depth / 2 - 0.3;
  batch.add('box', 'grass', p.x, y, p.z, p.width - 0.12, 0.035, p.depth - 0.12);
  const doorstep = b.z + b.depth / 2;
  batch.add('box', 'path', b.x, y + 0.035, (doorstep + front) / 2, 1.05, 0.035, front - doorstep);
  batch.add('box', 'paving', p.x + 3.6, y + 0.035, (p.z + 0.4 + front) / 2, 2.6, 0.035, front - p.z - 0.4);

  function fence(ax: number, az: number, bx: number, bz: number): void {
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 0.08) {
      return;
    }
    const angle = Math.atan2(bx - ax, bz - az),
      n = Math.ceil(length / (p!.fence === 'hedge' ? 1.1 : 0.65));
    const color = p!.fence === 'picket' ? 'trim' : 'trunk';
    if (p!.fence === 'hedge') {
      for (let i = 0; i < n; i++) {
        batch.add(
          'leaf',
          i % 2 ? 'green' : 'forest',
          ax + ((bx - ax) * (i + 0.5)) / n,
          y + 0.5,
          az + ((bz - az) * (i + 0.5)) / n,
          0.55,
          1.05,
          length / n + 0.15,
          angle,
        );
      }
      return;
    }
    for (let i = 0; i <= n; i++) {
      batch.add('box', color, ax + ((bx - ax) * i) / n, y + 0.52, az + ((bz - az) * i) / n, 0.09, 1.04, 0.09, angle);
    }
    for (const height of p!.fence === 'slats' ? [0.25, 0.55, 0.85] : [0.3, 0.77]) {
      batch.add(
        'box',
        color,
        (ax + bx) / 2,
        y + height,
        (az + bz) / 2,
        0.085,
        p!.fence === 'slats' ? 0.19 : 0.08,
        length,
        angle,
      );
    }
  }
  fence(left, back, right, back);
  fence(left, back, left, front);
  fence(right, back, right, front);
  const gates = [[b.x - 0.7, b.x + 0.7]];
  gates.push([p.x + 2.15, p.x + 5.05]);
  let cursor = left;
  for (const [start, end] of gates) {
    fence(cursor, front, start!, front);
    cursor = end!;
  }
  fence(cursor, front, right, front);
  batch.add('box', 'trunk', b.x + 0.94, y + 0.53, front - 0.13, 0.1, 1.06, 0.1);
  batch.add('box', b.color, b.x + 0.94, y + 1.05, front - 0.13, 0.38, 0.27, 0.3);

  if (p.porch === 'deck' || p.garden === 'lawn') {
    batch.add('box', 'trunk', b.x, y + 0.12, doorstep + 0.65, Math.min(4.4, b.width), 0.19, 1.3);
    for (let i = 0; i < 6; i++) {
      batch.add('box', 'cream', b.x - 1.65 + i * 0.65, y + 0.224, doorstep + 0.65, 0.035, 0.015, 1.23);
    }
    batch.add('box', 'gold', b.x + 1.25, y + 0.57, doorstep + 0.65, 1.25, 0.15, 0.5);
    batch.add('box', 'gold', b.x + 1.25, y + 0.88, doorstep + 0.4, 1.25, 0.5, 0.1);
    for (const dx of [-0.42, 0.42]) {
      batch.add('box', 'metal', b.x + 1.25 + dx, y + 0.35, doorstep + 0.65, 0.1, 0.42, 0.4);
    }
  }
  if (p.garden === 'flowers') {
    for (const x of [p.x - 4.45, p.x + 0.9]) {
      batch.add('box', 'cream', x, y + 0.13, p.z + 3.95, 1.35, 0.22, 2.25);
      batch.add('box', 'trunk', x, y + 0.26, p.z + 3.95, 1.15, 0.07, 2.03);
      for (let i = 0; i < 5; i++) {
        batch.add('leaf', 'green', x, y + 0.46, p.z + 3.1 + i * 0.4, 0.8, 0.45, 0.5);
        batch.add('sphere', i % 2 ? 'yellow' : 'coral', x, y + 0.67, p.z + 3.1 + i * 0.4, 0.28, 0.24, 0.28);
      }
    }
  }
  const treePositions =
    p.garden === 'orchard'
      ? [
          [p.x - 4.25, p.z + 3.4],
          [p.x + 0.85, p.z + 4.1],
        ]
      : [[p.x + 0.85, p.z + 4.1]];
  for (const [i, position] of treePositions.entries()) {
    addParts(batch, treeParts(treeKit(seed, `${b.id}/garden/${i}`)), position[0]!, y, position[1]!, 0.42);
  }
  return treePositions.length;
}
