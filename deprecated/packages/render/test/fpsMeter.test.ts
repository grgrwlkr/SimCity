import { describe, expect, it } from 'vitest';
import { FpsMeter } from '../src/fpsMeter';

describe('FpsMeter', () => {
  it('reportsFramesPerSecondOverTheLastWindow', () => {
    const meter = new FpsMeter();
    expect(meter.fps, 'no frames yet').toBe(0);
    for (let i = 0; i <= 120; i++) meter.frame(i * (1000 / 60));
    expect(meter.fps).toBeCloseTo(60, 0);

    // The rate drops to 30 frames a second: after a full window only the new rate counts.
    const start = 120 * (1000 / 60);
    for (let i = 1; i <= 60; i++) meter.frame(start + i * (1000 / 30));
    expect(meter.fps).toBeCloseTo(30, 0);
  });

  it('fallsToZeroWhenFramesStop', () => {
    const meter = new FpsMeter();
    for (let i = 0; i <= 60; i++) meter.frame(i * (1000 / 60));
    meter.idle(5000);
    expect(meter.fps).toBe(0);
  });
});
