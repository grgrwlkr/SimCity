// The debug view: an orthographic camera straight above the ground, north up and east right.
// Screen coordinates are CSS pixels from the top-left corner of the canvas.
import { worldToTile, type MapConfig, type TilePos, type Vec2 } from '@simcity/sim';
import { rayGroundT } from './picking';

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Height of the camera above the ground; any positive value gives the same top-down picture. */
const CAMERA_HEIGHT = 1000;

export class OrthoView {
  /** World point at the centre of the viewport. */
  centerX = 0;
  centerY = 0;
  /** World units per CSS pixel: larger is further out. */
  worldPerPixel = 1;

  constructor(public viewport: Viewport) {}

  groundToScreen(x: number, y: number): Vec2 {
    return {
      x: this.viewport.width / 2 + (x - this.centerX) / this.worldPerPixel,
      y: this.viewport.height / 2 - (y - this.centerY) / this.worldPerPixel,
    };
  }

  /** The view ray through a screen point, intersected with the ground. */
  screenToGround(sx: number, sy: number): Vec2 {
    const origin = [
      this.centerX + (sx - this.viewport.width / 2) * this.worldPerPixel,
      this.centerY - (sy - this.viewport.height / 2) * this.worldPerPixel,
      CAMERA_HEIGHT,
    ] as const;
    const dir = [0, 0, -1] as const;
    const t = rayGroundT(origin, dir) ?? 0;
    return { x: origin[0] + dir[0] * t, y: origin[1] + dir[1] * t };
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
