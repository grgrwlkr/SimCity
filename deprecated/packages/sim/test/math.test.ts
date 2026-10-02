// The float helpers the simulation allows: exact arithmetic only, so every engine agrees.
import { describe, expect, it } from 'vitest';
import { expF64 } from '../src/math';

describe('math', () => {
  it('expF64AgreesWithTheEngineToRoundOff', () => {
    for (const x of [-30, -7.25, -1.32, -0.5, -1e-9, 0, 1e-9, 0.25, 1, 2.5, 10, 50, 300]) {
      const want = Math.exp(x);
      expect(Math.abs(expF64(x) - want) / want, `e^${x}`).toBeLessThan(1e-13);
    }
    expect(expF64(0)).toBe(1);
    expect(expF64(-800)).toBe(0);
    expect(expF64(800)).toBe(Infinity);
  });
});
