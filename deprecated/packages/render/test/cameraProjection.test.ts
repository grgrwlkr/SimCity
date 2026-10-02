// Port of crates/simcity_frontend/src/game/camera_projection.rs (mod tests): perspective close up, orthographic far
// out, and a framing that does not jump at the switch. `zoom` is world units per CSS pixel, the `worldPerPixel` of
// the debug camera.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { orthographicFrustum, perspectiveFovDeg, projectionPlan, visibleHeight, type ProjectionPlan } from '../src/cameraProjection';
import { RENDER_CONFIG } from '../src/renderConfig';

const VIEWPORT = 1000;
const cfg = RENDER_CONFIG.perspective;
const toDegrees = (rad: number) => (rad * 180) / Math.PI;

describe('camera projection', () => {
  it('closeZoomIsPerspectiveAndFarZoomIsOrthographic', () => {
    expect(projectionPlan(cfg.orthoAboveZoom * 0.5, VIEWPORT, cfg).kind).toBe('perspective');
    expect(projectionPlan(cfg.orthoAboveZoom, VIEWPORT, cfg).kind).toBe('orthographic');
    expect(projectionPlan(cfg.orthoAboveZoom * 2, VIEWPORT, cfg).kind).toBe('orthographic');
  });

  /**
   * The continuity pin compares this module's formula with itself. This one asks Three.js what its cameras actually
   * frame, the only way to catch a unit mismatch between the two sides of the threshold (Three.js takes the field of
   * view in degrees).
   */
  it('theOrthographicSideFramesWhatThreeFrames', () => {
    const zoom = cfg.orthoAboveZoom * 2;
    const ortho = projectionPlan(zoom, VIEWPORT, cfg);
    if (ortho.kind !== 'orthographic') throw new Error('expected orthographic above the threshold');
    const f = orthographicFrustum(ortho, VIEWPORT * 1.6, VIEWPORT);
    const orthoCamera = new THREE.OrthographicCamera(f.left, f.right, f.top, f.bottom, 0.1, 1000);
    orthoCamera.updateProjectionMatrix();
    const framed = 2 / orthoCamera.projectionMatrix.elements[5]!;
    const mine = visibleHeight(ortho, VIEWPORT);
    expect(Math.abs(mine - framed), `planned ${mine} against Three's ${framed}`).toBeLessThan(1e-3);
    expect(2 / orthoCamera.projectionMatrix.elements[0]! / framed, 'the frame keeps the viewport aspect').toBeCloseTo(1.6, 6);

    const near = projectionPlan(cfg.orthoAboveZoom * 0.5, VIEWPORT, cfg);
    if (near.kind !== 'perspective') throw new Error('expected perspective below the threshold');
    const perspectiveCamera = new THREE.PerspectiveCamera(perspectiveFovDeg(near), 1.6, 0.1, 5000);
    perspectiveCamera.updateProjectionMatrix();
    // At the focus, `distance` away, the frustum is 2 · distance / m[5] high.
    const seen = (2 * near.distance) / perspectiveCamera.projectionMatrix.elements[5]!;
    expect(Math.abs(seen - visibleHeight(near, VIEWPORT)), `planned ${visibleHeight(near, VIEWPORT)} against Three's ${seen}`).toBeLessThan(1e-3);
  });

  it('visibleHeightDoesNotJumpAtTheThreshold', () => {
    const below = visibleHeight(projectionPlan(cfg.orthoAboveZoom - 1e-4, VIEWPORT, cfg), VIEWPORT);
    const above = visibleHeight(projectionPlan(cfg.orthoAboveZoom, VIEWPORT, cfg), VIEWPORT);
    expect(Math.abs(below - above) / above, `framing jumps across the switch: ${below} vs ${above}`).toBeLessThan(0.01);
  });

  it('visibleHeightTracksZoomEverywhere', () => {
    for (let steps = 1; steps <= 20; steps++) {
      const zoom = 0.05 * steps;
      const framed = visibleHeight(projectionPlan(zoom, VIEWPORT, cfg), VIEWPORT);
      const expected = VIEWPORT * zoom;
      expect(Math.abs(framed - expected) / expected, `zoom ${zoom}: framed ${framed} instead of ${expected}`).toBeLessThan(0.02);
    }
  });

  /** The cascades are tuned for a camera 500 units out; parking the ortho camera at the perspective clamp cut the far ground off. */
  it('theOrthographicBoomStaysWhereTheShadowCascadesExpectIt', () => {
    const plan: ProjectionPlan = projectionPlan(cfg.orthoAboveZoom * 2, VIEWPORT, cfg);
    expect(plan.kind).toBe('orthographic');
    expect(Math.abs(plan.distance - cfg.orthoDistance), `ortho boom was ${plan.distance}, expected ${cfg.orthoDistance}`).toBeLessThan(1e-3);
  });

  it('theBoomNeverLeavesTheConfiguredRange', () => {
    for (let steps = 0; steps <= 40; steps++) {
      const zoom = 0.05 + 0.02 * steps;
      const { distance } = projectionPlan(zoom, VIEWPORT, cfg);
      expect(distance >= cfg.minDistance - 1e-3 && distance <= cfg.maxDistance + 1e-3, `zoom ${zoom} put the camera at ${distance}`).toBe(true);
    }
  });

  it('perspectiveWeakensAsTheCameraPullsBack', () => {
    const fovOf = (zoom: number) => {
      const plan = projectionPlan(zoom, VIEWPORT, cfg);
      if (plan.kind !== 'perspective') throw new Error(`expected perspective at ${zoom}, got ${plan.kind}`);
      return plan.fovYRad;
    };
    const closest = fovOf(0.05);
    const midway = fovOf(cfg.orthoAboveZoom * 0.5);
    const nearly = fovOf(cfg.orthoAboveZoom * 0.98);
    expect(closest > midway && midway > nearly, `fov should shrink monotonically: ${closest} ${midway} ${nearly}`).toBe(true);
    expect(toDegrees(nearly), 'the switch should happen where distortion is already small').toBeLessThan(25);
  });
});
