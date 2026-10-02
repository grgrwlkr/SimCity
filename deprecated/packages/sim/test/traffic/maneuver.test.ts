// Port of crates/simcity_sim/src/game/traffic/intersection/zones.rs tests.
import { describe, expect, it } from 'vitest';
import { maneuverKind } from '../../src/traffic/maneuver';

describe('maneuver kind', () => {
  it('maneuverKindClassifiesUturn', () => {
    const cfg = { driveOnRight: true };
    expect(maneuverKind(cfg, 'North', 'South')).toBe('UTurn');
    expect(maneuverKind(cfg, 'East', 'West')).toBe('UTurn');
    expect(maneuverKind(cfg, 'North', 'West')).toBe('LeftTurn');
    expect(maneuverKind(cfg, 'North', 'North')).toBe('Straight');
  });
});
