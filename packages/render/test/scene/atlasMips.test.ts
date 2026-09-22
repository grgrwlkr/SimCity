// The GPU atlas: a mip chain built per cell, and the lookup the scene's node does, clamped to the cell at the level it
// samples, so neither the chain nor the bilinear footprint ever reaches a neighbouring cell.
import { describe, expect, it } from 'vitest';
import { ATLAS_CELLS, ATLAS_GRID, ATLAS_SIZE, CELL_SIZE, IDENTITY_UV, atlasCellIndex, buildAtlasImage, cellUv, uvIn } from '../../src/atlas';
import { MAX_CELL_LOD, atlasMipChain, atlasUvAt } from '../../src/scene/atlasTexture';

describe('atlas on the GPU', () => {
  const chain = atlasMipChain(buildAtlasImage());

  it('stops where a cell is one texel', () => {
    expect(MAX_CELL_LOD).toBe(Math.log2(CELL_SIZE));
    expect(chain).toHaveLength(MAX_CELL_LOD + 1);
    expect(chain.map((level) => level.width)).toEqual(Array.from({ length: MAX_CELL_LOD + 1 }, (_, l) => ATLAS_SIZE >> l));
  });

  it('downsamples every cell on its own', () => {
    // Plain is white; had its mips averaged in the grey Asphalt beside it, its edge texels would drop below 255.
    for (const level of chain) {
      const side = level.width / ATLAS_GRID;
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) expect(level.data[(y * level.width + x) * 4]).toBe(255);
      }
    }
    // At the last level each cell is its own mean, give or take the rounding of seven byte levels.
    const last = chain[MAX_CELL_LOD]!;
    const base = chain[0]!;
    for (const cell of ATLAS_CELLS) {
      const [col, row] = atlasCellIndex(cell);
      let sum = 0;
      for (let y = 0; y < CELL_SIZE; y++) for (let x = 0; x < CELL_SIZE; x++) sum += base.data[((row * CELL_SIZE + y) * ATLAS_SIZE + col * CELL_SIZE + x) * 4]!;
      expect(Math.abs(last.data[(row * last.width + col) * 4]! - sum / CELL_SIZE ** 2)).toBeLessThanOrEqual(2);
    }
  });

  it('keeps the bilinear footprint inside the cell at every level', () => {
    const edges = [0, 1e-4, 0.25, 0.5, 0.999, 1, 1.5, 3.99];
    for (const cell of ATLAS_CELLS) {
      const [col, row] = atlasCellIndex(cell);
      for (let lod = 0; lod <= MAX_CELL_LOD + 2; lod++) {
        const side = ATLAS_SIZE >> Math.min(lod, MAX_CELL_LOD);
        const lo = [col * (side / ATLAS_GRID), row * (side / ATLAS_GRID)];
        const hi = [lo[0]! + side / ATLAS_GRID, lo[1]! + side / ATLAS_GRID];
        for (const u of edges) {
          for (const v of edges) {
            for (const [uv, how] of [
              [atlasUvAt(cellUv(cell, 3), u, v, lod), 'repeated'],
              [atlasUvAt(IDENTITY_UV, ...uvIn(cell, u, v), lod), 'vertex-mapped'],
            ] as const) {
              // A linear sampler reads half a texel either side of the sample point.
              for (const axis of [0, 1]) {
                const t = uv[axis]! * side;
                expect(t - 0.5, `${cell} ${how} lod ${lod} (${u}, ${v})`).toBeGreaterThanOrEqual(lo[axis]! - 1e-6);
                expect(t + 0.5, `${cell} ${how} lod ${lod} (${u}, ${v})`).toBeLessThanOrEqual(hi[axis]! + 1e-6);
              }
            }
          }
        }
      }
    }
  });
});
