// `ray_ground_t` is ported from crates/simcity_sim/src/game/map/tests.rs (mod core_coords_ray); the
// rest pins the top-down debug camera.
import { DEFAULT_MAP_CONFIG, tileToWorld, worldToTile } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { OrthoView, SCENE_TILT } from '../src/camera';
import { RENDER_CONFIG } from '../src/renderConfig';
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

// The scene's tilted rig. `picking_round_trips_in_both_projections` and `the_frame_centre_picks_the_same_tile_in_both_projections`
// are ported from crates/simcity_sim/src/game/map/tests.rs (tag rust-final), whose `camera_at` is `SCENE_TILT`.
describe('tilted scene view', () => {
  const cfg = { width: 128, height: 128, tileSize: 16 };
  const focus = tileToWorld(cfg, { x: 64, y: 64 });
  /** The view over tile (64, 64) at `scale`, orthographic or perspective as asked. */
  function tilted(scale: number, kind: 'orthographic' | 'perspective'): OrthoView {
    const view = new OrthoView({ width: 1280, height: 720 });
    view.tilt = SCENE_TILT;
    view.perspective = { ...RENDER_CONFIG.perspective, orthoAboveZoom: kind === 'orthographic' ? 0.1 : 1 };
    view.centerX = focus.x;
    view.centerY = focus.y;
    view.worldPerPixel = scale;
    expect(view.plan().kind).toBe(kind);
    return view;
  }

  it('pickingRoundTripsInBothProjections', () => {
    for (const kind of ['orthographic', 'perspective'] as const) {
      const view = tilted(0.2, kind);
      for (const tile of [
        { x: 64, y: 64 },
        { x: 62, y: 66 },
        { x: 66, y: 62 },
        { x: 60, y: 60 },
      ]) {
        const w = tileToWorld(cfg, tile);
        const s = view.groundToScreen(w.x, w.y);
        expect(s.x >= 0 && s.x <= 1280 && s.y >= 0 && s.y <= 720, `${kind}: ${JSON.stringify(tile)} on screen at ${JSON.stringify(s)}`).toBe(true);
        expect(view.pickTile(cfg, s.x, s.y), kind).toEqual(tile);
      }
    }
  });

  it('theFrameCentrePicksTheSameTileInBothProjections', () => {
    const ortho = tilted(0.2, 'orthographic').pickTile(cfg, 640, 360);
    const perspective = tilted(0.2, 'perspective').pickTile(cfg, 640, 360);
    expect(ortho).toEqual({ x: 64, y: 64 });
    expect(perspective).toEqual(ortho);
  });

  it('theCameraLooksNorthWestFromTheSouthEast', () => {
    const view = tilted(0.5, 'orthographic');
    const eye = view.eye();
    expect(eye[0]).toBeGreaterThan(focus.x);
    expect(eye[1]).toBeLessThan(focus.y);
    expect(eye[2]).toBeGreaterThan(0);
    // North-east runs across the screen, and ground nearer the camera sits lower in the frame.
    const ne = view.groundToScreen(focus.x + 40, focus.y + 40);
    expect(ne.x).toBeGreaterThan(640);
    expect(Math.abs(ne.y - 360)).toBeLessThan(1e-6);
    expect(view.groundToScreen(focus.x + 40, focus.y - 40).y).toBeGreaterThan(360);
    // A roof sits above its footprint on screen.
    expect(view.worldToScreen(focus.x, focus.y, 20).y).toBeLessThan(360);
  });

  it('zoomAndPanKeepTheGroundUnderTheCursor', () => {
    for (const kind of ['orthographic', 'perspective'] as const) {
      const view = tilted(0.2, kind);
      const anchor = view.screenToGround(900, 200);
      view.zoomAt(900, 200, 0.8);
      const after = view.screenToGround(900, 200);
      expect(Math.hypot(after.x - anchor.x, after.y - anchor.y), `${kind} zoom`).toBeLessThan(1e-3);
      // `panBy` knows the drag, not the cursor: the ground at the centre follows it exactly, and in the orthographic
      // half every other point does too; in perspective a point off centre drifts by the foreshortening.
      const grabbed = view.screenToGround(640 - 25, 360 + 40);
      const far = view.screenToGround(300, 500);
      view.panBy(25, -40);
      const s = view.groundToScreen(grabbed.x, grabbed.y);
      expect(Math.hypot(s.x - 640, s.y - 360), `${kind} pan`).toBeLessThan(1e-6);
      if (kind === 'orthographic') {
        const f = view.groundToScreen(far.x, far.y);
        expect(Math.hypot(f.x - 325, f.y - 460)).toBeLessThan(1e-6);
      }
    }
  });

  it('fitMapShowsEveryCornerAndBoundsCoverTheFrame', () => {
    const view = new OrthoView({ width: 800, height: 600 });
    view.tilt = SCENE_TILT;
    view.fitMap(cfg);
    const half = (cfg.width * cfg.tileSize) / 2;
    const b = view.bounds();
    for (const [x, y] of [
      [-half, -half],
      [half, -half],
      [half, half],
      [-half, half],
    ] as const) {
      const s = view.groundToScreen(x, y);
      expect(s.x >= -1e-6 && s.x <= 800 + 1e-6 && s.y >= -1e-6 && s.y <= 600 + 1e-6, `corner ${x},${y} at ${JSON.stringify(s)}`).toBe(true);
    }
    for (const [sx, sy] of [
      [0, 0],
      [800, 0],
      [800, 600],
      [0, 600],
    ] as const) {
      const g = view.screenToGround(sx, sy);
      expect(g.x >= b.left - 1e-6 && g.x <= b.right + 1e-6 && g.y >= b.bottom - 1e-6 && g.y <= b.top + 1e-6, `screen corner ${sx},${sy}`).toBe(true);
    }
  });

  it('theDebugViewStaysStraightDown', () => {
    const view = new OrthoView({ width: 800, height: 600 });
    expect(view.tilt).toBeNull();
    expect(view.viewRay(400, 300).dir).toEqual([0, 0, -1]);
  });
});
