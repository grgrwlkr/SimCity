// The map as 16×16-tile chunks, one flat-coloured quad per tile, so a map edit rebuilds only the
// chunks whose tiles changed.
import type { MapLayersReply } from '@simcity/bridge';
import { tileToWorld } from '@simcity/sim';
import type { Rgb } from './buildingLook';
import type { TilePaint } from './dataMap';
import { CLASS_COLORS, tileClass } from './palette';

export const CHUNK_TILES = 16;

export function chunkGrid(width: number, height: number): { cols: number; rows: number } {
  return { cols: Math.ceil(width / CHUNK_TILES), rows: Math.ceil(height / CHUNK_TILES) };
}

export interface ChunkGeometry {
  /** Two triangles per tile, xyz per vertex, on the ground plane. */
  readonly positions: Float32Array;
  /** rgb 0..1 per vertex; the debug renderer puts it on screen unchanged (no colour management). */
  readonly colors: Float32Array;
  readonly tiles: number;
}

function chunkTiles(map: MapLayersReply, cx: number, cy: number) {
  const x0 = cx * CHUNK_TILES;
  const y0 = cy * CHUNK_TILES;
  return { x0, y0, x1: Math.min(x0 + CHUNK_TILES, map.width), y1: Math.min(y0 + CHUNK_TILES, map.height) };
}

/** A data map's paint over the chunk (`dataMapPaint`), or `null` for the plain map. */
export function buildChunkGeometry(map: MapLayersReply, cx: number, cy: number, paint: TilePaint | null = null): ChunkGeometry {
  const { x0, y0, x1, y1 } = chunkTiles(map, cx, cy);
  const tiles = Math.max(x1 - x0, 0) * Math.max(y1 - y0, 0);
  const positions = new Float32Array(tiles * 18);
  const colors = new Float32Array(tiles * 18);
  const cfg = { width: map.width, height: map.height, tileSize: map.tileSize };
  const half = map.tileSize / 2;
  let v = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const c = tileToWorld(cfg, { x, y });
      const corners = [
        [c.x - half, c.y - half],
        [c.x + half, c.y - half],
        [c.x + half, c.y + half],
        [c.x - half, c.y - half],
        [c.x + half, c.y + half],
        [c.x - half, c.y + half],
      ] as const;
      for (const [px, py] of corners) {
        positions[v] = px;
        positions[v + 1] = py;
        v += 3;
      }
    }
  }
  chunkColors(map, cx, cy, colors, paint);
  return { positions, colors, tiles };
}

/** Writes the chunk's vertex colours into `colors` in place: the plain map's, or a data map's over it. */
export function chunkColors(map: MapLayersReply, cx: number, cy: number, colors: Float32Array, paint: TilePaint | null): void {
  const { x0, y0, x1, y1 } = chunkTiles(map, cx, cy);
  let v = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = y * map.width + x;
      const [r8, g8, b8] = CLASS_COLORS[tileClass(map, idx)];
      const plain: Rgb = [r8 / 255, g8 / 255, b8 / 255];
      const [r, g, b] = paint === null ? plain : paint(idx, plain);
      for (let k = 0; k < 6; k++, v += 3) {
        colors[v] = r;
        colors[v + 1] = g;
        colors[v + 2] = b;
      }
    }
  }
}

const COMPARED_LAYERS = ['water', 'roadKind', 'roadDir', 'zone', 'building'] as const;

/** Indices (`cy * cols + cx`) of the chunks whose tiles differ; every chunk when there is no previous map or the size changed. */
export function changedChunks(prev: MapLayersReply | null, next: MapLayersReply): number[] {
  const { cols, rows } = chunkGrid(next.width, next.height);
  const all = Array.from({ length: cols * rows }, (_, i) => i);
  if (prev === null || prev.width !== next.width || prev.height !== next.height) return all;
  return all.filter((index) => {
    const { x0, y0, x1, y1 } = chunkTiles(next, index % cols, Math.floor(index / cols));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * next.width + x;
        if (COMPARED_LAYERS.some((name) => prev.layers[name][i] !== next.layers[name][i])) return true;
      }
    }
    return false;
  });
}

/**
 * Chunks per side of a ground group: the scene draws the ground a group at a time, 8×8 chunks (128×128 tiles) in one
 * mesh, so the fitted metropolis is 49 draws instead of 2 500, while an edit still rebuilds a bounded area and a close
 * view still culls most of the map.
 */
export const GROUP_CHUNKS = 8;

export function groupGrid(cols: number, rows: number): { cols: number; rows: number } {
  return { cols: Math.ceil(cols / GROUP_CHUNKS), rows: Math.ceil(rows / GROUP_CHUNKS) };
}

/** Group index (`gy * groupCols + gx`) of chunk `index` in a grid `cols` chunks wide. */
export function groupOfChunk(index: number, cols: number): number {
  const gx = Math.floor((index % cols) / GROUP_CHUNKS);
  const gy = Math.floor(Math.floor(index / cols) / GROUP_CHUNKS);
  return gy * Math.ceil(cols / GROUP_CHUNKS) + gx;
}

/** The groups holding `changed` chunks, ascending, each once. */
export function groupsOfChunks(changed: readonly number[], cols: number): number[] {
  return [...new Set(changed.map((index) => groupOfChunk(index, cols)))].sort((a, b) => a - b);
}

/** Tiles of group `group` on a `width` × `height` map. */
export function groupTiles(width: number, height: number, group: number): { x0: number; y0: number; x1: number; y1: number } {
  const { cols } = groupGrid(chunkGrid(width, height).cols, 0);
  const span = GROUP_CHUNKS * CHUNK_TILES;
  const x0 = (group % cols) * span;
  const y0 = Math.floor(group / cols) * span;
  return { x0, y0, x1: Math.min(x0 + span, width), y1: Math.min(y0 + span, height) };
}
