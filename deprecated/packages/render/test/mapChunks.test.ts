import { MapGrid, roadCellNone, tileToWorld, type RoadCell } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { renderLayersOf } from '@simcity/bridge';
import { dataMapInputs, dataMapPaint, landValueColor, paintOver } from '../src/dataMap';
import { CHUNK_TILES, buildChunkGeometry, chunkColors, changedChunks, chunkGrid, groupGrid, groupOfChunk, groupTiles, groupsOfChunks } from '../src/mapChunks';
import { CLASS_COLORS, classifyColor, layoutClass, tileClass, type TileClass } from '../src/palette';

const road = (dir: RoadCell['dir']): RoadCell => ({ ...roadCellNone(), kind: 'TwoLane', dir });

function layers(width: number, height: number, edit: (grid: MapGrid) => void = () => {}) {
  const grid = new MapGrid(width, height);
  edit(grid);
  return renderLayersOf(grid, { width, height, tileSize: 16 }, 1, 1, 0n);
}

describe('palette', () => {
  it('tileClassFollowsRoadWaterAndBox', () => {
    const l = layers(4, 1, (grid) => {
      const at = (x: number) => grid.get({ x, y: 0 })!;
      grid.set({ x: 0, y: 0 }, { ...at(0), road: road('East') });
      grid.set({ x: 1, y: 0 }, { ...at(1), road: road('None') });
      grid.set({ x: 2, y: 0 }, { ...at(2), water: true });
      grid.set({ x: 3, y: 0 }, { ...at(3), zone: 'Residential' });
    });
    expect([0, 1, 2, 3].map((i) => tileClass(l, i))).toEqual(['road', 'box', 'water', 'residential']);
    expect(['road', 'box', 'water', 'residential', 'grass', 'building'].map((c) => layoutClass(c as TileClass))).toEqual([
      'road',
      'road',
      'water',
      'other',
      'other',
      'other',
    ]);
  });

  it('classColorsAreDistinct', () => {
    const entries = Object.entries(CLASS_COLORS) as Array<[TileClass, readonly [number, number, number]]>;
    for (const [a, ca] of entries) {
      expect(classifyColor(ca[0], ca[1], ca[2]), a).toBe(a);
      for (const [b, cb] of entries) {
        if (a === b) continue;
        const d = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
        expect(d, `${a} vs ${b}`).toBeGreaterThan(60);
      }
    }
  });
});

