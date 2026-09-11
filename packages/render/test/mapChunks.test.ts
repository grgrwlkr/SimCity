import { MapGrid, roadCellNone, tileToWorld, type RoadCell } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { renderLayersOf } from '@simcity/bridge';
import { CHUNK_TILES, buildChunkGeometry, changedChunks, chunkGrid } from '../src/mapChunks';
import { CLASS_COLORS, classifyColor, layoutClass, tileClass, type TileClass } from '../src/palette';

const road = (dir: RoadCell['dir']): RoadCell => ({ ...roadCellNone(), kind: 'TwoLane', dir });

function layers(width: number, height: number, edit: (grid: MapGrid) => void = () => {}) {
  const grid = new MapGrid(width, height);
  edit(grid);
  return renderLayersOf(grid, { width, height, tileSize: 16 }, 1, 1);
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
