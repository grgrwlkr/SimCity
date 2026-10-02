// `RENDER_CONFIG` resolved into what the camera, the post-processing chain and the sun get: port of
// crates/simcity_frontend/src/game/render_settings.rs. The config is data; this is the one place that turns it into
// renderer settings, and the scene applies them when the config changes, never per frame.
import { ACESFilmicToneMapping, NeutralToneMapping, NoToneMapping, type ToneMapping } from 'three';
import type { Vec3 } from './picking';
import type { ColorGradingConfig, RenderConfig, SsaoQuality, TonemappingCurve } from './renderConfig';

/** The Three.js tone mapping of a configured curve. Three.js has no TonyMcMapface; PBR Neutral is its neutral, softer-than-ACES curve. */
export function toneMappingOf(curve: TonemappingCurve): ToneMapping {
  switch (curve) {
    case 'None':
      return NoToneMapping;
    case 'AcesFitted':
      return ACESFilmicToneMapping;
    case 'TonyMcMapface':
      return NeutralToneMapping;
  }
}

/** GTAO samples of a configured level: Three.js's default of 16 is `High`, and each level doubles the one below. */
export function aoSamplesOf(quality: SsaoQuality): number {
  switch (quality) {
    case 'Low':
      return 4;
    case 'Medium':
      return 8;
    case 'High':
      return 16;
    case 'Ultra':
      return 32;
  }
}

/**
 * Unit vector from the sun toward the world origin. The world is Z up: azimuth sweeps the XY plane clockwise from
 * +Y, elevation lifts toward +Z, and a low elevation makes long shadows.
 */
export function sunDirection(elevationDeg: number, azimuthDeg: number): Vec3 {
  const elevation = (elevationDeg * Math.PI) / 180;
  const azimuth = (azimuthDeg * Math.PI) / 180;
  const position = [Math.cos(elevation) * Math.sin(azimuth), Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation)] as const;
  const length = Math.hypot(...position);
  return [-position[0] / length, -position[1] / length, -position[2] / length];
}

/** How far out the sun sits, world units: well outside the map, so its cascades cover the city. */
const SUN_DISTANCE = 400;

export interface CascadeSettings {
  readonly cascades: number;
  readonly minimumDistance: number;
  readonly maximumDistance: number;
  readonly firstCascadeFarBound: number;
  readonly overlapProportion: number;
}

export interface ResolvedRenderSettings {
  readonly toneMapping: ToneMapping;
  /** One global grade: the same curve in shadows, midtones and highlights. */
  readonly colorGrading: ColorGradingConfig;
  /** `null` when bloom is off: a disabled effect is left out of the chain, not run at zero. */
  readonly bloom: { readonly intensity: number; readonly lowFrequencyBoost: number; readonly maxMipDimension: number } | null;
  readonly ao: { readonly quality: SsaoQuality; readonly samples: number } | null;
  readonly antiAliasing: { readonly msaaSamples: 0 | 4; readonly fxaa: boolean };
  readonly sun: {
    readonly position: Vec3;
    readonly target: Vec3;
    /** `null` is a hard edge; a zero-width penumbra would still pay for the soft-shadow path. */
    readonly softShadowSize: number | null;
    readonly cascades: CascadeSettings;
  };
}

export function resolveRenderSettings(cfg: RenderConfig): ResolvedRenderSettings {
  // Ambient occlusion cannot run on a multisampled target, so it decides, and the configured method only has a say without it.
  const method = cfg.ssao.enabled && cfg.antiAliasing === 'Msaa4' ? 'Fxaa' : cfg.antiAliasing;
  const direction = sunDirection(cfg.sun.noonElevationDeg, cfg.sun.azimuthDeg);
  return {
    toneMapping: toneMappingOf(cfg.tonemapping),
    colorGrading: { ...cfg.colorGrading },
    bloom: cfg.bloom.enabled
      ? { intensity: cfg.bloom.intensity, lowFrequencyBoost: cfg.bloom.lowFrequencyBoost, maxMipDimension: cfg.bloom.maxMipDimension }
      : null,
    ao: cfg.ssao.enabled ? { quality: cfg.ssao.quality, samples: aoSamplesOf(cfg.ssao.quality) } : null,
    antiAliasing: { msaaSamples: method === 'Msaa4' ? 4 : 0, fxaa: method === 'Fxaa' },
    sun: {
      position: [-direction[0] * SUN_DISTANCE, -direction[1] * SUN_DISTANCE, -direction[2] * SUN_DISTANCE],
      target: [0, 0, 0],
      softShadowSize: cfg.shadows.softSize > 0 ? cfg.shadows.softSize : null,
      cascades: {
        cascades: cfg.shadows.cascades,
        minimumDistance: 0.1,
        maximumDistance: cfg.shadows.maximumDistance,
        firstCascadeFarBound: cfg.shadows.firstSliceDepth,
        overlapProportion: cfg.shadows.overlapProportion,
      },
    },
  };
}
