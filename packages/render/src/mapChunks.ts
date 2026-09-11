// The map as 16×16-tile chunks, one flat-coloured quad per tile, so a map edit rebuilds only the
// chunks whose tiles changed.
import type { MapLayersReply } from '@simcity/bridge';
import { tileToWorld } from '@simcity/sim';
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

export function buildChunkGeometry(map: MapLayersReply, cx: number, cy: number): ChunkGeometry {
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
      const [r, g, b] = CLASS_COLORS[tileClass(map, y * map.width + x)];
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
        colors[v] = r / 255;
        colors[v + 1] = g / 255;
        colors[v + 2] = b / 255;
        v += 3;
      }
    }
  }
  return { positions, colors, tiles };
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
