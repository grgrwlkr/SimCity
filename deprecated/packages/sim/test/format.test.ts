// Numbers as the player reads them: one formatter for the sim, the render and the HUD.
import { describe, expect, it } from 'vitest';
import { thousands } from '../src/format';
import * as sim from '../src/index';

describe('format', () => {
  it('thousandsGroupsDigitsByANoBreakSpaceLikeTheHudMoney', () => {
    expect(thousands(6200)).toBe('6 200');
    expect(thousands(-1_234_567)).toBe('-1 234 567');
    expect(thousands(999)).toBe('999');
    expect(thousands(0)).toBe('0');
  });

  it('thousandsIsTheOneTheSimIndexExports', () => {
    expect(sim.thousands).toBe(thousands);
  });
});
