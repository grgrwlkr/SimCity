// One procedural texture atlas for every surface in the city: port of crates/simcity_sim/src/game/atlas.rs.
// The atlas carries detail, not colour: every cell is a grey pattern around white that multiplies the material's
// colour, so zone colours, data maps and decay tints keep working and the texture only breaks up the flat fill.
import type { TileKind } from '@simcity/sim';

/** Cells per side. */
export const ATLAS_GRID = 4;
/** Side of one cell in pixels. */
export const CELL_SIZE = 128;
/** Side of the whole atlas. */
export const ATLAS_SIZE = ATLAS_GRID * CELL_SIZE;

export const ATLAS_CELLS = ['Plain', 'Asphalt', 'Sidewalk', 'Grass', 'Water', 'RoofGravel', 'Facade'] as const;
/**
 * A surface pattern: `Plain` is flat, `Asphalt` fine grain with darker seams, `Sidewalk` slabs, `Grass` coarse
 * mottling, `Water` slow waves, `RoofGravel` clumps and grit, `Facade` the storeys of a building side.
 */
export type AtlasCell = (typeof ATLAS_CELLS)[number];

const CELL_SLOTS: Readonly<Record<AtlasCell, readonly [col: number, row: number]>> = {
  Plain: [0, 0],
  Asphalt: [1, 0],
  Sidewalk: [2, 0],
  Grass: [3, 0],
  Water: [0, 1],
  RoofGravel: [1, 1],
  Facade: [2, 1],
};

/** Column and row of the cell in the atlas grid. */
export function atlasCellIndex(cell: AtlasCell): readonly [col: number, row: number] {
  return CELL_SLOTS[cell];
}

const STEP = 1 / ATLAS_GRID;
/** Half a texel on each side: a linear sampler at the very edge of a cell would otherwise reach into its neighbour. */
const INSET = 0.5 / ATLAS_SIZE;
const CELL_SPAN = STEP - 2 * INSET;

const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);

/** A face-local 0..1 coordinate in this cell, for meshes whose faces carry atlas-space UVs of different cells. */
export function uvIn(cell: AtlasCell, u: number, v: number): [number, number] {
  const [col, row] = atlasCellIndex(cell);
  return [col * STEP + INSET + clamp01(u) * CELL_SPAN, row * STEP + INSET + clamp01(v) * CELL_SPAN];
}

/** How a material maps a mesh's 0..1 UV into the atlas: repeat inside a cell, then place it. */
export interface CellUv {
  readonly offset: readonly [number, number];
  readonly scale: number;
  readonly repeat: number;
}

/** UVs the vertices already placed in the atlas: the material must not move them. */
export const IDENTITY_UV: CellUv = { offset: [0, 0], scale: 1, repeat: 1 };

/** `repeat` tiles the pattern within the cell: a road quad over several tiles wants the grain repeated, not stretched. */
export function cellUv(cell: AtlasCell, repeat: number): CellUv {
  const [col, row] = atlasCellIndex(cell);
  return { offset: [col * STEP + INSET, row * STEP + INSET], scale: CELL_SPAN, repeat: Math.max(repeat, 0.01) };
}

/** 0 stays 0 and every other whole number maps to 1, so the far edge of a quad samples the far edge of its cell. */
function wrapUnit(t: number): number {
  return t <= 0 ? 0 : t - Math.ceil(t) + 1;
}

/**
 * Where a mesh UV samples: the shader of the scene does the same with `fract`. Rust scaled the cell by the repeat
 * count and so read the neighbouring cells; the patterns wrap, so repeating inside the cell is seamless.
 */
export function mapCellUv(transform: CellUv, u: number, v: number): [number, number] {
  return [
    transform.offset[0] + wrapUnit(u * transform.repeat) * transform.scale,
    transform.offset[1] + wrapUnit(v * transform.repeat) * transform.scale,
  ];
}

