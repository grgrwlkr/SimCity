// Port of crates/simcity_frontend/src/game/vignette.rs (mod tests): corner darkening as one stretched alpha texture.
import { describe, expect, it } from 'vitest';
import { RENDER_CONFIG } from '../src/renderConfig';
import { VIGNETTE_TEXTURE_SIZE, vignetteAlpha, vignetteImage, vignetteVisible } from '../src/vignette';

describe('vignette', () => {
  it('vignetteIsClearInTheMiddleAndDarkestInTheCorners', () => {
    const [inner, strength] = [0.55, 0.35];
    expect(vignetteAlpha(0.5, 0.5, inner, strength)).toBe(0);
    // Well inside the clear radius.
    expect(vignetteAlpha(0.6, 0.5, inner, strength)).toBe(0);

    const corner = vignetteAlpha(1, 1, inner, strength);
    expect(Math.abs(corner - strength), `the corner should reach full strength, got ${corner}`).toBeLessThan(1e-3);

    // Monotone from centre to corner.
    const mid = vignetteAlpha(0.9, 0.9, inner, strength);
    expect(mid > 0 && mid < corner, `got ${mid} against ${corner}`).toBe(true);
  });

  it('vignetteStrengthZeroIsFullyTransparent', () => {
    for (const [u, v] of [
      [0, 0],
      [0.5, 0.5],
      [1, 1],
    ] as const) {
      expect(vignetteAlpha(u, v, 0.55, 0)).toBe(0);
    }
  });

  it('vignetteImageHasATransparentCentreAndOpaqueCorner', () => {
    const image = vignetteImage(0.55, 1);
    const size = VIGNETTE_TEXTURE_SIZE;
    const alphaAt = (x: number, y: number) => image.data[(y * size + x) * 4 + 3]!;
    expect(image.data.length).toBe(size * size * 4);
    expect(alphaAt(size / 2, size / 2)).toBe(0);
    expect(alphaAt(0, 0), `corner alpha was ${alphaAt(0, 0)}`).toBeGreaterThan(200);
  });

  it('vignetteStepsAsideWhileADataMapIsOn', () => {
    expect(vignetteVisible(RENDER_CONFIG.vignette, 'Pollution'), 'the corners of a data map must read like its centre').toBe(false);
    expect(vignetteVisible(RENDER_CONFIG.vignette, 'None'), 'the look comes back with the plain map').toBe(true);
    expect(vignetteVisible({ ...RENDER_CONFIG.vignette, enabled: false }, 'None'), 'a disabled vignette stays off').toBe(false);
    expect(vignetteVisible({ ...RENDER_CONFIG.vignette, strength: 0 }, 'None'), 'a vignette of no strength is not drawn').toBe(false);
  });
});
