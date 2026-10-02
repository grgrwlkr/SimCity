import { expect, it } from 'vitest';
import { addStreetCrossings, streetCrossings } from '../src/city/streetCrossings';
import { CITY_GRID, LEGACY_CITY_GRID } from '../src/city/cityGrid';
import type { Batch } from '../src/city/primitives';

it.each([LEGACY_CITY_GRID, CITY_GRID])('draws crossings across both lanes within grid $minColumn', (grid) => {
  const parts: Array<Parameters<Batch['add']>> = [];
  addStreetCrossings(
    {
      add: (...p) => {
        parts.push(p);
      },
    },
    false,
    grid.roads,
  );
  expect(streetCrossings(false, grid.roads)).toHaveLength(4 * grid.roads.length * (grid.roads.length - 1));
  for (const crossing of streetCrossings(false, grid.roads)) {
    const stripes = parts.filter(([, , x, , z]) =>
      crossing.axis === 'x'
        ? Math.abs(z - crossing.z) < 0.01 && Math.abs(x - crossing.x) < 4
        : Math.abs(x - crossing.x) < 0.01 && Math.abs(z - crossing.z) < 4,
    );
    expect(stripes).toHaveLength(10);
    const positions = stripes.map((p) => (crossing.axis === 'x' ? p[2] : p[4]));
    expect(Math.max(...positions) - Math.min(...positions)).toBeCloseTo(7.2);
    for (const [, , x, , z, w, , d] of stripes) {
      expect(x - w / 2).toBeGreaterThanOrEqual(grid.roads[0]! - 4);
      expect(x + w / 2).toBeLessThanOrEqual(grid.roads.at(-1)! + 4);
      expect(z - d / 2).toBeGreaterThanOrEqual(grid.roads[0]! - 4);
      expect(z + d / 2).toBeLessThanOrEqual(grid.roads.at(-1)! + 4);
    }
  }
});
