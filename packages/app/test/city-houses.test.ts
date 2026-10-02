import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/city/generator';
import * as THREE from 'three';
import { geometries, material, type Batch } from '../src/city/primitives';
import { houseAnnexModules, houseGardenModules } from '../src/city/housePlots';
import { createCity } from '../src/city/model';

describe('single-storey houses with private plots', () => {
  it.each(['689856', 'harbor', 'suburb'])('creates varied reproducible private houses for %s', (seed) => {
    const city = generateCity(seed),
      houses = city.buildings.filter((b) => b.variant === 'cottage');
    expect(houses.length).toBeGreaterThan(32);
    expect(generateCity(seed, false).buildings.filter((b) => b.plot)).toHaveLength(32);
    expect(city).toEqual(generateCity(seed));
    expect(new Set(houses.map((b) => JSON.stringify([b.kit, b.plot]))).size).toBeGreaterThan(20);
    expect(new Set(houses.map((b) => b.plot!.fence)).size).toBe(3);
    expect(new Set(houses.map((b) => b.plot!.annex)).size).toBe(3);
    for (const house of houses) {
      expect(house.floors).toBe(1);
      expect(house.height).toBeLessThan(3.5);
      expect(house.kit.balconies).toBe('none');
      const lot = house.plot!,
        block = city.blocks.find((b) => b.id === house.blockId)!;
      expect(lot.front).toBe(lot.z < block.z ? 'north' : 'south');
      expect(Math.abs(lot.x - block.x) + lot.width / 2).toBeLessThan(13);
      expect(Math.abs(lot.z - block.z) + lot.depth / 2).toBeLessThan(13);
      expect(Math.abs(house.x - lot.x) + house.width / 2).toBeLessThan(lot.width / 2);
      expect(Math.abs(house.z - lot.z) + house.depth / 2).toBeLessThan(lot.depth / 2);
      for (const other of houses.filter((b) => b.id !== house.id && b.blockId === house.blockId)) {
        expect(Math.abs(lot.x - other.plot!.x) >= lot.width || Math.abs(lot.z - other.plot!.z) >= lot.depth).toBe(true);
      }
    }
  });

  it('keeps garden and outbuilding geometry within its own fenced parcel', () => {
    for (const seed of ['689856', 'harbor', 'suburb']) {
      for (const b of generateCity(seed).buildings.filter((b) => b.plot)) {
        const parts: Array<Parameters<Batch['add']>> = [];
        const sink = {
          add: (...part: Parameters<Batch['add']>) => {
            parts.push(part);
          },
        };
        houseGardenModules(sink, b, seed);
        houseAnnexModules(sink, b);
        const matrix = new THREE.Object3D(),
          plot = b.plot!;
        for (const [shape, , x, y, z, w, h, d, ry = 0, rx = 0, rz = 0] of parts) {
          expect([w, h, d].every((n) => n > 0 && Number.isFinite(n))).toBe(true);
          matrix.position.set(x, y, z);
          matrix.scale.set(w, h, d);
          matrix.rotation.set(rx, ry, rz);
          matrix.updateMatrix();
          const geometry = geometries[shape];
          geometry.computeBoundingBox();
          const bounds = geometry.boundingBox!.clone().applyMatrix4(matrix.matrix);
          expect(bounds.min.x, b.id).toBeGreaterThanOrEqual(plot.x - plot.width / 2 - 0.001);
          expect(bounds.max.x, b.id).toBeLessThanOrEqual(plot.x + plot.width / 2 + 0.001);
          expect(bounds.min.z, b.id).toBeGreaterThanOrEqual(plot.z - plot.depth / 2 - 0.001);
          expect(bounds.max.z, b.id).toBeLessThanOrEqual(plot.z + plot.depth / 2 + 0.001);
        }
      }
    }
  });

  it('removes permanent landscaping during construction and restores the same completed plot', () => {
    const layout = generateCity('689856'),
      b = layout.buildings.find((b) => b.plot)!;
    const city = createCity(layout);
    const lawn = city.group.children.find(
      (o) => o instanceof THREE.InstancedMesh && o.material === material('grass'),
    ) as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    const index = Array.from({ length: lawn.count }, (_, i) => i).find((i) => {
      lawn.getMatrixAt(i, m);
      return m.elements[12] === b.plot!.x && m.elements[14] === b.plot!.z;
    })!;
    expect(index).toBeDefined();
    const original = Array.from(lawn.instanceMatrix.array);
    city.construction.start(b.id, false);
    lawn.getMatrixAt(index, m);
    expect(m.elements[0]).toBe(0);
    city.construction.seek(1);
    expect(Array.from(lawn.instanceMatrix.array)).toEqual(original);
    city.dispose();
  });
});
