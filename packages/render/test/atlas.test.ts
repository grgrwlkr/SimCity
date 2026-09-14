// Port of crates/simcity_sim/src/game/atlas.rs (mod tests): the procedural texture atlas, grey detail around white
// that multiplies a material's colour, one cell per surface.
import { TILE_KINDS } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import {
  ATLAS_CELLS,
  ATLAS_GRID,
  ATLAS_SIZE,
  CELL_SIZE,
  atlasCellIndex,
  buildAtlasImage,
  cellForTile,
  cellUv,
  mapCellUv,
  uvIn,
  type AtlasCell,
  type AtlasImage,
} from '../src/atlas';

/** The red channel of one cell, row by row. */
function cellPixels(image: AtlasImage, cell: AtlasCell): number[] {
  const [col, row] = atlasCellIndex(cell);
  const out: number[] = [];
  for (let y = 0; y < CELL_SIZE; y++) {
    for (let x = 0; x < CELL_SIZE; x++) {
      const px = col * CELL_SIZE + x;
      const py = row * CELL_SIZE + y;
      out.push(image.data[(py * ATLAS_SIZE + px) * 4]!);
    }
  }
  return out;
}

const step = 1 / ATLAS_GRID;
const CORNERS = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
  [0.5, 0.5],
] as const;

function expectInsideCell(cell: AtlasCell, [u, v]: readonly [number, number]): void {
  const [col, row] = atlasCellIndex(cell);
  expect(u >= col * step && u <= (col + 1) * step, `${cell}: u ${u} left its column`).toBe(true);
  expect(v >= row * step && v <= (row + 1) * step, `${cell}: v ${v} left its row`).toBe(true);
}

describe('procedural atlas', () => {
  it('vertexMappedUvsLandInsideTheirCellAndSpanIt', () => {
    for (const cell of ATLAS_CELLS) {
      for (const [u, v] of CORNERS) expectInsideCell(cell, uvIn(cell, u, v));
      // The face must use the whole cell, not a corner of it.
      const span = uvIn(cell, 1, 1)[0] - uvIn(cell, 0, 0)[0];
      expect(span, `${cell} only spans ${span} of ${step}`).toBeGreaterThan(step * 0.98);
    }
  });

  it('twoCellsNeverOverlapInVertexSpace', () => {
    expect(uvIn('Facade', 0.5, 0.5), 'a roof must not sample the facade pattern').not.toEqual(uvIn('RoofGravel', 0.5, 0.5));
  });

  it('everyGroundKindGetsASurfaceAndNoneStaysFlat', () => {
    for (const kind of TILE_KINDS) expect(cellForTile(kind), `${kind} would stay a flat fill`).not.toBe('Plain');
    expect(cellForTile('Road')).toBe('Asphalt');
    expect(cellForTile('Water')).toBe('Water');
    expect(cellForTile('Commercial'), 'zoned land is built-up ground whatever the zone; the colour differs, not the surface').toBe(
      cellForTile('Residential'),
    );
  });

  it('everyCellSitsInItsOwnCornerOfTheAtlas', () => {
    const seen = new Set<string>();
    for (const cell of ATLAS_CELLS) {
      const [col, row] = atlasCellIndex(cell);
      expect(col < ATLAS_GRID && row < ATLAS_GRID, `${cell} is off-grid`).toBe(true);
      expect(seen.has(`${col},${row}`), `${cell} shares a slot with another cell`).toBe(false);
      seen.add(`${col},${row}`);
    }
  });

  it('aCellsUvTransformStaysInsideThatCell', () => {
    for (const cell of ATLAS_CELLS) {
      const transform = cellUv(cell, 1);
      for (const [u, v] of CORNERS) expectInsideCell(cell, mapCellUv(transform, u, v));
    }
  });

  // Not in Rust: its transform scaled the whole cell by the repeat count, so a quad of three tiles sampled the two
  // cells beside its own. Here the repeat wraps inside the cell.
  it('aRepeatedCellWrapsInsideItsCell', () => {
    for (const cell of ATLAS_CELLS) {
      const transform = cellUv(cell, 3);
      for (const [u, v] of [...CORNERS, [0.2, 0.9], [0.99, 0.34]] as const) expectInsideCell(cell, mapCellUv(transform, u, v));
      const once = cellUv(cell, 1);
      expect(mapCellUv(transform, 1 / 3 + 0.1 / 3, 0.5)[0], 'the pattern restarts every third of the quad').toBeCloseTo(
        mapCellUv(once, 0.1, 0.5)[0],
        9,
      );
    }
  });

  it('thePlainCellIsFlatAndTheOthersAreNot', () => {
    const image = buildAtlasImage();
    expect(
      cellPixels(image, 'Plain').every((v) => v === 255),
      'the plain cell must not tint anything',
    ).toBe(true);
    for (const cell of ATLAS_CELLS) {
      if (cell === 'Plain') continue;
      const pixels = cellPixels(image, cell);
      const min = Math.min(...pixels);
      const max = Math.max(...pixels);
      expect(max - min, `${cell} has no visible detail: ${min}..${max}`).toBeGreaterThan(20);
    }
  });

  /**
   * Detail has to survive minification, not just exist at texel level: a roof seen from the game camera is a few
   * hundred pixels wide while its cell tiles several times across it, so a texel-frequency pattern is averaged
   * away by the mip chain. The first roof-gravel cell passed the test above and still rendered flat.
   */
  it('cellDetailSurvivesBeingMinified', () => {
    const image = buildAtlasImage();
    const block = 8; // one mip level short of what the camera does to a roof
    for (const cell of ATLAS_CELLS) {
      if (cell === 'Plain') continue;
      const pixels = cellPixels(image, cell);
      const means: number[] = [];
      for (let by = 0; by < CELL_SIZE; by += block) {
        for (let bx = 0; bx < CELL_SIZE; bx += block) {
          let sum = 0;
          for (let y = by; y < by + block; y++) for (let x = bx; x < bx + block; x++) sum += pixels[y * CELL_SIZE + x]!;
          means.push(sum / (block * block));
        }
      }
      const lo = Math.min(...means);
      const hi = Math.max(...means);
      expect(hi - lo, `${cell} averages flat once minified: ${lo.toFixed(1)}..${hi.toFixed(1)}`).toBeGreaterThan(8);
    }
  });

  /** The atlas multiplies the material colour, so a cell that is dark on average would wash the whole palette out. */
  it('cellsAverageNearWhiteSoColoursSurvive', () => {
    const image = buildAtlasImage();
    for (const cell of ATLAS_CELLS) {
      const pixels = cellPixels(image, cell);
      const mean = pixels.reduce((a, b) => a + b, 0) / pixels.length;
      expect(mean >= 215 && mean <= 256, `${cell} averages ${mean}, which would darken every colour using it`).toBe(true);
    }
  });

  it('theAtlasIsTheSameEveryRun', () => {
    const a = buildAtlasImage();
    const b = buildAtlasImage();
    expect(a.width).toBe(ATLAS_SIZE);
    expect(a.data.length).toBe(ATLAS_SIZE * ATLAS_SIZE * 4);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data)), 'the atlas must not depend on run order').toBe(true);
  });
});
