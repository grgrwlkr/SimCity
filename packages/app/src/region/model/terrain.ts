import type {Terrain} from './types';
import {seededRandom} from './random';
import {normalizePoint} from './geometry';

export function generateTerrain(seed: string, size: number): Terrain {
  const half = size / 2;
  const random = seededRandom(seed);
  const center = {
    x: size * (0.19 + random() * 0.07),
    z: size * (-0.05 + random() * 0.1),
  };
  const rx = size * (0.16 + random() * 0.03);
  const rz = size * (0.24 + random() * 0.03);
  const water = Array.from({length: 24}, (_, i) => {
    const angle = (i / 24) * Math.PI * 2;

    return {
      x: Math.round((center.x + Math.cos(angle) * rx) * 100) / 100,
      z: Math.round((center.z + Math.sin(angle) * rz) * 100) / 100,
    };
  });
  const phase = random() * Math.PI * 2;
  const amplitude = size * (0.035 + random() * 0.02);
  const halfWidth = size * (0.012 + random() * 0.004);
  // Monotonic banks keep the channel continuous without self-intersections.
  const channel = Array.from({length: 65}, (_, index) => {
    const z = -half + (index / 64) * size;
    const along = ((z - center.z) / size) * Math.PI * 2;
    const x =
      center.x +
      amplitude * Math.sin(along + phase) +
      size * 0.018 * Math.sin(along * 2 - phase);
    const width = halfWidth * (1 + 0.15 * Math.sin(along * 3 + phase));

    return {x, z, width};
  });
  const river = [
    ...channel.map(point =>
      normalizePoint({x: point.x - point.width, z: point.z}),
    ),
    ...[...channel]
      .reverse()
      .map(point => normalizePoint({x: point.x + point.width, z: point.z})),
  ];

  return {
    seed,
    bounds: {minX: -half, maxX: half, minZ: -half, maxZ: half},
    water: [water, river],
  };
}
