// Corner darkening as one stretched alpha texture over the frame: port of crates/simcity_frontend/src/game/vignette.rs.
// A texture generated once costs one quad; a post-processing pass would cost a full-frame read and write.
import { isDataMap, type OverlayMode } from './overlays';
import type { VignetteConfig } from './renderConfig';

/** Side of the ramp texture: stretched over the whole window, it only needs enough samples for a smooth gradient. */
export const VIGNETTE_TEXTURE_SIZE = 128;

/**
 * Darkening at a point of the frame, alpha 0..1, for `u`, `v` in 0..1: flat inside `innerRadius` (a fraction of the
 * half-diagonal) and easing to `strength` at the corners.
 */
export function vignetteAlpha(u: number, v: number, innerRadius: number, strength: number): number {
  const dx = (u - 0.5) * 2;
  const dy = (v - 0.5) * 2;
  // The corner sits at exactly 1.
  const radius = Math.hypot(dx, dy) / Math.SQRT2;
  const inner = Math.min(Math.max(innerRadius, 0), 0.999);
  if (radius <= inner) return 0;
  const t = Math.min(Math.max((radius - inner) / (1 - inner), 0), 1);
  // Smoothstep keeps the transition from banding on a flat sky.
  return t * t * (3 - 2 * t) * Math.min(Math.max(strength, 0), 1);
}

/** The ramp texture, black RGBA8 with the darkening in alpha, rows from the top. */
export function vignetteImage(innerRadius: number, strength: number): { width: number; height: number; data: Uint8Array } {
  const size = VIGNETTE_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      data[(y * size + x) * 4 + 3] = Math.round(vignetteAlpha((x + 0.5) / size, (y + 0.5) / size, innerRadius, strength) * 255);
    }
  }
  return { width: size, height: size, data };
}

/** Whether the vignette is drawn: a data map needs its corners read like its centre. */
export function vignetteVisible(cfg: VignetteConfig, overlay: OverlayMode): boolean {
  return cfg.enabled && cfg.strength > 0 && !isDataMap(overlay);
}
