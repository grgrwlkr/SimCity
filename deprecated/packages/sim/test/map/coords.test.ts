// Ported from crates/simcity_sim/src/game/map/tests.rs, mod core_coords. World coordinates are f32
// in Rust, so every vector sum in the test is rounded to f32 as `Vec2 + Vec2` would be.
import { describe, expect, it } from 'vitest';
import { mapOrigin, tileFToWorld, tileToWorld, worldToTile, type MapConfig, type Vec2 } from '../../src/map/coords';

const cfg: MapConfig = { width: 8, height: 6, tileSize: 16 };

const add = (a: Vec2, dx: number, dy: number): Vec2 => ({
  x: Math.fround(a.x + Math.fround(dx)),
  y: Math.fround(a.y + Math.fround(dy)),
});
const length = (v: Vec2): number => Math.hypot(v.x, v.y);

describe('core coords', () => {
  it('roundtripAllTiles', () => {
    for (let x = 0; x < cfg.width; x++) {
      for (let y = 0; y < cfg.height; y++) {
        expect(worldToTile(cfg, tileToWorld(cfg, { x, y }))).toEqual({ x, y });
      }
    }
  });

  it('roundtripSurvivesSubtileOffsets', () => {
    const t = { x: 3, y: 2 };
    for (const [dx, dy] of [
      [7.9, 0],
      [-7.9, 0],
      [0, 7.9],
      [-7.9, -7.9],
    ] as const) {
      expect(worldToTile(cfg, add(tileToWorld(cfg, t), dx, dy)), `offset (${dx},${dy})`).toEqual(t);
    }
  });

  it('outsideMapIsNone', () => {
    const last = tileToWorld(cfg, { x: cfg.width - 1, y: cfg.height - 1 });
    expect(worldToTile(cfg, add(last, cfg.tileSize, cfg.tileSize))).toBeUndefined();
    expect(worldToTile(cfg, { x: Math.fround(-1e6), y: Math.fround(-1e6) })).toBeUndefined();
  });

  it('mapIsCenteredOnOrigin', () => {
    const a = tileToWorld(cfg, { x: 0, y: 0 });
    const b = tileToWorld(cfg, { x: cfg.width - 1, y: cfg.height - 1 });
    expect(length({ x: a.x + b.x, y: a.y + b.y })).toBeLessThan(1e-4);
    expect(mapOrigin(cfg)).toEqual(a);
  });

  it('fractionalMatchesIntegerAtWholeTiles', () => {
    expect(tileFToWorld(cfg, 5, 1)).toEqual(tileToWorld(cfg, { x: 5, y: 1 }));
    const c = tileFToWorld(cfg, 2.5, 2.5);
    const p = tileToWorld(cfg, { x: 2, y: 2 });
    const q = tileToWorld(cfg, { x: 3, y: 3 });
    const expected = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    expect(length({ x: c.x - expected.x, y: c.y - expected.y })).toBeLessThan(1e-4);
  });
});
