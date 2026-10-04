import type {Batch} from './primitives';
import {ORIGINAL_HARBOR_LAYOUT} from './harborLayout';
import type {HarborLayout} from './harborLayout';

/** Exact original quay, loading-pad and crane-transfer foundation recipe. */
export function drawNativePortFoundation(
  batch: Pick<Batch, 'add'>,
  layout: HarborLayout = ORIGINAL_HARBOR_LAYOUT,
): void {
  batch.add('box', 'port', 85, 0.5, 135, 76, 0.7, 24);
  batch.add('box', 'asphalt', 85, 0.875, 138, 76, 0.04, 4);

  for (const x of [51, 85, 119]) {
    batch.add('box', 'asphalt', x, 0.875, 129.5, 8, 0.04, 21);
  }

  for (const x of layout.berths) {
    batch.add('box', 'port', x, 0.85, 144.3, 22, 0.8, 5.4);

    for (const offset of [-5, 0, 5]) {
      for (const z of [142.8, 145.8]) {
        batch.add('box', 'cream', x + offset, 1.26, z - 1, 4.8, 0.025, 0.08);
        batch.add('box', 'cream', x + offset, 1.26, z + 1, 4.8, 0.025, 0.08);
      }
    }
  }

  for (const yard of layout.warehouses) {
    batch.add('box', 'asphalt', yard.x, 0.875, yard.z + 6, 26, 0.04, 4);

    for (const offset of [-5, 5]) {
      batch.add(
        'box',
        'gold',
        yard.x + offset,
        0.902,
        yard.z + 6,
        0.13,
        0.02,
        3.6,
      );
    }

    batch.add('box', 'metal', yard.x, 0.91, yard.z - 1, 2.2, 0.1, 6);

    for (let n = 0; n < 9; n++) {
      batch.add(
        'box',
        'steel',
        yard.x,
        0.98,
        yard.z - 3.6 + n * 0.65,
        2,
        0.05,
        0.13,
      );
    }
  }
}
