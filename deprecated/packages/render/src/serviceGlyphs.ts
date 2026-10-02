// Port of crates/simcity_sim/src/game/services/glyphs.rs: the service glyph as quads — a cross for medical, a badge diamond
// for police, a ladder for fire — shared by vehicle roofs and building markers. The scene of stage 5 places them; the debug
// renderer does not draw them.
import type { ServiceKind } from '@simcity/sim';

/** Near-white: contrasts with every service body and building colour. */
export const GLYPH_COLOR = [0.95, 0.95, 0.95] as const;

export interface GlyphPiece {
  /** Width and height of the quad. */
  readonly size: readonly [number, number];
  /** Its centre from the glyph's centre. */
  readonly offset: readonly [number, number];
  /** Turn about z, radians. */
  readonly rotation: number;
}

const QUARTER_PI = Math.PI / 4;

/** The quads of `kind`'s glyph in a box of side `size`; the first is the one a vehicle hangs its markers on. */
export function glyphPieces(kind: ServiceKind, size: number): GlyphPiece[] {
  switch (kind) {
    case 'Medical':
      return [
        { size: [size * 0.34, size], offset: [0, 0], rotation: 0 },
        { size: [size, size * 0.34], offset: [0, 0], rotation: 0 },
      ];
    case 'Police':
      return [{ size: [size * 0.75, size * 0.75], offset: [0, 0], rotation: QUARTER_PI }];
    case 'Fire':
      return [
        { size: [size * 0.16, size], offset: [-size * 0.28, 0], rotation: 0 },
        { size: [size * 0.16, size], offset: [size * 0.28, 0], rotation: 0 },
        { size: [size * 0.72, size * 0.14], offset: [0, size * 0.22], rotation: 0 },
        { size: [size * 0.72, size * 0.14], offset: [0, -size * 0.22], rotation: 0 },
      ];
  }
}
