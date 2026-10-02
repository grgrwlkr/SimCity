// The view of both renderers. Without a tilt (the debug renderer) the camera hangs straight above the ground, north up
// and east right; the scene sets `SCENE_TILT` and looks down a boom from the south-east, as the Rust rig did. The zoom
// picks the projection — perspective close up, orthographic far out — through `projectionPlan`, and both sides frame
// the same height on the focal plane, so only the shape of the view ray differs. Screen coordinates are CSS pixels
// from the top-left corner of the canvas. The class keeps its name: every call site outside this package still holds
// an `OrthoView`.
import { worldToTile, type MapConfig, type TilePos, type Vec2 } from '@simcity/sim';
import { orthographicFrustum, perspectiveFovDeg, projectionPlan, type ProjectionPlan } from './cameraProjection';
import { rayToGround, type Vec3 } from './picking';
import { RENDER_CONFIG, type PerspectiveConfig } from './renderConfig';

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** The ray a pixel casts, from the camera towards the ground. */
export interface ViewRay {
  readonly origin: Vec3;
  /** Unit length, so `rayGroundT` reads as a distance. */
  readonly dir: Vec3;
}

/** Boom direction of a tilted camera: `yaw` round Z from +X, `pitch` above the horizon, both radians. */
export interface ViewTilt {
  readonly yaw: number;
  readonly pitch: number;
}

/** The game's rig: `camera_at` of rust-final crates/simcity_sim/src/game/map/tests.rs, `DEFAULT_PITCH` of simcity_core camera.rs. */
export const SCENE_TILT: ViewTilt = { yaw: -Math.PI / 4, pitch: 0.96 };

