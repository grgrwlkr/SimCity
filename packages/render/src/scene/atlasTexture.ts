// The atlas as the GPU samples it, without three.js: the mip chain and the lookup `atlasNode.ts` does in the shader.
//
// Two things keep a cell from bleeding into its neighbours. The chain stops where a cell is one texel, and every level is
// a 2×2 box filter of the one above, whose blocks never straddle a cell because a cell's side stays even down to there.
// And the lookup clamps into the cell by half a texel of the level it samples, so the bilinear footprint stays inside
// even on the far mips, where the half-texel inset of `atlas.ts` (half a texel of level 0) is long gone.
import { ATLAS_GRID, ATLAS_SIZE, CELL_SIZE, mapCellUv, type AtlasImage, type CellUv } from '../atlas';

/** The last level: one texel per cell. */
export const MAX_CELL_LOD = Math.log2(CELL_SIZE);

/** Level 0 is `image`; each next level halves it, down to one texel per cell. */
export function atlasMipChain(image: AtlasImage): AtlasImage[] {
  const chain = [image];
  for (let level = 1; level <= MAX_CELL_LOD; level++) {
    const prev = chain[level - 1]!;
    const side = prev.width / 2;
    const data = new Uint8Array(side * side * 4);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        for (let c = 0; c < 4; c++) {
          const at = (dx: number, dy: number) => prev.data[((2 * y + dy) * prev.width + 2 * x + dx) * 4 + c]!;
          data[(y * side + x) * 4 + c] = Math.round((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4);
        }
      }
    }
    chain.push({ width: side, height: side, data });
  }
  return chain;
}

/**
 * Half a texel of the coarser of the two levels a fractional `lod` blends, in atlas UV: the finer one's footprint fits
 * inside it. Past the last level the sampler never goes further (the chain ends there).
 */
export function halfTexelAt(lod: number): number {
  return (0.5 * 2 ** Math.min(Math.ceil(Math.max(lod, 0)), MAX_CELL_LOD)) / ATLAS_SIZE;
}

/**
 * Where the shader samples for a mesh UV at `lod`: `mapCellUv` places it in the cell (vertex-mapped meshes pass their
 * atlas UVs with `IDENTITY_UV`), then it is clamped half a texel of that level inside the cell it landed in.
 */
export function atlasUvAt(transform: CellUv, u: number, v: number, lod: number): [number, number] {
  const h = halfTexelAt(lod);
  const step = 1 / ATLAS_GRID;
  return mapCellUv(transform, u, v).map((t) => {
    const origin = Math.floor(t * ATLAS_GRID) / ATLAS_GRID;
    return Math.min(Math.max(t, origin + h), origin + step - h);
  }) as [number, number];
}
