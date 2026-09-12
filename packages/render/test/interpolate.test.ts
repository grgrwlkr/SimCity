import { describe, expect, it } from 'vitest';
import { interpolateHeading, interpolatePositions, pairVehicles } from '../src/interpolate';

const identity = (n: number) => Int32Array.from({ length: n }, (_, i) => i);

function frame(slots: number[], generations: number[] = slots.map(() => 0)) {
  return { count: slots.length, slot: Uint32Array.from(slots), generation: Uint32Array.from(generations) };
}

describe('frame interpolation', () => {
  it('positionsMoveLinearlyBetweenTwoSimFrames', () => {
    const prev = new Float32Array([0, 10, -4]);
    const next = new Float32Array([2, 10, 4]);
    const out = new Float32Array(3);
    interpolatePositions(prev, next, identity(3), 0.25, 3, out);
    expect(Array.from(out)).toEqual([0.5, 10, -2]);
  });

  it('onlyTheLiveCountIsWritten', () => {
    const out = new Float32Array([7, 7, 7]);
    interpolatePositions(new Float32Array([0, 0, 0]), new Float32Array([1, 1, 1]), identity(3), 1, 2, out);
    expect(Array.from(out)).toEqual([1, 1, 7]);
  });

  it('aVehicleIsInterpolatedFromItsOwnPlaceInThePreviousFrame', () => {
    // The previous frame had the vehicles in another order; -1 is one that was not there.
    const prev = new Float32Array([100, 0]);
    const next = new Float32Array([4, 50, 8]);
    const out = new Float32Array(3);
    interpolatePositions(prev, next, Int32Array.from([1, -1, 0]), 0.5, 3, out);
    expect(Array.from(out)).toEqual([2, 50, 54]);
  });

  it('headingTurnsTheShortWayAcrossPi', () => {
    // From just below +π to just above -π is a small left turn, not a full spin.
    const a = Math.PI - 0.1;
    const b = -Math.PI + 0.1;
    const mid = interpolateHeading(a, b, 0.5);
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(1e-9);
  });

  // Ported from crates/simcity_sim/src/game/traffic/vehicle_render.rs: the drawn position is
  // lerp(prev, curr) by how far the render clock is into the fixed step.
  it('interpolatesPositionAtOverstepFraction', () => {
    const out = new Float32Array(2);
    interpolatePositions(new Float32Array([0, 0]), new Float32Array([40, 80]), identity(2), 0.25, 2, out);
    expect(Array.from(out)).toEqual([10, 20]);
  });

  it('headingStaysWithinMinusPiToPi', () => {
    for (const t of [0, 0.3, 0.7, 1]) {
      const h = interpolateHeading(3, -3, t);
      expect(h).toBeGreaterThanOrEqual(-Math.PI);
      expect(h).toBeLessThanOrEqual(Math.PI);
    }
  });
});

describe('pairing vehicles across frames', () => {
  it('aSpawnAndADespawnInOneFrameDoNotSwapVehicles', () => {
    // Slot 2 left and slot 4 arrived: the count holds, but packed indices after slot 1 moved.
    const out = new Int32Array(3);
    const unpaired = pairVehicles(frame([1, 2, 3]), frame([1, 3, 4]), new Int32Array(8), out);
    expect(Array.from(out)).toEqual([0, 2, -1]);
    expect(unpaired).toBe(1);
  });

  it('aReusedSlotIsANewVehicle', () => {
    const out = new Int32Array(2);
    pairVehicles(frame([5, 6], [0, 0]), frame([5, 6], [0, 1]), new Int32Array(8), out);
    expect(Array.from(out)).toEqual([0, -1]);
  });

  it('scratchLeftFromAnotherPairingIsNotTrusted', () => {
    const bySlot = new Int32Array(8);
    pairVehicles(frame([0, 1, 2, 7]), frame([7]), bySlot, new Int32Array(1));
    // Slot 7 was at index 3 of that frame; this one has no slot 7 at all.
    const out = new Int32Array(1);
    pairVehicles(frame([0, 1, 2, 3]), frame([7]), bySlot, out);
    expect(Array.from(out)).toEqual([-1]);
  });
});
