import * as THREE from 'three';
import {Batch, material} from './primitives';
import {treeKit} from './assetKits';
import {addParts, treeParts} from './assetParts';
import {gridForLayout} from './cityGrid';
import type {CityLayout} from './generator';
import {generateTerrain} from '../region/model/terrain';
import {seededRandom} from '../region/model/random';
import {
  isDryFootprint,
  rectangle,
  pointInPolygon,
} from '../region/model/geometry';
import type {Bounds, Point, Terrain} from '../region/model/types';

export interface NativeRegionGeography {
  readonly kind: 'native-region';
  readonly terrain: Terrain;
}

/** Generate the existing regional terrain without flooding the preserved native fixture. */
export function createNativeRegionGeography(
  layout: CityLayout,
  size = 4000,
): NativeRegionGeography {
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('Размер региона должен быть положительным');
  }

  const terrain = generateTerrain(layout.seed, size);
  const city = gridForLayout(layout).bounds;
  const water = terrain.water.map(polygon => {
    const minX = Math.min(...polygon.map(point => point.x));
    const maxX = Math.max(...polygon.map(point => point.x));
    const minZ = Math.min(...polygon.map(point => point.z));
    const maxZ = Math.max(...polygon.map(point => point.z));
    const overlaps =
      minX < city.maxX + 32 &&
      maxX > city.minX - 32 &&
      minZ < city.maxZ + 32 &&
      maxZ > city.minZ - 32;
    const shift = overlaps ? city.maxX + 32 - minX : 0;

    return polygon.map(point => ({x: point.x + shift, z: point.z}));
  });
  const definition: NativeRegionGeography = {
    kind: 'native-region',
    terrain: {...terrain, water},
  };

  validateGeography(definition, city);

  return definition;
}

function footprint(bounds: Bounds): Point[] {
  return rectangle(
    {x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2},
    bounds.maxX - bounds.minX,
    bounds.maxZ - bounds.minZ,
  );
}

function validateGeography(
  definition: NativeRegionGeography,
  city: Bounds,
): void {
  const {bounds, water} = definition.terrain;

  if (
    bounds.minX >= city.minX ||
    bounds.maxX <= city.maxX ||
    bounds.minZ >= city.minZ ||
    bounds.maxZ <= city.maxZ ||
    water.some(polygon =>
      polygon.some(
        point =>
          point.x < bounds.minX ||
          point.x > bounds.maxX ||
          point.z < bounds.minZ ||
          point.z > bounds.maxZ,
      ),
    ) ||
    !isDryFootprint(definition.terrain, footprint(city))
  ) {
    throw new Error(
      'География региона пересекает сохранённый город или границы',
    );
  }
}

/** Add surrounding geography only; native streets, buildings and waterfront remain intact. */
export function createNativeRegionView(
  layout: CityLayout,
  definition: NativeRegionGeography,
  options: {
    preserveCity?: boolean;
    occupied?: ReadonlyArray<readonly Point[]>;
  } = {},
): {group: THREE.Group; treeCount: number; dispose: () => void} {
  const city = gridForLayout(layout).bounds;

  if (options.preserveCity !== false) {
    validateGeography(definition, city);
  }

  const {bounds, water, seed} = definition.terrain;
  const group = new THREE.Group();
  const ownedGeometry: THREE.BufferGeometry[] = [];
  const ownedMaterials: THREE.Material[] = [];
  const vectors = (points: readonly Point[]) =>
    points.map(point => new THREE.Vector2(point.x, -point.z));

  group.name = 'native-region-geography';
  const groundShape = new THREE.Shape(vectors(footprint(bounds)));

  // This hole excludes the entire original base, including its native harbor water.
  if (options.preserveCity !== false) {
    groundShape.holes.push(new THREE.Path(vectors(footprint(city))));
  }

  function surface(
    shape: THREE.Shape,
    color: string,
    y: number,
    order: number,
  ): THREE.Mesh {
    const geometry = new THREE.ShapeGeometry(shape);
    const paint = material(color).clone();

    ownedGeometry.push(geometry);
    ownedMaterials.push(paint);
    paint.depthWrite = color === 'grass';
    const mesh = new THREE.Mesh(geometry, paint);

    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = y;
    mesh.receiveShadow = true;
    mesh.renderOrder = order;
    group.add(mesh);

    return mesh;
  }

  const ground = surface(groundShape, 'grass', 0.72, 0);

  ground.name = 'regional-ground';

  for (const [index, polygon] of water.entries()) {
    const center = polygon.reduce(
      (sum, point) => ({
        x: sum.x + point.x / polygon.length,
        z: sum.z + point.z / polygon.length,
      }),
      {x: 0, z: 0},
    );
    const shore = polygon.map(point => ({
      x: THREE.MathUtils.clamp(
        center.x + (point.x - center.x) * 1.012,
        bounds.minX,
        bounds.maxX,
      ),
      z: THREE.MathUtils.clamp(
        center.z + (point.z - center.z) * 1.012,
        bounds.minZ,
        bounds.maxZ,
      ),
    }));

    surface(new THREE.Shape(vectors(shore)), 'path', 0.735, 1).name =
      `regional-shore-${index}`;
    surface(new THREE.Shape(vectors(polygon)), 'water', 0.75, 2).name =
      `regional-water-${index}`;
  }

  const trees = new Batch();
  let treeCount = 0;

  for (let x = bounds.minX; x < bounds.maxX; x += 256) {
    for (let z = bounds.minZ; z < bounds.maxZ; z += 256) {
      const width = Math.min(256, bounds.maxX - x);
      const depth = Math.min(256, bounds.maxZ - z);
      const random = seededRandom(`${seed}/vegetation/${x}/${z}`);

      for (let index = 0; index < 18; index++) {
        const point = {
          x: x + 12 + random() * Math.max(0, width - 24),
          z: z + 12 + random() * Math.max(0, depth - 24),
        };
        const withinCity =
          options.preserveCity !== false &&
          point.x >= city.minX - 12 &&
          point.x <= city.maxX + 12 &&
          point.z >= city.minZ - 12 &&
          point.z <= city.maxZ + 12;

        if (
          withinCity ||
          options.occupied?.some(polygon => pointInPolygon(point, polygon)) ||
          !isDryFootprint(definition.terrain, rectangle(point, 12, 12))
        ) {
          continue;
        }

        addParts(
          trees,
          treeParts(treeKit(layout.seed, `region/${x}/${z}/${index}`)),
          point.x,
          0.72,
          point.z,
          1,
        );
        treeCount++;
      }
    }
  }

  const forest = new THREE.Group();

  forest.name = 'regional-forest';
  trees.finish(forest);
  group.add(forest);

  return {
    group,
    treeCount,
    dispose() {
      // createCity owns instanced-mesh disposal, including this nested forest.
      for (const geometry of ownedGeometry) {
        geometry.dispose();
      }

      for (const paint of ownedMaterials) {
        paint.dispose();
      }
    },
  };
}
