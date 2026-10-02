// Choosing the camera projection from the zoom: port of crates/simcity_frontend/src/game/camera_projection.rs. Close up
// the city looks photographed, far out it reads like a map. One projection type cannot blend into the other, so what
// stays continuous is the framing: the ground height in view is the same on both sides of the threshold, and the field
// of view narrows on the way so the distortion has faded before the switch.
import type { PerspectiveConfig } from './renderConfig';

/**
 * What the camera is at a zoom. `zoom` is world units per CSS pixel, the `worldPerPixel` of the debug view; CSS pixels
 * are what Rust had to call logical pixels, and mixing in device pixels halved the frame at the switch on a 2× screen.
 */
export type ProjectionPlan =
  | { readonly kind: 'perspective'; readonly fovYRad: number; readonly distance: number }
  | { readonly kind: 'orthographic'; readonly scale: number; readonly distance: number };

/** Ground height visible at the focus, world units: the quantity that must not jump when the projection switches. */
export function visibleHeight(plan: ProjectionPlan, viewportHeight: number): number {
  return plan.kind === 'perspective' ? 2 * plan.distance * Math.tan(plan.fovYRad / 2) : viewportHeight * plan.scale;
}

/** The projection for a zoom; `distance` is the boom from the focus to the camera. */
export function projectionPlan(zoom: number, viewportHeight: number, cfg: PerspectiveConfig): ProjectionPlan {
  if (zoom >= cfg.orthoAboveZoom) return { kind: 'orthographic', scale: zoom, distance: cfg.orthoDistance };

  // The ground height the orthographic side shows at this zoom, which keeps the framing continuous.
  const height = Math.max(viewportHeight * zoom, 1e-3);
  const t = Math.min(Math.max(zoom / cfg.orthoAboveZoom, 0), 1) ** Math.max(cfg.ramp, 0.01);
  const wantedFov = ((cfg.nearFovDeg + (cfg.farFovDeg - cfg.nearFovDeg) * t) * Math.PI) / 180;
  const distance = Math.min(Math.max(height / (2 * Math.tan(wantedFov / 2)), cfg.minDistance), cfg.maxDistance);
  // The field of view recovered from the distance that survived the clamp, so the frame shows exactly `height`.
  return { kind: 'perspective', fovYRad: 2 * Math.atan(height / (2 * distance)), distance };
}

/** Frustum edges of a `THREE.OrthographicCamera` centred on the focus. */
export function orthographicFrustum(
  plan: Extract<ProjectionPlan, { kind: 'orthographic' }>,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; right: number; top: number; bottom: number } {
  const halfW = (viewportWidth * plan.scale) / 2;
  const halfH = (viewportHeight * plan.scale) / 2;
  return { left: -halfW, right: halfW, top: halfH, bottom: -halfH };
}

/** `THREE.PerspectiveCamera.fov`, which is vertical and in degrees. */
export function perspectiveFovDeg(plan: Extract<ProjectionPlan, { kind: 'perspective' }>): number {
  return (plan.fovYRad * 180) / Math.PI;
}
