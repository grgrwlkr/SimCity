// Ported from crates/simcity_sim/src/game/transport/lanelet/conflict.rs (mod tests). Rows are 32-bit
// words here (64-bit in Rust), so the multi-word case crosses the 32-bit boundary.
import { describe, expect, it } from 'vitest';
import type { TilePos } from '../../src/commands';
import { ConflictMatrix, rowsOverlap } from '../../src/transport/lanelet/conflict';

const t = (x: number, y: number): TilePos => ({ x, y });

describe('conflict matrix', () => {
  it('crossingPathsConflictDisjointDontAndBuildIsDeterministic', () => {
    const we = [t(1, 1), t(0, 1)];
    const ns = [t(0, 0), t(0, 1), t(0, 2)];
    const far = [t(5, 5), t(5, 6)];
    const m = ConflictMatrix.fromPaths([we, ns, far]);
    expect(m.conflicts(0, 1)).toBe(true);
    expect(m.conflicts(1, 0), 'symmetric').toBe(true);
    expect(m.conflicts(0, 2)).toBe(false);
    expect(m.conflicts(1, 2)).toBe(false);
    expect(m.conflicts(0, 0), 'not self').toBe(false);
    const m2 = ConflictMatrix.fromPaths([we, ns, far]);
    expect(m.row(0)).toEqual(m2.row(0));
    expect(m.row(1)).toEqual(m2.row(1));
    expect(m.len()).toBe(3);
  });

  it('vehicleLaneletConflictsWithCrossedCrosswalk', () => {
    const m = ConflictMatrix.fromPathsWithCrosswalks([[t(0, 0), t(1, 0)]], [[t(1, 0), t(1, 1)]]);
    const cw = m.crosswalkBase();
    expect(cw, 'one vehicle lanelet row, crosswalk rows start at 1').toBe(1);
    expect(m.len()).toBe(2);
    expect(m.conflicts(0, cw), 'vehicle lanelet crossing the crosswalk must conflict with it').toBe(true);
    expect(m.conflicts(cw, 0), 'symmetric').toBe(true);

    const m2 = ConflictMatrix.fromPathsWithCrosswalks([[t(0, 0), t(1, 0)]], [[t(5, 5)]]);
    expect(m2.conflicts(0, m2.crosswalkBase()), 'disjoint crosswalk must not conflict').toBe(false);

    const m3 = ConflictMatrix.fromPaths([[t(0, 0)]]);
    expect(m3.crosswalkBase()).toBe(m3.len());
  });

  it('rowsOverlapDetectsSharedBitsAndToleratesLengths', () => {
    expect(rowsOverlap([0b0010], [0b0011]), 'share bit 1').toBe(true);
    expect(rowsOverlap([0b0100], [0b0011]), 'disjoint bits').toBe(false);
    expect(rowsOverlap([], [0b1111]), 'empty never overlaps').toBe(false);
    expect(rowsOverlap([0, 0b1], [0, 0b1, 0]), 'shared bit in 2nd word').toBe(true);
    expect(rowsOverlap([0b1], [0, 0b1]), 'bit in a word the shorter side lacks does not overlap').toBe(false);
    expect(rowsOverlap([0x8000_0000], [0x8000_0000]), 'the sign bit of a word counts').toBe(true);
  });

  it('multiWordRowsWhenNExceedsTheWordSize', () => {
    const paths = Array.from({ length: 33 }, () => [t(0, 0)]);
    const m = ConflictMatrix.fromPaths(paths);
    expect(m.len()).toBe(33);
    expect(m.row(0).length).toBe(2);
    expect(m.conflicts(0, 32)).toBe(true);
    expect(m.conflicts(32, 0)).toBe(true);
    expect(m.conflicts(0, 0)).toBe(false);
    expect(m.conflicts(32, 32)).toBe(false);
    expect(m.conflicts(0, 31), 'bit 31 is the sign bit of word 0').toBe(true);
    expect(m.row(99), 'out of range').toEqual(new Uint32Array(0));
  });
});
