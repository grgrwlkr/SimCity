// Canonical tile <-> world mapping: port of simcity_core/src/game/map/coords.rs. World coordinates
// are f32 in Rust, so every operation is rounded to f32; the map is centred on the world origin.
import type { TilePos } from '../commands';

export interface MapConfig {
  readonly width: number;
  readonly height: number;
  /** `f32`. */
  readonly tileSize: number;
}

export const DEFAULT_MAP_CONFIG: MapConfig = { width: 128, height: 128, tileSize: 16 };

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

const f32 = Math.fround;

/** `f32::round`: half away from zero. Exact for f32 inputs: `v + 0.5` needs no more bits than a double has. */
function roundHalfAwayFromZero(v: number): number {
  return v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5);
}

/** World-space centre of tile (0,0). */
export function mapOrigin(cfg: MapConfig): Vec2 {
  const ts = f32(cfg.tileSize);
  return {
    x: f32(f32(-(cfg.width - 1) * ts) * 0.5),
    y: f32(f32(-(cfg.height - 1) * ts) * 0.5),
  };
}

/** Fractional tile coordinates -> world (footprint centres, sub-tile offsets). */
export function tileFToWorld(cfg: MapConfig, tileX: number, tileY: number): Vec2 {
  const origin = mapOrigin(cfg);
  const ts = f32(cfg.tileSize);
  return {
    x: f32(origin.x + f32(f32(tileX) * ts)),
    y: f32(origin.y + f32(f32(tileY) * ts)),
  };
}

/** Centre of `tile` in world coordinates. */
export function tileToWorld(cfg: MapConfig, tile: TilePos): Vec2 {
  return tileFToWorld(cfg, tile.x, tile.y);
}

/** Inverse mapping with round-to-nearest semantics (picking); `undefined` outside the map. */
export function worldToTile(cfg: MapConfig, world: Vec2): TilePos | undefined {
  const origin = mapOrigin(cfg);
  const ts = f32(cfg.tileSize);
  const x = roundHalfAwayFromZero(f32(f32(world.x - origin.x) / ts)) | 0;
  const y = roundHalfAwayFromZero(f32(f32(world.y - origin.y) / ts)) | 0;
  if (x < 0 || y < 0 || x >= cfg.width || y >= cfg.height) return undefined;
  return { x, y };
}
