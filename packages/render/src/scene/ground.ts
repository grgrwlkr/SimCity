// The ground of the scene in the chunks of `mapChunks.ts`: one quad per tile carrying the atlas UVs of its cell and its
// colour in linear light, so every chunk draws with the one vertex-mapped ground material.
import type { MapLayersReply } from '@simcity/bridge';
import { tileToWorld } from '@simcity/sim';
import { uvIn, type AtlasCell } from '../atlas';
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
  const x1 = Math.min(x0 + CHUNK_TILES, map.width);
  const y1 = Math.min(y0 + CHUNK_TILES, map.height);
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
      const [r, g, b, cell] = GROUND[tileClass(map, y * map.width + x)];
      for (const [sx, sy] of corners) {
        positions.set([c.x + sx * half, c.y + sy * half, 0], v * 3);
        colors.set([lin(r), lin(g), lin(b)], v * 3);
        normals.set([0, 0, 1], v * 3);
        uvs.set(uvIn(cell, (sx + 1) / 2, (sy + 1) / 2), v * 2);
        v += 1;
      }
    }
  }
  return { positions, uvs, colors, normals };
}
