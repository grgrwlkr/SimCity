// Map generation: crates/simcity_sim/src/game/map/tests.rs (`map_generation_is_deterministic_for_seed`)
// plus byte parity with the Rust generator (fixture from examples/dump_map.rs).
import { describe, expect, it } from 'vitest';
import { generateMapIntoGrid } from '../../src/map/generation';
import { MapGrid } from '../../src/map/grid';
import fixture from '../fixtures/map-generation.json';

function snapshotCells(grid: MapGrid) {
  return Array.from({ length: grid.len() }, (_, i) => grid.cellAt(i));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('map generation', () => {
  it('mapGenerationIsDeterministicForSeed', () => {
    const a = new MapGrid(32, 32);
    const b = new MapGrid(32, 32);
    generateMapIntoGrid(a, 123n);
    generateMapIntoGrid(b, 123n);
    expect(snapshotCells(a)).toEqual(snapshotCells(b));
  });

  it('mapGenerationMatchesRust', () => {
    expect(fixture.maps.length).toBeGreaterThan(0);
    for (const map of fixture.maps) {
      const grid = new MapGrid(map.width, map.height);
      generateMapIntoGrid(grid, BigInt(map.seed));
      expect(hex(grid.elevation), `height, seed ${map.seed}`).toBe(map.heightHex);
      expect(hex(grid.water), `water, seed ${map.seed}`).toBe(map.waterHex);
    }
  });
});
