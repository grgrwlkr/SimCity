// Port of the test in crates/simcity_sim/src/game/services/glyphs.rs.
import { describe, expect, it } from 'vitest';
import { glyphPieces } from '../src/serviceGlyphs';

describe('service glyphs', () => {
  it('glyphPieceCountsAndScale', () => {
    expect(glyphPieces('Medical', 10)).toHaveLength(2);
    expect(glyphPieces('Police', 10)).toHaveLength(1);
    expect(glyphPieces('Fire', 10)).toHaveLength(4);
    // Every piece stays inside the glyph box (|offset| + half-extent <= size/2 with a margin).
    for (const kind of ['Medical', 'Police', 'Fire'] as const) {
      for (const { size, offset } of glyphPieces(kind, 10)) {
        expect(Math.abs(offset[0]) + size[0] / 2 <= 5.01 && Math.abs(offset[1]) + size[1] / 2 <= 5.01, `${kind} piece ${size} at ${offset} escapes the glyph box`).toBe(true);
      }
    }
    // Scale linearity: pieces double with size.
    const [small, big] = [glyphPieces('Fire', 5), glyphPieces('Fire', 10)];
    expect([small[0]!.size[0] * 2, small[0]!.size[1] * 2]).toEqual(big[0]!.size);
  });
});