describe('map chunks', () => {
  it('chunkGeometryCoversItsTilesInWorldSpace', () => {
    const cfg = { width: 20, height: 20, tileSize: 16 };
    const l = layers(20, 20, (grid) => {
      grid.set({ x: 16, y: 0 }, { ...grid.get({ x: 16, y: 0 })!, road: road('North') });
    });
    const g = buildChunkGeometry(l, 1, 0);
    expect(g.tiles).toBe(4 * CHUNK_TILES);
    expect(g.positions.length).toBe(g.tiles * 6 * 3);
    expect(g.colors.length).toBe(g.positions.length);

    const xs = g.positions.filter((_, i) => i % 3 === 0);
    const ys = g.positions.filter((_, i) => i % 3 === 1);
    expect(Math.min(...xs)).toBe(tileToWorld(cfg, { x: 16, y: 0 }).x - 8);
    expect(Math.max(...xs)).toBe(tileToWorld(cfg, { x: 19, y: 0 }).x + 8);
    expect(Math.min(...ys)).toBe(tileToWorld(cfg, { x: 0, y: 0 }).y - 8);
    expect(Math.max(...ys)).toBe(tileToWorld(cfg, { x: 0, y: 15 }).y + 8);

    // The first tile of the chunk is (16,0), a road: its six vertices carry the road colour.
    const [r, gr, b] = CLASS_COLORS.road;
    expect(Array.from(g.colors.subarray(0, 3)).map((v) => Math.round(v * 255))).toEqual([r, gr, b]);
  });

  it('aDataMapPaintsEachTileInItsScaleColourAndLeavesWhatItDoesNotPaint', () => {
    const l = layers(20, 20, (grid) => {
      grid.set({ x: 1, y: 0 }, { ...grid.get({ x: 1, y: 0 })!, water: true });
    });
    const landValue = new Float32Array(400).fill(0.25);
    landValue[2] = 0.9;
    const paint = dataMapPaint('LandValue', dataMapInputs(l, { landValue }));
    const g = buildChunkGeometry(l, 0, 0, paint);
    const tile = (k: number) => Array.from(g.colors.subarray(k * 18, k * 18 + 3));
    // Every vertex of a tile carries its colour, written unchanged: the screenshot reads it back per tile.
    expect(tile(0)).toEqual(landValueColor(0.25).slice(0, 3));
    expect(Array.from(g.colors.subarray(15, 18))).toEqual(tile(0));
    expect(tile(2)).toEqual(landValueColor(landValue[2]!).slice(0, 3).map((c) => Math.fround(c)));
    // A translucent colour lies over the plain tile: the water map shades land and tints water.
    const water = buildChunkGeometry(l, 0, 0, dataMapPaint('Water', dataMapInputs(l, null)));
    const grass = CLASS_COLORS.grass.map((c) => c / 255) as [number, number, number];
    tile0Close(Array.from(water.colors.subarray(0, 3)), paintOver([0, 0, 0, 0.1], grass));
    // No data map, no paint: the plain map.
    expect(dataMapPaint('None', dataMapInputs(l, { landValue }))).toBeNull();
    expect(Array.from(buildChunkGeometry(l, 0, 0, null).colors)).toEqual(Array.from(buildChunkGeometry(l, 0, 0).colors));
    // Repainting in place writes what a fresh build does, and back.
    const colors = buildChunkGeometry(l, 0, 0).colors;
    chunkColors(l, 0, 0, colors, paint);
    expect(Array.from(colors)).toEqual(Array.from(g.colors));
    chunkColors(l, 0, 0, colors, null);
    expect(Array.from(colors)).toEqual(Array.from(buildChunkGeometry(l, 0, 0).colors));
  });

  it('edgeChunksClipToTheMap', () => {
    expect(chunkGrid(20, 20)).toEqual({ cols: 2, rows: 2 });
    expect(chunkGrid(128, 128)).toEqual({ cols: 8, rows: 8 });
    expect(buildChunkGeometry(layers(20, 20), 1, 1).tiles).toBe(16);
  });

  it('changedChunksOnlyWhereLayersDiffer', () => {
    const before = layers(20, 20);
    expect(changedChunks(null, before), 'nothing drawn yet: every chunk').toEqual([0, 1, 2, 3]);
    const after = layers(20, 20, (grid) => {
      grid.set({ x: 17, y: 3 }, { ...grid.get({ x: 17, y: 3 })!, road: road('West') });
    });
    expect(changedChunks(before, after)).toEqual([1]);
    expect(changedChunks(after, after)).toEqual([]);
    expect(changedChunks(layers(16, 16), after), 'a resize redraws everything').toEqual([0, 1, 2, 3]);
  });
});

describe('ground groups', () => {
  it('theMetropolisGroundIsFortyNineGroupsNotTwoAndAHalfThousandChunks', () => {
    const { cols, rows } = chunkGrid(800, 800);
    expect(cols * rows).toBe(2500);
    const g = groupGrid(cols, rows);
    expect(g.cols * g.rows).toBe(49);
  });

  it('groupsPartitionTheMapAndHoldTheirChunks', () => {
    for (const [w, h] of [
      [800, 800],
      [128, 128],
      [37, 250],
    ] as const) {
      const { cols, rows } = chunkGrid(w, h);
      const g = groupGrid(cols, rows);
      let area = 0;
      for (let k = 0; k < g.cols * g.rows; k++) {
        const t = groupTiles(w, h, k);
        area += (t.x1 - t.x0) * (t.y1 - t.y0);
      }
      expect(area, `${w}×${h}`).toBe(w * h);
      for (let index = 0; index < cols * rows; index++) {
        const t = groupTiles(w, h, groupOfChunk(index, cols));
        const [cx, cy] = [(index % cols) * CHUNK_TILES, Math.floor(index / cols) * CHUNK_TILES];
        expect(cx >= t.x0 && cx < t.x1 && cy >= t.y0 && cy < t.y1, `chunk ${index} of ${w}×${h}`).toBe(true);
      }
    }
  });

  it('anEditRebuildsOnlyTheGroupsOfItsChunks', () => {
    const { cols, rows } = chunkGrid(800, 800);
    expect(groupsOfChunks([0], cols)).toEqual([0]);
    expect(groupsOfChunks([cols * rows - 1, 1, 0], cols)).toEqual([0, 48]);
    expect(groupsOfChunks([], cols)).toEqual([]);
  });
});

function tile0Close(got: number[], want: readonly number[]): void {
  got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 6));
}
