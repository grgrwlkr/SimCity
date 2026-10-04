import * as THREE from 'three';
import {Batch} from '../../../../packages/app/src/city/primitives';
import {
  distance,
  projectSegment,
} from '../../../../packages/app/src/region/model/geometry';
import {buildRoadGraph} from '../../../../packages/app/src/region/model/roads';
import {ROAD_SIDEWALK_WIDTH} from '../../../../packages/app/src/region/model/rules';
import type {
  Point,
  Road,
} from '../../../../packages/app/src/region/model/types';

export function roadJunctions(roads: readonly Road[]): Point[] {
  const graph = buildRoadGraph(roads);

  return graph.nodes
    .filter(
      node =>
        new Set(
          graph.edges
            .filter(edge => edge.from === node.id)
            .map(edge => edge.to),
        ).size >= 3,
    )
    .map(node => node.point);
}

export function createRoadView(
  road: Road,
  width: number,
  junctions: readonly Point[],
): THREE.Group {
  const group = new THREE.Group();
  const batch = new Batch();

  for (let index = 1; index < road.points.length; index++) {
    const start = road.points[index - 1]!;
    const end = road.points[index]!;
    const length = distance(start, end);

    if (length === 0) {
      continue;
    }

    const heading = Math.atan2(end.x - start.x, end.z - start.z);
    const x = (start.x + end.x) / 2;
    const z = (start.z + end.z) / 2;

    batch.add(
      'box',
      'paving',
      x,
      1.025,
      z,
      width + 2 * ROAD_SIDEWALK_WIDTH,
      0.05,
      length,
      heading,
    );
    batch.add('box', 'asphalt', x, 1.055, z, width, 0.06, length, heading);
    const exclusions = junctions
      .map(point => projectSegment(point, start, end))
      .filter(projection => projection.distance < 0.1)
      .map(projection => ({
        from: Math.max(0, projection.t * length - width / 2 - 2),
        to: Math.min(length, projection.t * length + width / 2 + 2),
      }))
      .sort((a, b) => a.from - b.from);
    const sidewalkIntervals: Array<{from: number; to: number}> = [];
    let from = 0;

    for (const excluded of exclusions) {
      if (excluded.from > from) {
        sidewalkIntervals.push({from, to: excluded.from});
      }

      from = Math.max(from, excluded.to);
    }

    if (from < length) {
      sidewalkIntervals.push({from, to: length});
    }

    for (const sign of [-1, 1]) {
      const offset = sign * (width / 2 + ROAD_SIDEWALK_WIDTH / 2);

      for (const interval of sidewalkIntervals) {
        const t = (interval.from + interval.to) / 2 / length;

        batch.add(
          'box',
          'paving',
          start.x + (end.x - start.x) * t + Math.cos(heading) * offset,
          1.08,
          start.z + (end.z - start.z) * t - Math.sin(heading) * offset,
          ROAD_SIDEWALK_WIDTH,
          0.16,
          interval.to - interval.from,
          heading,
        );
      }
    }

    for (let offset = 5; offset < length - 4; offset += 8) {
      const point = {
        x: start.x + ((end.x - start.x) * offset) / length,
        z: start.z + ((end.z - start.z) * offset) / length,
      };

      if (junctions.some(junction => distance(point, junction) < width)) {
        continue;
      }

      batch.add(
        'box',
        'white',
        point.x,
        1.09,
        point.z,
        0.15,
        0.02,
        3.5,
        heading,
      );
    }
  }

  for (const point of road.points.slice(1, -1)) {
    batch.add(
      'cylinder',
      'asphalt',
      point.x,
      1.06,
      point.z,
      width,
      0.06,
      width,
    );
  }

  batch.finish(group);

  return group;
}

export function createJunctionView(
  points: readonly Point[],
  width: number,
): THREE.Group {
  const group = new THREE.Group();
  const batch = new Batch();

  for (const point of points) {
    batch.add(
      'cylinder',
      'asphalt',
      point.x,
      1.08,
      point.z,
      width + 0.4,
      0.04,
      width + 0.4,
    );
  }

  batch.finish(group);

  return group;
}