type V3 = readonly [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Camera axes of a tilt: `back` from the focus to the eye, `right` and `up` across the screen (up as `lookAt` with Z up). */
export function tiltBasis(t: ViewTilt): { back: V3; right: V3; up: V3 } {
  const back: V3 = [Math.cos(t.yaw) * Math.cos(t.pitch), Math.sin(t.yaw) * Math.cos(t.pitch), Math.sin(t.pitch)];
  const len = Math.hypot(back[0], back[1]);
  const right: V3 = [-back[1] / len, back[0] / len, 0];
  const up: V3 = [back[1] * right[2] - back[2] * right[1], back[2] * right[0] - back[0] * right[2], back[0] * right[1] - back[1] * right[0]];
  return { back, right, up };
}

export class OrthoView {
  /** World point at the centre of the viewport. */
  centerX = 0;
  centerY = 0;
  /** World units per CSS pixel: larger is further out. */
  worldPerPixel = 1;
  /** Where the zoom turns the camera orthographic and how strong the perspective is below that. */
  perspective: PerspectiveConfig = RENDER_CONFIG.perspective;
  /** `null` looks straight down: the debug renderer and every tile-readback gate depend on it. */
  tilt: ViewTilt | null = null;

  constructor(public viewport: Viewport) {}

  /**
   * How far the eye sits from the focus along the boom. Perspective: the plan's distance. Orthographic: far enough back
   * that the near edge of a tilted frame is not behind the camera (the projection itself ignores the distance).
   */
  eyeDistance(): number {
    const plan = this.plan();
    if (plan.kind === 'perspective' || this.tilt === null) return plan.distance;
    return plan.distance + (Math.max(this.viewport.width, this.viewport.height) * this.perPixel()) / Math.tan(this.tilt.pitch);
  }

  /** Where the camera is, world units. */
  eye(): Vec3 {
    const d = this.eyeDistance();
    if (this.tilt === null) return [this.centerX, this.centerY, d];
    const { back } = tiltBasis(this.tilt);
    return [this.centerX + back[0] * d, this.centerY + back[1] * d, back[2] * d];
  }

  /** The projection this zoom asks for; the ground height in view is the same on both sides of the switch. */
  plan(): ProjectionPlan {
    return projectionPlan(this.worldPerPixel, Math.max(this.viewport.height, 1), this.perspective);
  }

  /**
   * Ground one CSS pixel covers at the focus, read off the very numbers the renderer hands Three —
   * `orthographicFrustum` and `perspectiveFovDeg` — so the picture, the forward mapping and the picking
   * cannot drift apart. It is `worldPerPixel` wherever the plan does not clamp, and the clamp is why it is
   * worth carrying: under 1e-3 of framed ground `projectionPlan` holds the frame open and the zoom stops
   * being the answer. Nothing bounds the zoom, so that floor is reachable.
   */
  perPixel(): number {
    const plan = this.plan();
    const height = Math.max(this.viewport.height, 1);
    if (plan.kind === 'orthographic') {
      const f = orthographicFrustum(plan, Math.max(this.viewport.width, 1), height);
      return (f.top - f.bottom) / height;
    }
    return (2 * plan.distance * Math.tan(((perspectiveFovDeg(plan) * Math.PI) / 180) / 2)) / height;
  }

  groundToScreen(x: number, y: number): Vec2 {
    return this.worldToScreen(x, y, 0);
  }

  /** Screen point of a world point `z` above the ground; without a tilt the height makes no difference. */
  worldToScreen(x: number, y: number, z: number): Vec2 {
    const perPixel = this.perPixel();
    if (this.tilt !== null) {
      const { back, right, up } = tiltBasis(this.tilt);
      const eye = this.eye();
      const v: V3 = [x - eye[0], y - eye[1], z - eye[2]];
      // Perspective scales the offset onto the focal plane at the plan's distance; orthographic keeps it.
      const k = this.plan().kind === 'perspective' ? this.eyeDistance() / -dot(v, back) : 1;
      return { x: this.viewport.width / 2 + (dot(v, right) * k) / perPixel, y: this.viewport.height / 2 - (dot(v, up) * k) / perPixel };
    }
    return {
      x: this.viewport.width / 2 + (x - this.centerX) / perPixel,
      y: this.viewport.height / 2 - (y - this.centerY) / perPixel,
    };
  }

  /**
   * The ray a screen point casts, built from the camera's own parameters rather than from the zoom:
   * the counterpart of `Camera::viewport_to_world`, and the only part of picking the projection changes.
   */
  viewRay(sx: number, sy: number): ViewRay {
    const plan = this.plan();
    // Pixels are square, so the one figure covers both sides of the frame.
    const perPixel = this.perPixel();
    const dx = (sx - this.viewport.width / 2) * perPixel;
    const dy = (this.viewport.height / 2 - sy) * perPixel;
    if (this.tilt !== null) {
      const { back, right, up } = tiltBasis(this.tilt);
      const eye = this.eye();
      if (plan.kind === 'orthographic') {
        return { origin: [eye[0] + right[0] * dx + up[0] * dy, eye[1] + right[1] * dx + up[1] * dy, eye[2] + up[2] * dy], dir: [-back[0], -back[1], -back[2]] };
      }
      const d = plan.distance;
      const dir: V3 = [-back[0] * d + right[0] * dx + up[0] * dy, -back[1] * d + right[1] * dx + up[1] * dy, -back[2] * d + up[2] * dy];
      const len = Math.hypot(...dir);
      return { origin: eye, dir: [dir[0] / len, dir[1] / len, dir[2] / len] };
    }
    if (plan.kind === 'orthographic') {
      return { origin: [this.centerX + dx, this.centerY + dy, plan.distance], dir: [0, 0, -1] };
    }
    // Perspective: every ray leaves the one eye, so the offset becomes a direction instead of an origin.
    const len = Math.hypot(dx, dy, plan.distance);
    return { origin: [this.centerX, this.centerY, plan.distance], dir: [dx / len, dy / len, -plan.distance / len] };
  }

  /** The view ray through a screen point, intersected with the ground. */
  screenToGround(sx: number, sy: number): Vec2 {
    const { origin, dir } = this.viewRay(sx, sy);
    return rayToGround(origin, dir) ?? { x: origin[0], y: origin[1] };
  }

  pickTile(cfg: MapConfig, sx: number, sy: number): TilePos | undefined {
    return worldToTile(cfg, this.screenToGround(sx, sy));
  }

  /** The whole map in view, centred; the map is centred on the world origin. */
  fitMap(cfg: MapConfig, marginPx = 0): void {
    this.centerX = 0;
    this.centerY = 0;
    if (this.tilt !== null) {
      // The map's corners on the focal plane: a whole map is far out, where the camera is orthographic.
      const { right, up } = tiltBasis(this.tilt);
      const [hx, hy] = [(cfg.width * cfg.tileSize) / 2, (cfg.height * cfg.tileSize) / 2];
      const corners: V3[] = [[-hx, -hy, 0], [hx, -hy, 0], [hx, hy, 0], [-hx, hy, 0]];
      const across = corners.map((c) => dot(c, right));
      const upward = corners.map((c) => dot(c, up));
      this.worldPerPixel = Math.max(
        (Math.max(...across) - Math.min(...across)) / Math.max(this.viewport.width - 2 * marginPx, 1),
        (Math.max(...upward) - Math.min(...upward)) / Math.max(this.viewport.height - 2 * marginPx, 1),
      );
      return;
    }
    this.worldPerPixel = Math.max(
      (cfg.width * cfg.tileSize) / Math.max(this.viewport.width - 2 * marginPx, 1),
      (cfg.height * cfg.tileSize) / Math.max(this.viewport.height - 2 * marginPx, 1),
    );
  }

  /** Drag by screen pixels: the grabbed ground point follows the cursor. */
  panBy(dxPx: number, dyPx: number): void {
    if (this.tilt !== null) {
      // The ground that was at the centre minus the drag comes to the centre.
      const to = this.screenToGround(this.viewport.width / 2 - dxPx, this.viewport.height / 2 - dyPx);
      this.centerX = to.x;
      this.centerY = to.y;
      return;
    }
    const perPixel = this.perPixel();
    this.centerX -= dxPx * perPixel;
    this.centerY += dyPx * perPixel;
  }

  /** Scale the view by `factor` (below 1 zooms in) around a screen point that stays put. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const anchor = this.screenToGround(sx, sy);
    this.worldPerPixel *= factor;
    if (this.tilt !== null) {
      // Moving the focus moves every ground hit by the same amount, so one correction lands the anchor back.
      const after = this.screenToGround(sx, sy);
      this.centerX += anchor.x - after.x;
      this.centerY += anchor.y - after.y;
      return;
    }
    const perPixel = this.perPixel();
    this.centerX = anchor.x - (sx - this.viewport.width / 2) * perPixel;
    this.centerY = anchor.y + (sy - this.viewport.height / 2) * perPixel;
  }

  /** The ground in view as world bounds: the frustum edges straight down, the box round the frame's corners when tilted. */
  bounds(): { left: number; right: number; top: number; bottom: number } {
    if (this.tilt !== null) {
      const { width, height } = this.viewport;
      const hits = [this.screenToGround(0, 0), this.screenToGround(width, 0), this.screenToGround(width, height), this.screenToGround(0, height)];
      const xs = hits.map((h) => h.x);
      const ys = hits.map((h) => h.y);
      return { left: Math.min(...xs), right: Math.max(...xs), top: Math.max(...ys), bottom: Math.min(...ys) };
    }
    const halfW = (this.viewport.width / 2) * this.worldPerPixel;
    const halfH = (this.viewport.height / 2) * this.worldPerPixel;
    return {
      left: this.centerX - halfW,
      right: this.centerX + halfW,
      top: this.centerY + halfH,
      bottom: this.centerY - halfH,
    };
  }
}
