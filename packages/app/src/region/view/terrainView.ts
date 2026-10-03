import * as THREE from 'three';
import {Batch, material, type BatchObject} from '../../city/primitives';
import {treeKit} from '../../city/assetKits';
import {addParts, treeParts} from '../../city/assetParts';
import {seededRandom} from '../model/random';
import {
  distance,
  isDryFootprint,
  pointInPolygon,
  projectSegment,
  rectangle,
} from '../model/geometry';
import {WAREHOUSE_WIDTH, WAREHOUSE_DEPTH} from '../model/rules';
import {townHallReservation} from '../model/townHall';
import type {Bounds, Point, RegionState} from '../model/types';

interface Tree {
  point: Point;
  detail: BatchObject;
  coarse: BatchObject;
  occupied: boolean;
  detailed: boolean;
}
interface Chunk {
  bounds: Bounds;
  trees: Tree[];
  occupancy: string;
}

function waterShape(
  points: readonly Point[],
  y: number,
  color: string,
): THREE.Mesh {
  const shape = new THREE.Shape(
    points.map(point => new THREE.Vector2(point.x, -point.z)),
  );
  const surface = material(color).clone();
  const isWater = color === 'water';

  // Coplanar opaque water polygons share shading, but must not fight for depth.
  surface.depthWrite = !isWater;
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), surface);

  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.receiveShadow = true;
  mesh.renderOrder = isWater ? 2 : 1;

  return mesh;
}

export class TerrainView {
  readonly group = new THREE.Group();
  private readonly chunks: Chunk[] = [];
  private detailCenter: Point = {x: 0, z: 0};
  private detailRadius = 450;

  constructor(state: RegionState) {
    this.group.name = 'terrain';
    const ground = new Batch();
    const detailed = new Batch();
    const coarse = new Batch();
    const {bounds} = state.terrain;

    for (let x = bounds.minX; x < bounds.maxX; x += 256) {
      for (let z = bounds.minZ; z < bounds.maxZ; z += 256) {
        const width = Math.min(256, bounds.maxX - x);
        const depth = Math.min(256, bounds.maxZ - z);
        const chunk: Chunk = {
          bounds: {minX: x, maxX: x + width, minZ: z, maxZ: z + depth},
          trees: [],
          occupancy: '',
        };

        ground.add(
          'box',
          'grass',
          x + width / 2,
          0.5,
          z + depth / 2,
          width,
          1,
          depth,
        );
        const random = seededRandom(
          `${state.terrain.seed}/vegetation/${x}/${z}`,
        );

        for (let index = 0; index < 18; index++) {
          const point = {
            x: x + 8 + random() * (width - 16),
            z: z + 8 + random() * (depth - 16),
          };

          if (!isDryFootprint(state.terrain, rectangle(point, 9, 9))) {
            continue;
          }

          const kit = treeKit(state.seed, `region/${x}/${z}/${index}`);
          const scale = 0.8 + random() * 0.5;
          const detail = detailed.capture(batch =>
            addParts(batch, treeParts(kit), point.x, 1, point.z, scale),
          );
          const simplified = coarse.capture(batch => {
            batch.add(
              'cylinder',
              'trunk',
              point.x,
              3.2,
              point.z,
              0.55,
              4.4,
              0.55,
            );
            batch.add(
              'leaf',
              'forest',
              point.x,
              6,
              point.z,
              5 * scale,
              6 * scale,
              5 * scale,
            );
          });

          chunk.trees.push({
            point,
            detail,
            coarse: simplified,
            occupied: false,
            detailed: true,
          });
        }

        this.chunks.push(chunk);
      }
    }

    ground.finish(this.group);
    const forest = new THREE.Group();

    forest.name = 'vegetation';
    detailed.finish(forest);
    coarse.finish(forest);
    this.group.add(forest);

    for (const polygon of state.terrain.water) {
      const center = polygon.reduce(
        (sum, point) => ({
          x: sum.x + point.x / polygon.length,
          z: sum.z + point.z / polygon.length,
        }),
        {x: 0, z: 0},
      );
      const beach = polygon.map(point => ({
        x: Math.max(
          bounds.minX,
          Math.min(bounds.maxX, center.x + (point.x - center.x) * 1.012),
        ),
        z: Math.max(
          bounds.minZ,
          Math.min(bounds.maxZ, center.z + (point.z - center.z) * 1.012),
        ),
      }));

      this.group.add(waterShape(beach, 1.012, 'path'));
    }

    for (const polygon of state.terrain.water) {
      this.group.add(waterShape(polygon, 1.025, 'water'));
    }

    this.update(state);
    this.setDetail(this.detailCenter, this.detailRadius);
  }

  update(state: RegionState): void {
    const occupied = [
      ...state.settlements.map(townHallReservation),
      ...state.parcels.map(parcel =>
        rectangle(
          parcel.center,
          parcel.width + 8,
          parcel.depth + 8,
          parcel.heading,
        ),
      ),
      ...state.warehouses.map(warehouse =>
        rectangle(
          warehouse.center,
          WAREHOUSE_WIDTH + 8,
          WAREHOUSE_DEPTH + 8,
          warehouse.heading,
        ),
      ),
    ];
    const segments = state.roads.flatMap(road =>
      road.points
        .slice(1)
        .map((end, index) => ({start: road.points[index]!, end})),
    );

    for (const chunk of this.chunks) {
      const nearPolygons = occupied.filter(polygon =>
        polygon.some(
          point =>
            point.x >= chunk.bounds.minX - 40 &&
            point.x <= chunk.bounds.maxX + 40 &&
            point.z >= chunk.bounds.minZ - 40 &&
            point.z <= chunk.bounds.maxZ + 40,
        ),
      );
      const nearSegments = segments.filter(
        segment =>
          Math.max(segment.start.x, segment.end.x) >= chunk.bounds.minX - 16 &&
          Math.min(segment.start.x, segment.end.x) <= chunk.bounds.maxX + 16 &&
          Math.max(segment.start.z, segment.end.z) >= chunk.bounds.minZ - 16 &&
          Math.min(segment.start.z, segment.end.z) <= chunk.bounds.maxZ + 16,
      );
      const occupancy = JSON.stringify([
        nearPolygons,
        nearSegments,
        state.rules.roadWidth,
      ]);

      if (occupancy === chunk.occupancy) {
        continue;
      }

      chunk.occupancy = occupancy;

      for (const tree of chunk.trees) {
        const blocked =
          nearPolygons.some(polygon => pointInPolygon(tree.point, polygon)) ||
          nearSegments.some(
            segment =>
              projectSegment(tree.point, segment.start, segment.end).distance <
              state.rules.roadWidth / 2 + 6,
          );

        if (blocked !== tree.occupied) {
          tree.occupied = blocked;
          tree.detail.setVisible(!blocked && tree.detailed);
          tree.coarse.setVisible(!blocked && !tree.detailed);
        }
      }
    }
  }

  setDetail(center: Point, radius: number): void {
    this.detailCenter = center;
    this.detailRadius = radius;

    for (const chunk of this.chunks) {
      for (const tree of chunk.trees) {
        tree.detailed = distance(tree.point, center) <= radius;
        tree.detail.setVisible(!tree.occupied && tree.detailed);
        tree.coarse.setVisible(!tree.occupied && !tree.detailed);
      }
    }
  }
}
