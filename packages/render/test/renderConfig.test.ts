// Not a Rust port. The render knobs are constants, like `defaultTrafficConfig`; these pins hold the values the game
// shipped with (rust-final:assets/config/render.ron, day_night.ron and props.ron) and fail when a value drifts or a
// knob is added without its pin.
import { describe, expect, it } from 'vitest';
import { DAY_NIGHT_CONFIG, RENDER_CONFIG, SIGN_NIGHT_EMISSIVE } from '../src/renderConfig';

describe('render config', () => {
  it('renderConfigPinsTheShippedLook', () => {
    expect(RENDER_CONFIG).toEqual({
      tonemapping: 'AcesFitted',
      antiAliasing: 'Fxaa',
      bloom: { enabled: false, intensity: 0.12, lowFrequencyBoost: 0.7, maxMipDimension: 512 },
      ssao: { enabled: true, quality: 'Medium' },
      colorGrading: { exposure: 0, contrast: 1.08, saturation: 1.05, gamma: 1 },
      vignette: { enabled: true, strength: 0.35, innerRadius: 0.55 },
      sun: { noonElevationDeg: 14, azimuthDeg: 135, illuminanceScale: 1, dayIlluminance: 12000, dayAmbient: 700 },
      night: { sunFloor: 0.3, ambientFloor: 1 },
      perspective: { orthoAboveZoom: 0.25, nearFovDeg: 42, farFovDeg: 12, ramp: 1.6, minDistance: 40, maxDistance: 900, orthoDistance: 500 },
      atlas: { worldUnitsPerCell: 12, maxRepeats: 4 },
      shadows: { maximumDistance: 900, cascades: 4, firstSliceDepth: 90, overlapProportion: 0.2, softSize: 0 },
    });
  });

  it('dayNightConfigPinsTheShippedNight', () => {
    expect(DAY_NIGHT_CONFIG).toEqual({ nightDarkness: 0.55, windowGlow: 1, markingGlow: 1, lightPoolGlow: 1 });
  });

  it('signNightEmissivePinsTheShippedGlow', () => {
    expect(SIGN_NIGHT_EMISSIVE).toBe(2.8);
  });
});
