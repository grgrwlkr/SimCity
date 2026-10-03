import {describe, expect, it} from 'vitest';
import {generateTerrain} from '../src/region/model/terrain';
import {isDryFootprint, normalizePoint} from '../src/region/model/geometry';
import {createRegion} from '../src/region/model/world';

describe('empty regional world', () => {
  it('normalizes tiny coordinates without JSON-changing negative zero', () => {
    expect(Object.is(normalizePoint({x: -0.001, z: -0.001}).x, -0)).toBe(false);
  });
  it('starts without automatic roads, parcels or settlements', () => {
    const world = createRegion('one', 'region-a');

    expect(world.terrain.bounds).toEqual({
      minX: -2000,
      maxX: 2000,
      minZ: -2000,
      maxZ: 2000,
    });
    expect([
      world.settlements,
      world.roads,
      world.parcels,
      world.warehouses,
    ]).toEqual([[], [], [], []]);
    expect(world.cash).toBe(1_000_000);
  });
  it('reproduces the terrain independently of the region identity', () => {
    expect(generateTerrain('region-a', 4000)).toEqual(
      generateTerrain('region-a', 4000),
    );
    expect(createRegion('one', 'region-a').terrain).toEqual(
      createRegion('two', 'region-a').terrain,
    );
    expect(generateTerrain('region-b', 4000).water).not.toEqual(
      generateTerrain('region-a', 4000).water,
    );
  });
  it('rejects a footprint covering water although all corners are dry', () => {
    const terrain = {
      seed: 'test',
      bounds: {minX: -2000, maxX: 2000, minZ: -2000, maxZ: 2000},
      water: [
        [
          {x: 200, z: 200},
          {x: 400, z: 200},
          {x: 400, z: 400},
          {x: 200, z: 400},
        ],
      ],
    };

    expect(
      isDryFootprint(terrain, [
        {x: 100, z: 100},
        {x: 500, z: 100},
        {x: 500, z: 500},
        {x: 100, z: 500},
      ]),
    ).toBe(false);
    expect(
      isDryFootprint(terrain, [
        {x: -50, z: -50},
        {x: 50, z: -50},
        {x: 50, z: 50},
        {x: -50, z: 50},
      ]),
    ).toBe(true);
  });
});
