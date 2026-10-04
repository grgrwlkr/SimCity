import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import {generateCity} from '../src/city/generator';
import {createCity} from '../src/city/model';
import {createLifeProfile} from '../src/city/life/network';
import {createNativeRegionGeography} from '../src/city/regionGeography';
import {gridForLayout} from '../src/city/cityGrid';
import {isDryFootprint, rectangle} from '../src/region/model/geometry';
import {CityLife} from '../src/city/life/world';

function positionAttribute(
  value: unknown,
): THREE.BufferAttribute | THREE.InterleavedBufferAttribute {
  if (!(value instanceof THREE.BufferGeometry)) {
    throw new Error('Missing mesh geometry');
  }

  const attribute: unknown = value.getAttribute('position');

  if (
    attribute instanceof THREE.BufferAttribute ||
    attribute instanceof THREE.InterleavedBufferAttribute
  ) {
    return attribute;
  }

  throw new Error('Missing geometry positions');
}

function nativeGeometry(group: THREE.Group): string {
  const hash = createHash('sha256');

  group.traverse(object => {
    hash.update(
      JSON.stringify([
        object.type,
        object.position.toArray(),
        object.quaternion.toArray(),
        object.scale.toArray(),
      ]),
    );

    if (
      object instanceof THREE.Mesh &&
      object.geometry instanceof THREE.BufferGeometry
    ) {
      const positions = positionAttribute(object.geometry).array;
      const indices = object.geometry.getIndex()?.array;

      if (indices) {
        hash.update(
          Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength),
        );
      }

      hash.update(
        Buffer.from(
          positions.buffer,
          positions.byteOffset,
          positions.byteLength,
        ),
      );
    }
    if (object instanceof THREE.InstancedMesh) {
      const matrices = object.instanceMatrix.array;

      hash.update(
        Buffer.from(matrices.buffer, matrices.byteOffset, matrices.byteLength),
      );
    }
  });

  return hash.digest('hex');
}

describe('native city surrounded by regional geography', () => {
  it('adds 4 km bounds while retaining every native object and transform', () => {
    const layout = generateCity('689856');
    const profile = createLifeProfile(layout);
    const original = createCity(layout, profile);
    const expanded = createCity(
      layout,
      profile,
      createNativeRegionGeography(layout),
    );
    const geography = expanded.group.getObjectByName('native-region-geography');

    expect(geography).toBeDefined();
    const bounds = new THREE.Box3().setFromObject(geography!);

    expect(bounds.min.x).toBe(-2000);
    expect(bounds.max.x).toBe(2000);
    expect(bounds.min.z).toBe(-2000);
    expect(bounds.max.z).toBe(2000);
    expanded.group.remove(geography!);
    expect(nativeGeometry(expanded.group)).toBe(nativeGeometry(original.group));
    expect(expanded.hitboxes.map(box => box.position.toArray())).toEqual(
      original.hitboxes.map(box => box.position.toArray()),
    );
    expect(expanded.group.scale.toArray()).toEqual([1, 1, 1]);
    expanded.group.add(geography!);
    expanded.dispose();
    original.dispose();
  });

  it.each(['689856', '1206', '1', 'forest'])(
    'retains a continuous edge-to-edge river for seed %s',
    seed => {
      const layout = generateCity(seed);
      const definition = createNativeRegionGeography(layout);
      const {terrain} = definition;
      const river = terrain.water[1]!;
      const city = gridForLayout(layout).bounds;

      expect(terrain.water).toHaveLength(2);
      expect(river).toHaveLength(130);
      expect(river[0]!.z).toBe(terrain.bounds.minZ);
      expect(river[64]!.z).toBe(terrain.bounds.maxZ);

      for (let index = 0; index < 65; index++) {
        const left = river[index]!;
        const right = river[129 - index]!;

        expect(right.z).toBe(left.z);
        expect(right.x).toBeGreaterThan(left.x);

        if (index) {
          expect(left.z).toBeGreaterThan(river[index - 1]!.z);
        }
      }

      expect(
        isDryFootprint(
          terrain,
          rectangle(
            {x: (city.minX + city.maxX) / 2, z: (city.minZ + city.maxZ) / 2},
            city.maxX - city.minX,
            city.maxZ - city.minZ,
          ),
        ),
      ).toBe(true);
      expect(structuredClone(definition)).toEqual(definition);
    },
  );

  it('keeps the surrounding ground out of the original base and disposes its owned surfaces', () => {
    const layout = generateCity('689856');
    const city = createCity(
      layout,
      createLifeProfile(layout),
      createNativeRegionGeography(layout),
    );
    const ground = city.group.getObjectByName('regional-ground');
    const forest = city.group.getObjectByName('regional-forest');
    const native = gridForLayout(layout).bounds;

    expect(ground).toBeInstanceOf(THREE.Mesh);
    expect(forest).toBeInstanceOf(THREE.Group);
    expect(forest!.children.length).toBeGreaterThan(0);
    expect(forest!.scale.toArray()).toEqual([1, 1, 1]);

    if (
      !(ground instanceof THREE.Mesh) ||
      !(ground.geometry instanceof THREE.BufferGeometry)
    ) {
      throw new Error('Missing regional ground mesh');
    }

    ground.updateMatrixWorld(true);
    const positions = positionAttribute(ground.geometry);
    const indices = ground.geometry.getIndex()!;

    for (let index = 0; index < indices.count; index += 3) {
      const center = new THREE.Vector3();

      for (let vertex = 0; vertex < 3; vertex++) {
        center.add(
          new THREE.Vector3().fromBufferAttribute(
            positions,
            indices.getX(index + vertex),
          ),
        );
      }

      center.divideScalar(3).applyMatrix4(ground.matrixWorld);
      expect(
        center.x > native.minX &&
          center.x < native.maxX &&
          center.z > native.minZ &&
          center.z < native.maxZ,
      ).toBe(false);
    }

    const disposed = vi.spyOn(ground.geometry, 'dispose');

    city.dispose();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('adds geography without modifying the authoritative native life snapshot', () => {
    const layout = generateCity('689856');
    const life = new CityLife(layout.seed, 3);

    life.advance(18);
    const before = life.save();
    const city = createCity(
      layout,
      life.profile,
      createNativeRegionGeography(layout),
    );

    city.applyLife(life.frame());
    expect(life.save()).toEqual(before);
    city.dispose();
  });
});
