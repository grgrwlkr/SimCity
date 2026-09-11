// Ported from crates/simcity_sim/src/game/transport/lane_pathfinding.rs (mod tests).
import { describe, expect, it } from 'vitest';
import { MIN_PER_TILE_BASE, heuristicTiles, laneJitter } from '../../src/transport/lanePathfinding';

describe('lane pathfinding costs', () => {
  it('heuristicTilesIsScaledManhattan', () => {
    expect(heuristicTiles({ x: 0, y: 0 }, { x: 3, y: 2 })).toBe(5 * MIN_PER_TILE_BASE);
  });

  // Not in Rust: range and spread of the BigInt u64 mix. Exact values are pinned by the lanelet route
  // gate, whose pairs carry non-zero seeds.
  it('laneJitterIsZeroWithoutSeedAndStaysInRange', () => {
    expect(laneJitter(0n, 5)).toBe(0);
    const values = Array.from({ length: 256 }, (_, id) => laneJitter(0x1234_5678_9abc_def0n, id));
    expect(values.every((v) => Number.isInteger(v) && v >= 0 && v < 8)).toBe(true);
    expect(new Set(values).size, 'all eight buckets are used').toBe(8);
  });
});
