import type {Batch} from './primitives';
import {buildRoadGraph} from '../region/model/roads';
import {projectSegment} from '../region/model/geometry';
import type {Point, Road} from '../region/model/types';
import {CROSSWALK_OFFSET} from './streetCrossings';

/** The original four-metre dash cadence and clear intersection centres. */
export function nativeRoadDashOffsets(
  length: number,
  junctions: readonly number[],
): number[] {
  const result: number[] = [];

  for (let along = 4; along <= length - 4; along += 4) {
    if (!junctions.some(cross => Math.abs(along - cross) < 5)) {
      result.push(along);
    }
  }

  return result;
}

/** Cardinal branches retain the exact original scale and zero rotation matrices. */
export function addNativeRoadDash(
  batch: Pick<Batch, 'add'>,
  point: Point,
  direction: Point,
): void {
  if (direction.x === 0) {
    batch.add('box', 'cream', point.x, 0.865, point.z, 0.13, 0.015, 1.7);
  } else if (direction.z === 0) {
    batch.add('box', 'cream', point.x, 0.865, point.z, 1.7, 0.015, 0.13);
  } else {
    batch.add(
      'box',
      'cream',
      point.x,
      0.865,
      point.z,
      0.13,
      0.015,
      1.7,
      Math.atan2(direction.x, direction.z),
    );
  }
}

/** The original ten white crossing bars, rigidly rotated only for non-cardinal streets. */
export function addNativeCrosswalk(
  batch: Pick<Batch, 'add'>,
  point: Point,
  direction: Point,
): void {
  for (let stripe = 0; stripe < 10; stripe++) {
    const along = -3.6 + stripe * 0.8;

    if (direction.x === 0) {
      batch.add(
        'box',
        'white',
        point.x + along,
        0.874,
        point.z,
        0.5,
        0.02,
        2.1,
      );
    } else if (direction.z === 0) {
      batch.add(
        'box',
        'white',
        point.x,
        0.874,
        point.z + along,
        2.1,
        0.02,
        0.5,
      );
    } else {
      batch.add(
        'box',
        'white',
        point.x + direction.z * along,
        0.874,
        point.z - direction.x * along,
        0.5,
        0.02,
        2.1,
        Math.atan2(direction.x, direction.z),
      );
    }
  }
}

/** Decorate only actual authored road branches; no Cartesian prototype grid is manufactured. */
export function addAuthoredRoadDetails(
  batch: Pick<Batch, 'add'>,
  roads: readonly Road[],
): void {
  const graph = buildRoadGraph(roads);
  const nodes = new Map(graph.nodes.map(node => [node.id, node.point]));
  const junctions: Array<{
    point: Point;
    rays: Array<{direction: Point; length: number}>;
  }> = [];

  for (const node of graph.nodes) {
    const rays: Array<{direction: Point; length: number}> = [];
    const connectedRoads = new Set<string>();

    for (const edge of graph.edges.filter(edge => edge.from === node.id)) {
      connectedRoads.add(edge.roadId);
      const road = roads.find(road => road.id === edge.roadId)!;
      const a = road.points[edge.segment]!;
      const b = road.points[edge.segment + 1]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      const to = nodes.get(edge.to)!;
      const sign =
        (to.x - node.point.x) * dx + (to.z - node.point.z) * dz >= 0 ? 1 : -1;
      const direction = {x: (sign * dx) / length, z: (sign * dz) / length};

      if (
        !rays.some(
          ray =>
            ray.direction.x * direction.x + ray.direction.z * direction.z >
            1 - 1e-8,
        )
      ) {
        rays.push({direction, length: edge.length});
      }
    }

    if (
      rays.length > 1 &&
      (rays.length > 2 || connectedRoads.size > 1) &&
      (rays.length !== 2 ||
        rays[0]!.direction.x * rays[1]!.direction.x +
          rays[0]!.direction.z * rays[1]!.direction.z >
          -1 + 1e-8)
    ) {
      junctions.push({point: node.point, rays});
    }
  }

  for (const road of roads) {
    for (let index = 1; index < road.points.length; index++) {
      const a = road.points[index - 1]!;
      const b = road.points[index]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);

      if (length === 0) {
        continue;
      }

      const offsets = junctions.flatMap(junction => {
        const projected = projectSegment(junction.point, a, b);

        return projected.distance < 0.01 ? [projected.t * length] : [];
      });
      const direction = {x: dx / length, z: dz / length};

      for (const along of nativeRoadDashOffsets(length, offsets)) {
        addNativeRoadDash(
          batch,
          {x: a.x + direction.x * along, z: a.z + direction.z * along},
          direction,
        );
      }
    }
  }

  for (const junction of junctions) {
    for (const ray of junction.rays) {
      if (ray.length >= CROSSWALK_OFFSET + 2.1 / 2) {
        addNativeCrosswalk(
          batch,
          {
            x: junction.point.x + ray.direction.x * CROSSWALK_OFFSET,
            z: junction.point.z + ray.direction.z * CROSSWALK_OFFSET,
          },
          ray.direction,
        );
      }
    }
  }
}
