// `ray_ground_t` is ported from crates/simcity_sim/src/game/map/tests.rs (mod core_coords_ray); the
// rest pins the top-down debug camera.
import { DEFAULT_MAP_CONFIG, tileToWorld, worldToTile } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { OrthoView } from '../src/camera';
import { rayGroundT, type Vec3 } from '../src/picking';

const close = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

describe('ray to ground', () => {
  it('straightDownHitsAtCameraHeight', () => {
    expect(rayGroundT([3, 4, 10], [0, 0, -1])).toBe(10);
  });

  it('tiltedRayLandsOnExpectedGroundPoint', () => {
    const origin: Vec3 = [0, -10, 10];
    const len = Math.hypot(0, 1, -1);
    const dir: Vec3 = [0, 1 / len, -1 / len];
    const t = rayGroundT(origin, dir);
    expect(t, 'ray must hit the ground').toBeDefined();
    const hit = origin.map((o, i) => o + dir[i]! * t!);
    expect(Math.abs(hit[2]!)).toBeLessThan(1e-4);
    expect(Math.hypot(hit[0]!, hit[1]!)).toBeLessThan(1e-4);
  });

  it('parallelAndBackwardRaysMiss', () => {
    expect(rayGroundT([0, 0, 10], [1, 0, 0])).toBeUndefined();
    expect(rayGroundT([0, 0, 10], [0, 0, 1])).toBeUndefined();
  });
});

describe('top-down ortho view', () => {
  it('screenToGroundInvertsGroundToScreen', () => {
    const view = new OrthoView({ width: 800, height: 600 });
    view.centerX = 37;
    view.centerY = -12;
    view.worldPerPixel = 1.75;
    for (const [x, y] of [
      [0, 0],
      [123.5, -40],
      [-500, 300],
    ] as const) {
      const s = view.groundToScreen(x, y);
      const g = view.screenToGround(s.x, s.y);
      expect(close(g.x, x) && close(g.y, y), `${x},${y}`).toBe(true);
    }
    const c = view.groundToScreen(37, -12);
    expect(c).toEqual({ x: 400, y: 300 });
  });

  it('pickTileMatchesWorldToTile', () => {
    const cfg = DEFAULT_MAP_CONFIG;
    const view = new OrthoView({ width: 1000, height: 1000 });
    view.fitMap(cfg);
    for (const tile of [
      { x: 0, y: 0 },
      { x: 17, y: 90 },
      { x: 127, y: 127 },
    ]) {
      const world = tileToWorld(cfg, tile);
      const s = view.groundToScreen(world.x, world.y);
      expect(view.pickTile(cfg, s.x, s.y)).toEqual(worldToTile(cfg, world));
      expect(view.pickTile(cfg, s.x, s.y)).toEqual(tile);
    }
    expect(view.pickTile(cfg, -50, -50), 'outside the map').toBeUndefined();
  });

  it('fitMapShowsTheWholeMapNorthUp', () => {
    const cfg = DEFAULT_MAP_CONFIG;
    const view = new OrthoView({ width: 1280, height: 720 });
    view.fitMap(cfg);
    const sw = tileToWorld(cfg, { x: 0, y: 0 });
    const ne = tileToWorld(cfg, { x: cfg.width - 1, y: cfg.height - 1 });
    const a = view.groundToScreen(sw.x, sw.y);
    const b = view.groundToScreen(ne.x, ne.y);
    expect(b.x, 'east is to the right').toBeGreaterThan(a.x);
    expect(b.y, 'north is up').toBeLessThan(a.y);
    for (const p of [a, b]) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1280);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(720);
    }
    // The map touches the limiting side: 128 tiles * 16 world units over 720 pixels.
    expect(close(view.worldPerPixel, (cfg.height * cfg.tileSize) / 720)).toBe(true);
  });

  it('zoomAtKeepsTheGroundPointUnderTheCursor', () => {
    const view = new OrthoView({ width: 800, height: 600 });
    view.fitMap(DEFAULT_MAP_CONFIG);
    const before = view.screenToGround(610, 95);
    view.zoomAt(610, 95, 0.5);
    const after = view.screenToGround(610, 95);
    expect(close(before.x, after.x) && close(before.y, after.y)).toBe(true);
  });

  it('panMovesByScreenPixels', () => {
    const view = new OrthoView({ width: 800, height: 600 });
    view.worldPerPixel = 2;
    const grabbed = view.screenToGround(100, 100);
    view.panBy(30, -20);
    const s = view.groundToScreen(grabbed.x, grabbed.y);
    expect(s, 'the grabbed ground point follows the cursor').toEqual({ x: 130, y: 80 });
  });
});
