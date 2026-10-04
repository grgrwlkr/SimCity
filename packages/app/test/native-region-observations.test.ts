import {describe, expect, it} from 'vitest';
import {trafficCollisions} from '../../../tools/native-region-observations';

const vehicle = (id: number, x: number, z: number, yaw = 0) => ({
  id,
  x,
  z,
  dx: Math.cos(yaw),
  dz: Math.sin(yaw),
  length: 4,
  width: 2,
});

describe('native regional traffic observations', () => {
  it('detects crossing complete bodies even with separated centers', () => {
    expect(
      trafficCollisions([vehicle(1, 0, 0), vehicle(2, 1, 0, Math.PI / 2)]),
    ).toEqual([[1, 2]]);
  });

  it('separates opposite lanes and allows touching boundaries', () => {
    expect(
      trafficCollisions([
        vehicle(1, 0, 0),
        vehicle(2, 0, 2, Math.PI),
        vehicle(3, 4, 0),
      ]),
    ).toEqual([]);
  });

  it('detects rotated bodies on an arbitrary-angle regional road', () => {
    const yaw = Math.PI / 4;

    expect(
      trafficCollisions([
        vehicle(1, 0, 0, yaw),
        vehicle(2, Math.cos(yaw), Math.sin(yaw), yaw),
      ]),
    ).toEqual([[1, 2]]);
  });

  it('uses actual truck dimensions instead of a fixed distance cutoff', () => {
    expect(
      trafficCollisions([{...vehicle(1, 0, 0), length: 12}, vehicle(2, 7, 0)]),
    ).toEqual([[1, 2]]);
  });
});
