// Stage 3½d: at ×60 and above the roads show their load. A meso link is a rectangle over its lane tiles, coloured from green
// when it is empty through yellow to red when its queue fills it.
import { tileFToWorld, type MapConfig } from '@simcity/sim';

type Rgb = readonly [number, number, number];

export const LOAD_COLORS: Readonly<Record<'free' | 'busy' | 'full', Rgb>> = {
  free: [46, 196, 96],
  busy: [240, 204, 48],
  full: [232, 52, 40],
};

// `ROAD_DIRS` indices.
const WEST = 1;
const EAST = 2;

export interface LinkRect {
  /** Centre, world coordinates. */
  readonly x: number;
  readonly y: number;
  /** World units along x and y. */
  readonly width: number;
  readonly height: number;
}

/** The rectangle of a link of `lanes` in direction `dir` whose end cross-sections are centred on (`sx`, `sy`) and (`ex`, `ey`), tiles. */
export function linkRect(cfg: MapConfig, dir: number, lanes: number, sx: number, sy: number, ex: number, ey: number): LinkRect {
  const centre = tileFToWorld(cfg, (sx + ex) / 2, (sy + ey) / 2);
  const horizontal = dir === EAST || dir === WEST;
  const along = (horizontal ? Math.abs(ex - sx) : Math.abs(ey - sy)) + 1;
  const [tilesX, tilesY] = horizontal ? [along, lanes] : [lanes, along];
  return { x: centre.x, y: centre.y, width: tilesX * cfg.tileSize, height: tilesY * cfg.tileSize };
}

/** The colour of a load byte: green, yellow at half, red when full. */
export function loadColor(load: number): Rgb {
  const t = Math.min(Math.max(load / 255, 0), 1);
  const [a, b, u] = t < 0.5 ? [LOAD_COLORS.free, LOAD_COLORS.busy, t * 2] : [LOAD_COLORS.busy, LOAD_COLORS.full, (t - 0.5) * 2];
  return [Math.round(a[0] + (b[0] - a[0]) * u), Math.round(a[1] + (b[1] - a[1]) * u), Math.round(a[2] + (b[2] - a[2]) * u)];
}
