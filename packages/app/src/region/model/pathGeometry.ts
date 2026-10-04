import type {LaneRoute} from '../../city/trafficRoutes';
import {distance} from './geometry';
import type {Point} from './types';

export function polylineLane(points: readonly Point[]): LaneRoute {
  const segments: Array<LaneRoute['segments'][number]> = [];

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = distance(a, b);

    if (length <= 1e-8) {
      continue;
    }

    segments.push({
      kind: 'line',
      x: a.x,
      z: a.z,
      dx: (b.x - a.x) / length,
      dz: (b.z - a.z) / length,
      length,
    });
  }

  return {
    direction: 1,
    closed: false,
    length: segments.reduce((n, s) => n + s.length, 0),
    segments,
  };
}
