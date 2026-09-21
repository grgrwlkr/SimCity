// Picking under both projections: port of `picking_round_trips_in_both_projections` and
// `the_frame_centre_picks_the_same_tile_in_both_projections`
// (rust-final:crates/simcity_sim/src/game/map/tests.rs, mod core_coords_projection).
// The Rust rig tilted the camera; the debug view looks straight down and the layout gate reads tile classes
// back off its screenshot, so the tilt waits for the scene stages. What is pinned is the same claim under the
// two projections the zoom picks: the frame Three.js actually draws, inverted back to the tile it came from.
import { DEFAULT_MAP_CONFIG, tileToWorld, worldToTile, type TilePos } from '@simcity/sim';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { OrthoView } from '../src/camera';
import { orthographicFrustum, perspectiveFovDeg, visibleHeight, type ProjectionPlan } from '../src/cameraProjection';
import { RENDER_CONFIG } from '../src/renderConfig';

const VIEWPORT = { width: 1600, height: 1000 };
const CFG = DEFAULT_MAP_CONFIG;
/** The Rust fixture's `scale`: 200 world units of ground in view, whichever projection frames them. */
const ZOOM = 0.2;
/** The world origin sits on a tile corner, where rounding can go either way, so the camera aims at a tile centre. */
const FOCUS: TilePos = { x: 64, y: 64 };

/** The debug view at `ZOOM`; only where the threshold sits decides which projection that one zoom gets. */
function viewIn(kind: ProjectionPlan['kind']): OrthoView {
  const view = new OrthoView(VIEWPORT);
  const focus = tileToWorld(CFG, FOCUS);
  view.centerX = focus.x;
  view.centerY = focus.y;
  view.worldPerPixel = ZOOM;
  view.perspective = { ...RENDER_CONFIG.perspective, orthoAboveZoom: kind === 'orthographic' ? ZOOM : ZOOM * 2 };
  expect(view.plan().kind, `the ${kind} fixture`).toBe(kind);
  return view;
}

/** The camera Three.js draws the frame with, built from the plan the way the renderer builds it. */
function threeCamera(view: OrthoView): THREE.Camera {
  const plan = view.plan();
  const { width, height } = view.viewport;
  let camera: THREE.Camera;
  if (plan.kind === 'orthographic') {
    const f = orthographicFrustum(plan, width, height);
    camera = new THREE.OrthographicCamera(f.left, f.right, f.top, f.bottom, 0.1, plan.distance * 4);
  } else {
    camera = new THREE.PerspectiveCamera(perspectiveFovDeg(plan), width / height, 0.1, plan.distance * 4);
  }
  camera.position.set(view.centerX, view.centerY, plan.distance);
  camera.up.set(0, 1, 0);
  camera.lookAt(view.centerX, view.centerY, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

/** `Camera::world_to_viewport`: a ground point in CSS pixels from the top-left corner. */
function worldToViewport(camera: THREE.Camera, x: number, y: number): { x: number; y: number } {
  const ndc = new THREE.Vector3(x, y, 0).project(camera);
  return { x: ((ndc.x + 1) / 2) * VIEWPORT.width, y: ((1 - ndc.y) / 2) * VIEWPORT.height };
}

/** Tile -> screen -> tile must be the identity, or picking lies. */
function assertRoundTrip(label: string, view: OrthoView): void {
  const camera = threeCamera(view);
  for (const tile of [
    { x: 64, y: 64 },
    { x: 62, y: 66 },
    { x: 66, y: 62 },
    { x: 60, y: 60 },
  ]) {
    const world = tileToWorld(CFG, tile);
    const screen = worldToViewport(camera, world.x, world.y);
    const onScreen = screen.x >= 0 && screen.x <= VIEWPORT.width && screen.y >= 0 && screen.y <= VIEWPORT.height;
    expect(onScreen, `${label}: tile ${tile.x},${tile.y} is off screen at ${screen.x},${screen.y}`).toBe(true);
    // The view's own forward mapping must be the frame Three draws, or picking inverts a projection nobody sees.
    const mine = view.groundToScreen(world.x, world.y);
    expect(Math.hypot(mine.x - screen.x, mine.y - screen.y), `${label}: the view frames ${tile.x},${tile.y} elsewhere than Three`).toBeLessThan(0.01);
    const back = view.screenToGround(screen.x, screen.y);
    expect(worldToTile(CFG, back), `${label}: ${tile.x},${tile.y} came back as another tile (world ${world.x},${world.y} -> ${back.x},${back.y})`).toEqual(tile);
  }
}

describe('picking across the projection switch', () => {
  it('pickingRoundTripsInBothProjections', () => {
    const ortho = viewIn('orthographic');
    const perspective = viewIn('perspective');
    // Framed to show the same ground height, as the Rust fixture framed its two cameras.
    expect(visibleHeight(perspective.plan(), VIEWPORT.height)).toBeCloseTo(visibleHeight(ortho.plan(), VIEWPORT.height), 6);
    assertRoundTrip('orthographic', ortho);
    assertRoundTrip('perspective', perspective);
  });

  it('theFrameCentrePicksTheSameTileInBothProjections', () => {
    const ortho = viewIn('orthographic');
    const perspective = viewIn('perspective');
    const centre = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
    const orthoTile = ortho.pickTile(CFG, centre.x, centre.y);
    expect(orthoTile, 'orthographic centre found no ground').toBeDefined();
    expect(perspective.pickTile(CFG, centre.x, centre.y), 'the two projections look at the same focus, so the centre pixel is the same tile').toEqual(orthoTile);
    expect(orthoTile, 'and that tile is the one the camera is aimed at').toEqual(FOCUS);

    // The centre is every projection's fixed point, so on its own it would agree however wrong the frustum was.
    // Away from it the two frames only still agree because they are the same size.
    for (const at of [
      { x: centre.x + 380, y: centre.y - 240 },
      { x: centre.x - 300, y: centre.y + 190 },
    ]) {
      const tile = ortho.pickTile(CFG, at.x, at.y);
      expect(tile, `orthographic found no ground at ${at.x},${at.y}`).toBeDefined();
      expect(tile, `the two frames disagree away from the centre, at ${at.x},${at.y}`).not.toEqual(FOCUS);
      expect(perspective.pickTile(CFG, at.x, at.y), `the two frames disagree at ${at.x},${at.y}`).toEqual(tile);
    }
  });

  /**
   * `projectionPlan` refuses to frame less than 1e-3 of ground, and nothing bounds the zoom, so far enough in
   * the frame stops following `worldPerPixel`. Both directions read it off the plan, so they still invert.
   */
  it('theTwoDirectionsAgreeWhereTheFrameStopsFollowingTheZoom', () => {
    const view = new OrthoView(VIEWPORT);
    view.worldPerPixel = 1e-7;
    expect(view.perPixel() / view.worldPerPixel, 'precondition: the plan has stopped following the zoom').toBeGreaterThan(2);
    const world = { x: 3e-5, y: -1.7e-5 };
    const screen = view.groundToScreen(world.x, world.y);
    const back = view.screenToGround(screen.x, screen.y);
    expect(Math.hypot(back.x - world.x, back.y - world.y), `${world.x},${world.y} came back as ${back.x},${back.y}`).toBeLessThan(1e-9);
  });
});
