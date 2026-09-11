import { describe, expect, it } from 'vitest';
import { interpolateHeading, interpolatePositions } from '../src/interpolate';

describe('frame interpolation', () => {
  it('positionsMoveLinearlyBetweenTwoSimFrames', () => {
    const prev = new Float32Array([0, 10, -4]);
    const next = new Float32Array([2, 10, 4]);
    const out = new Float32Array(3);
    interpolatePositions(prev, next, 0.25, 3, out);
    expect(Array.from(out)).toEqual([0.5, 10, -2]);
  });

  it('onlyTheLiveCountIsWritten', () => {
    const out = new Float32Array([7, 7, 7]);
    interpolatePositions(new Float32Array([0, 0, 0]), new Float32Array([1, 1, 1]), 1, 2, out);
    expect(Array.from(out)).toEqual([1, 1, 7]);
  });

  it('headingTurnsTheShortWayAcrossPi', () => {
    // From just below +π to just above -π is a small left turn, not a full spin.
    const a = Math.PI - 0.1;
    const b = -Math.PI + 0.1;
    const mid = interpolateHeading(a, b, 0.5);
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(1e-9);
  });

  it('headingStaysWithinMinusPiToPi', () => {
    for (const t of [0, 0.3, 0.7, 1]) {
      const h = interpolateHeading(3, -3, t);
      expect(h).toBeGreaterThanOrEqual(-Math.PI);
      expect(h).toBeLessThanOrEqual(Math.PI);
    }
  });
});
