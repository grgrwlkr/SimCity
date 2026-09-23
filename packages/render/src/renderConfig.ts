// Look-and-feel knobs of the renderer: `RenderConfig` of crates/simcity_core/src/game/render_config.rs,
// `DayNightVisualConfig` and the shop sign's night emissive, as constants; renderConfig.test.ts pins them. The values
// are those the game shipped with (rust-final:assets/config/render.ron, day_night.ron, props.ron); where they differ
// from the Rust code defaults, the shipped value wins.

/** Tone mapping curve of the camera. */
export type TonemappingCurve = 'None' | 'AcesFitted' | 'TonyMcMapface';
export const SSAO_QUALITIES = ['Low', 'Medium', 'High', 'Ultra'] as const;
export type SsaoQuality = (typeof SSAO_QUALITIES)[number];
/** SSAO cannot run with MSAA, so an enabled SSAO turns `Msaa4` into `Fxaa`. */
export type AntiAliasing = 'None' | 'Msaa4' | 'Fxaa';

export interface BloomConfig {
  readonly enabled: boolean;
  /** Blend of the bloom texture into the frame. */
  readonly intensity: number;
  /** Pulls the glow toward broad, soft light instead of tight halos. */
  readonly lowFrequencyBoost: number;
  /** Largest dimension of the bloom mip chain, pixels. */
  readonly maxMipDimension: number;
}

export interface SsaoConfig {
  readonly enabled: boolean;
  readonly quality: SsaoQuality;
}

export interface ColorGradingConfig {
  /** Stops of exposure compensation. */
  readonly exposure: number;
  readonly contrast: number;
  readonly saturation: number;
  readonly gamma: number;
}

export interface VignetteConfig {
  readonly enabled: boolean;
  /** Opacity of the darkening at the very corners, 0..1. */
  readonly strength: number;
  /** Fraction of the half-diagonal that stays untouched. */
  readonly innerRadius: number;
}

export interface SunConfig {
  /** Height above the horizon at midday, degrees: a low sun casts long shadows. */
  readonly noonElevationDeg: number;
  /** Compass direction the light comes from, degrees; 0 is north (+Y). */
  readonly azimuthDeg: number;
  /** Multiplier on the sun's day-night curve; the ambient is the sky's and does not follow it. */
  readonly illuminanceScale: number;
  /** Sun illuminance at noon, lux; the night floor is a fraction of it. */
  readonly dayIlluminance: number;
  /** Ambient brightness at noon; the night floor is a fraction of it. */
  readonly dayAmbient: number;
}

/** How dark the deepest night gets, as fractions of the noon values. */
export interface NightConfig {
  readonly sunFloor: number;
  readonly ambientFloor: number;
}

/** Where the camera turns orthographic and how strong the perspective is below that. */
export interface PerspectiveConfig {
  /** Zoom at and above which the camera is orthographic. */
  readonly orthoAboveZoom: number;
  /** Vertical field of view at the closest zoom, degrees. */
  readonly nearFovDeg: number;
  /** Field of view aimed for at the threshold, degrees. */
  readonly farFovDeg: number;
  /** Exponent on the 0..1 ramp between the two: above 1 keeps the wide view longer. */
  readonly ramp: number;
  readonly minDistance: number;
  /** Past this the shadow cascades stop covering the city. */
  readonly maxDistance: number;
  /** Boom length of the orthographic camera: the clip planes and cascades are tuned for it. */
  readonly orthoDistance: number;
}

export interface ShadowConfig {
  /** Far edge of the last cascade, world units. */
  readonly maximumDistance: number;
  readonly cascades: number;
  /** Near edge of the first cascade, world units. */
  readonly firstSliceDepth: number;
  /** Overlap between neighbouring cascades, 0..1. */
  readonly overlapProportion: number;
  /** Angular size of the light, degrees; 0 is a hard shadow edge. */
  readonly softSize: number;
}

/** How densely the atlas is laid over building surfaces. */
export interface AtlasConfig {
  /** World units one repeat of a cell covers. */
  readonly worldUnitsPerCell: number;
  /** Upper bound on repeats along one edge of a face. */
  readonly maxRepeats: number;
}

export interface RenderConfig {
  readonly tonemapping: TonemappingCurve;
  readonly antiAliasing: AntiAliasing;
  readonly bloom: BloomConfig;
  readonly ssao: SsaoConfig;
  readonly colorGrading: ColorGradingConfig;
  readonly vignette: VignetteConfig;
  readonly sun: SunConfig;
  readonly night: NightConfig;
  readonly perspective: PerspectiveConfig;
  readonly shadows: ShadowConfig;
  readonly atlas: AtlasConfig;
}

/** The shipped look; the reasons behind each value are the comments of rust-final:assets/config/render.ron. */
export const RENDER_CONFIG: RenderConfig = {
  tonemapping: 'AcesFitted',
  antiAliasing: 'Fxaa',
  bloom: { enabled: false, intensity: 0.12, lowFrequencyBoost: 0.7, maxMipDimension: 512 },
  ssao: { enabled: true, quality: 'Medium' },
  colorGrading: { exposure: 0, contrast: 1.08, saturation: 1.05, gamma: 1 },
  vignette: { enabled: true, strength: 0.35, innerRadius: 0.55 },
  sun: { noonElevationDeg: 14, azimuthDeg: 135, illuminanceScale: 1, dayIlluminance: 12000, dayAmbient: 700 },
  night: { sunFloor: 0.3, ambientFloor: 1 },
  perspective: {
    orthoAboveZoom: 0.25,
    nearFovDeg: 42,
    farFovDeg: 12,
    ramp: 1.6,
    minDistance: 40,
    maxDistance: 900,
    orthoDistance: 500,
  },
  // Off by default (render.ron had 4 cascades): every cascade redraws all building instances, and on the fitted
  // metropolis that took the scene from 60 to 23 fps on the GPU (docs/oracle-deviations.md, 2026-09-23). Set a count to
  // bring them back; the other values are the ones they would use.
  shadows: { maximumDistance: 900, cascades: 0, firstSliceDepth: 90, overlapProportion: 0.2, softSize: 0 },
  atlas: { worldUnitsPerCell: 12, maxRepeats: 4 },
};

/** The night look beyond the sun and ambient levels. */
export interface DayNightVisualConfig {
  /** How dark the deepest night gets, 0..1; 0.55 is the reference curve. */
  readonly nightDarkness: number;
  /** Multiplier on the building windows' night emissive. */
  readonly windowGlow: number;
  /** Multiplier on the road markings' night emissive. */
  readonly markingGlow: number;
  /** Multiplier on the traffic-light pools' night emissive. */
  readonly lightPoolGlow: number;
}

/** The shipped night (rust-final:assets/config/day_night.ron). */
export const DAY_NIGHT_CONFIG: DayNightVisualConfig = { nightDarkness: 0.55, windowGlow: 1, markingGlow: 1, lightPoolGlow: 1 };

/** `PROPS_CONFIG.sign.nightEmissive` for the night materials: 5.0 blew the boards out to white bars under ACES. */
export const SIGN_NIGHT_EMISSIVE = 2.8;
