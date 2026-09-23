// The ground of the scene in the chunks and groups of `mapChunks.ts`: one quad per tile carrying the atlas UVs of its cell and its
// colour in linear light, so every chunk draws with the one vertex-mapped ground material.
import type { MapLayersReply } from '@simcity/bridge';
import { tileToWorld } from '@simcity/sim';
import { uvIn, type AtlasCell } from '../atlas';
import type { TilePaint } from '../dataMap';
import { CHUNK_TILES } from '../mapChunks';
import { tileClass, type TileClass } from '../palette';

/** sRGB 0..1: pavement for zoned and built land, the colour of what a zone is left to the buildings on it. */
const GROUND: Readonly<Record<TileClass, readonly [number, number, number, AtlasCell]>> = {
  grass: [0.36, 0.52, 0.26, 'Grass'],
  water: [0.22, 0.42, 0.62, 'Water'],
  road: [0.32, 0.33, 0.35, 'Asphalt'],
  box: [0.36, 0.37, 0.39, 'Asphalt'],
  residential: [0.62, 0.68, 0.56, 'Sidewalk'],
  commercial: [0.6, 0.63, 0.7, 'Sidewalk'],
  industrial: [0.64, 0.6, 0.52, 'Sidewalk'],
  building: [0.66, 0.66, 0.64, 'Sidewalk'],
};

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export interface GroundGeometry {
  readonly positions: Float32Array;
  readonly uvs: Float32Array;
  /** Linear rgb per vertex. */
  readonly colors: Float32Array;
  readonly normals: Float32Array;
}

export function buildGroundChunk(map: MapLayersReply, cx: number, cy: number): GroundGeometry {
  const x0 = cx * CHUNK_TILES;
  const y0 = cy * CHUNK_TILES;
  return buildGroundArea(map, { x0, y0, x1: Math.min(x0 + CHUNK_TILES, map.width), y1: Math.min(y0 + CHUNK_TILES, map.height) });
}

type Area = { x0: number; y0: number; x1: number; y1: number };

/** The ground of tiles `x0..x1` × `y0..y1`: what the scene draws per group of `mapChunks.ts`; `paint` is a data map's. */
export function buildGroundArea(map: MapLayersReply, area: Area, paint: TilePaint | null = null): GroundGeometry {
  const { x0, y0, x1, y1 } = area;
  const tiles = Math.max(x1 - x0, 0) * Math.max(y1 - y0, 0);
  const positions = new Float32Array(tiles * 18);
  const colors = new Float32Array(tiles * 18);
  const normals = new Float32Array(tiles * 18);
  const uvs = new Float32Array(tiles * 12);
  const cfg = { width: map.width, height: map.height, tileSize: map.tileSize };
  const half = map.tileSize / 2;
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, -1],
    [1, 1],
    [-1, 1],
  ] as const;
  let v = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const c = tileToWorld(cfg, { x, y });
      const cell = GROUND[tileClass(map, y * map.width + x)][3];
      for (const [sx, sy] of corners) {
        positions.set([c.x + sx * half, c.y + sy * half, 0], v * 3);
        normals.set([0, 0, 1], v * 3);
        uvs.set(uvIn(cell, (sx + 1) / 2, (sy + 1) / 2), v * 2);
        v += 1;
      }
    }
  }
  groundColors(map, area, colors, paint);
  return { positions, uvs, colors, normals };
}

/** Writes the area's vertex colours into `colors` in place, linear: the ground's own, or a data map's over it. */
export function groundColors(map: MapLayersReply, { x0, y0, x1, y1 }: Area, colors: Float32Array, paint: TilePaint | null): void {
  let v = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = y * map.width + x;
      const plain = GROUND[tileClass(map, idx)];
      const [r, g, b] = paint === null ? plain : paint(idx, [plain[0], plain[1], plain[2]]);
      const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
      for (let k = 0; k < 6; k++, v += 3) {
        colors[v] = lr;
        colors[v + 1] = lg;
        colors[v + 2] = lb;
      }
    }
  }
}