/** Zoned land keeps the pavement rather than grass: a zoned block is built-up ground whose colour comes from the material. */
export function cellForTile(kind: TileKind): AtlasCell {
  switch (kind) {
    case 'Water':
      return 'Water';
    case 'Grass':
      return 'Grass';
    case 'Road':
      return 'Asphalt';
    case 'Residential':
    case 'Commercial':
    case 'Industrial':
      return 'Sidewalk';
  }
}

/** Deterministic value hash in 0..1 on u32 arithmetic. */
function hash01(x: number, y: number, salt: number): number {
  let h = (Math.imul(x, 0x9e3779b9) + Math.imul(y, 0x85ebca6b) + Math.imul(salt, 0xc2b2ae35)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x2545f491) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return (h & 0xffff) / 65535;
}

/** Smooth value noise on an 8×8 lattice per `period`, wrapping so a cell tiles seamlessly. */
function wrappedNoise(x: number, y: number, period: number, salt: number): number {
  const fx = (x / period) * 8;
  const fy = (y / period) * 8;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const sx = smooth(fx - x0);
  const sy = smooth(fy - y0);
  const corner = (cx: number, cy: number) => hash01(cx % 8, cy % 8, salt);
  const top = corner(x0, y0) * (1 - sx) + corner(x0 + 1, y0) * sx;
  const bottom = corner(x0, y0 + 1) * (1 - sx) + corner(x0 + 1, y0 + 1) * sx;
  return top * (1 - sy) + bottom * sy;
}

/** Grey value of one pixel of a cell, around 1 so it multiplies cleanly. */
function cellValue(cell: AtlasCell, x: number, y: number): number {
  switch (cell) {
    case 'Plain':
      return 1;
    case 'Asphalt': {
      const grain = 0.94 + 0.12 * hash01(x, y, 1);
      return wrappedNoise(x, y, CELL_SIZE, 7) > 0.86 ? grain * 0.72 : grain;
    }
    case 'Sidewalk': {
      const slab = 32;
      const grain = 0.97 + 0.06 * hash01(x, y, 2);
      return x % slab < 2 || y % slab < 2 ? grain * 0.8 : grain;
    }
    case 'Grass':
      return (0.9 + 0.2 * wrappedNoise(x, y, CELL_SIZE, 3)) * (0.97 + 0.06 * hash01(x, y, 4));
    // Centred below 1 on purpose: values above it would clip at the byte ceiling and flatten the waves.
    case 'Water':
      return 0.86 + 0.2 * wrappedNoise(x, y, CELL_SIZE, 5);
    // Clumps first, grit second: texel-frequency speckle averages flat at the zoom a roof is seen from.
    case 'RoofGravel': {
      const clump = 0.8 + 0.34 * wrappedNoise(x, y, CELL_SIZE, 6);
      return clump * (hash01(x, y, 9) > 0.62 ? 0.86 : 1.06);
    }
    case 'Facade': {
      const storey = 24;
      const grain = 0.98 + 0.04 * hash01(x, y, 8);
      return y % storey < 2 ? grain * 0.78 : grain;
    }
  }
}

/** RGBA8, linear: detail is a multiplier and must not be gamma-bent before it multiplies the base colour. */
export interface AtlasImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** The atlas image, the same bytes every run; a slot without a cell is white. */
export function buildAtlasImage(): AtlasImage {
  const data = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4).fill(255);
  for (const cell of ATLAS_CELLS) {
    const [col, row] = atlasCellIndex(cell);
    for (let y = 0; y < CELL_SIZE; y++) {
      for (let x = 0; x < CELL_SIZE; x++) {
        const v = Math.round(clamp01(cellValue(cell, x, y)) * 255);
        const i = ((row * CELL_SIZE + y) * ATLAS_SIZE + col * CELL_SIZE + x) * 4;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
      }
    }
  }
  return { width: ATLAS_SIZE, height: ATLAS_SIZE, data };
}
