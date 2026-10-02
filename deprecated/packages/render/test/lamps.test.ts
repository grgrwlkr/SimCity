// What each lamp of a light shows per phase: the main signal of its axis and the green left arrow of
// the extra section (ПДД 6.3). There is no blue signal.
import { describe, expect, it } from 'vitest';
import { lampSignal } from '../src/lamps';
import { LAMP_COLORS } from '../src/palette';

describe('lamp signals', () => {
  it('protectedLeftShowsRedWithAGreenArrow', () => {
    expect(lampSignal('NorthSouthLeftProtected', 'ns')).toEqual({ main: 'red', leftArrow: true });
    expect(lampSignal('NorthSouthLeftProtected', 'ew')).toEqual({ main: 'red', leftArrow: false });
    expect(lampSignal('EastWestLeftProtected', 'ew')).toEqual({ main: 'red', leftArrow: true });
  });

  it('otherPhasesShowOnlyTheMainSignal', () => {
    expect(lampSignal('NorthSouthGreen', 'ns')).toEqual({ main: 'green', leftArrow: false });
    expect(lampSignal('NorthSouthGreen', 'ew')).toEqual({ main: 'red', leftArrow: false });
    expect(lampSignal('EastWestYellow', 'ew')).toEqual({ main: 'yellow', leftArrow: false });
    expect(lampSignal('AllRedToNorthSouth', 'ns')).toEqual({ main: 'red', leftArrow: false });
  });

  it('lampsHaveNoBlue', () => {
    expect(Object.keys(LAMP_COLORS).sort()).toEqual(['green', 'red', 'yellow']);
  });
});
