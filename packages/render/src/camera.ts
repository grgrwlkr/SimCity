// The debug view: a camera straight above the ground, north up and east right. The zoom picks the projection —
// perspective close up, orthographic far out — through `projectionPlan`, and both sides frame the same ground
// height, so only the shape of the view ray differs. Screen coordinates are CSS pixels from the top-left corner
// of the canvas. The class keeps its name: every call site outside this package still holds an `OrthoView`.
import { worldToTile, type MapConfig, type TilePos, type Vec2 } from '@simcity/sim';
import { projectionPlan, type ProjectionPlan } from './cameraProjection';
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

export class OrthoView {
  /** World point at the centre of the viewport. */
  centerX = 0;
  centerY = 0;
  /** World units per CSS pixel: larger is further out. */
  worldPerPixel = 1;
  /** Where the zoom turns the camera orthographic and how strong the perspective is below that. */
  perspective: PerspectiveConfig = RENDER_CONFIG.perspective;

  constructor(public viewport: Viewport) {}

  /** The projection this zoom asks for; the ground height in view is the same on both sides of the switch. */
  plan(): ProjectionPlan {
    return projectionPlan(this.worldPerPixel, Math.max(this.viewport.height, 1), this.perspective);
  }

  groundToScreen(x: number, y: number): Vec2 {
    return {
      x: this.viewport.width / 2 + (x - this.centerX) / this.worldPerPixel,
      y: this.viewport.height / 2 - (y - this.centerY) / this.worldPerPixel,
    };
  }

  /**
   * The ray a screen point casts, built from the camera's own parameters rather than from the zoom:
   * the counterpart of `Camera::viewport_to_world`, and the only part of picking the projection changes.
   */
  viewRay(sx: number, sy: number): ViewRay {
    const plan = this.plan();
    const height = Math.max(this.viewport.height, 1);
    // Ground covered by one pixel at the focus, read off the frustum the camera is given. Pixels are square, so
    // the horizontal side needs no aspect of its own; orthographic gives back `worldPerPixel` unchanged.
    const perPixel =
      plan.kind === 'orthographic' ? plan.scale : (2 * plan.distance * Math.tan(plan.fovYRad / 2)) / height;
    const dx = (sx - this.viewport.width / 2) * perPixel;
    const dy = (this.viewport.height / 2 - sy) * perPixel;
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
    this.worldPerPixel = Math.max(
      (cfg.width * cfg.tileSize) / Math.max(this.viewport.width - 2 * marginPx, 1),
      (cfg.height * cfg.tileSize) / Math.max(this.viewport.height - 2 * marginPx, 1),
    );
  }

  /** Drag by screen pixels: the grabbed ground point follows the cursor. */
  panBy(dxPx: number, dyPx: number): void {
    this.centerX -= dxPx * this.worldPerPixel;
    this.centerY += dyPx * this.worldPerPixel;
  }

  /** Scale the view by `factor` (below 1 zooms in) around a screen point that stays put. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const anchor = this.screenToGround(sx, sy);
    this.worldPerPixel *= factor;
    this.centerX = anchor.x - (sx - this.viewport.width / 2) * this.worldPerPixel;
    this.centerY = anchor.y + (sy - this.viewport.height / 2) * this.worldPerPixel;
  }

  /** Frustum edges in world units for a Three.js orthographic camera. */
  bounds(): { left: number; right: number; top: number; bottom: number } {
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
