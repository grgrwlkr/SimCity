import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/city/generator';

describe('city layout generation', () => {
  it('recreates the city from its seed and changes buildings for a different seed', () => {
    expect(generateCity('river')).toEqual(generateCity('river'));
    expect(generateCity('river').buildings).not.toEqual(generateCity('harbor').buildings);
  });

  it.each(['1206', 'harbor', '0'])('keeps buildings inside blocks and separates the districts for seed %s', (seed) => {
    const city = generateCity(seed);
    expect(city.buildings.length).toBeGreaterThan(150);
    for (const district of ['downtown', 'commercial', 'residential', 'industrial']) {
      expect(city.buildings.filter((b) => b.district === district).length).toBeGreaterThan(10);
    }
    expect(city.buildings.filter((b) => b.height > 65).length).toBeGreaterThan(8);
    expect(new Set(city.buildings.filter((b) => b.district === 'industrial').map((b) => b.variant)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(city.buildings.map((b) => b.id)).size).toBe(city.buildings.length);
    for (const building of city.buildings) {
      const block = city.blocks.find((b) => b.id === building.blockId)!;
      expect(Math.abs(building.x - block.x) + building.width / 2).toBeLessThanOrEqual(13);
      expect(Math.abs(building.z - block.z) + building.depth / 2).toBeLessThanOrEqual(13);
      expect(building.height).toBeGreaterThan(0);
      expect(Number.isFinite(building.height)).toBe(true);
    }
    for (let i = 0; i < city.buildings.length; i++) {
      const a = city.buildings[i]!;
      for (const b of city.buildings.slice(i + 1).filter((b) => b.blockId === a.blockId)) {
        expect(Math.abs(a.x - b.x) >= (a.width + b.width) / 2 + 0.4 || Math.abs(a.z - b.z) >= (a.depth + b.depth) / 2 + 0.4).toBe(true);
      }
    }
  });
});
