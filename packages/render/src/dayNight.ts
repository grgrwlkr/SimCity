// The day-night lighting cycle from the game clock: port of crates/simcity_sim/src/game/day_night.rs. Purely visual.
// The sun and the ambient dim and cool toward night, windows turn warm-emissive, markings faintly glow, traffic lights
// grow pools on the asphalt and shop signs light up; the scene writes each value into one shared material.
import type { Rgb } from './buildingLook';
import { isDataMap, type OverlayMode } from './overlays';
import type { DayNightVisualConfig, NightConfig, SunConfig } from './renderConfig';
import type { Rgba } from './renderPrimitives';

/** Night factor 0 (noon) .. 1 (midnight), a cosine over the day. `hour` may carry minutes: 6.5 is half past six. */
export function nightFactor(hour: number): number {
  const t = (((hour / 24) % 1) + 1) % 1;
  return 0.5 + 0.5 * Math.cos(t * 2 * Math.PI);
}

/**
 * Sun illuminance and ambient brightness for a daylight fraction, 0 at the deepest night and 1 at noon. The night
 * floors are fractions of the noon anchors; the scale is the sun's alone, the ambient is the sky.
 */
export function lightingLevels(day: number, night: NightConfig, sun: SunConfig): [sun: number, ambient: number] {
  const d = Math.min(Math.max(day, 0), 1);
  const illuminance = sun.dayIlluminance * (night.sunFloor + (1 - night.sunFloor) * d) * Math.max(sun.illuminanceScale, 0);
  const ambient = sun.dayAmbient * (night.ambientFloor + (1 - night.ambientFloor) * d);
  return [illuminance, ambient];
}

/** Daytime colour of a shop sign: a painted board, not a lamp. sRGB. */
export const SIGN_DAY_COLOR: Rgb = [0.62, 0.2, 0.22];
export const WINDOW_GLASS_DAY: Rgb = [0.1, 0.12, 0.17];
export const MARKING_CENTER_COLOR: Rgba = [1, 0.85, 0.1, 0.9];
export const MARKING_WHITE_COLOR: Rgba = [0.98, 0.98, 0.98, 0.55];

/** One shared material's look: base colour sRGB, emissive linear. */
export interface GlowLook {
  readonly baseColor: Rgb | Rgba;
  readonly emissive: Rgb;
}

export interface DayNightLighting {
  /** 0 by day up to 1 at the darkest night. */
  readonly darkness: number;
  readonly sun: { readonly illuminance: number; readonly color: Rgb };
  readonly ambient: { readonly brightness: number; readonly color: Rgb };
  readonly windows: GlowLook;
  readonly markingCenter: GlowLook;
  readonly markingWhite: GlowLook;
  readonly signs: GlowLook;
  readonly lightPool: GlowLook;
}

const scale = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];

/**
 * The whole lighting state at `hour`. A data map is read in daylight: night would darken what the player is reading.
 * `signNightEmissive` is the shop signs' strength after dark, `sign.night_emissive` of props.ron.
 */
export function dayNightLighting(
  hour: number,
  overlay: OverlayMode,
  visual: DayNightVisualConfig,
  render: { readonly sun: SunConfig; readonly night: NightConfig },
  signNightEmissive: number,
): DayNightLighting {
  const litHour = isDataMap(overlay) ? 12 : hour;
  const darkness = Math.min(Math.max(nightFactor(litHour) * (visual.nightDarkness / 0.55), 0), 1);
  const day = 1 - darkness;
  const [illuminance, brightness] = lightingLevels(day, render.night, render.sun);
  const night = darkness;
  const glass = WINDOW_GLASS_DAY;
  const signGlow = signNightEmissive * night;
  return {
    darkness,
    // Bright warm white by day, a dim cool moon at night.
    sun: { illuminance, color: [0.6 + 0.4 * day, 0.68 + 0.3 * day, 1 - 0.08 * day] },
    ambient: { brightness, color: [0.55 + 0.3 * day, 0.62 + 0.28 * day, 1] },
    windows: {
      baseColor: [glass[0] + 0.55 * night * visual.windowGlow, glass[1] + 0.4 * night * visual.windowGlow, glass[2] + 0.13 * night * visual.windowGlow],
      emissive: scale([2.6 * night, 1.7 * night, 0.55 * night], visual.windowGlow),
    },
    // Markings keep the road readable in the dark.
    markingCenter: { baseColor: MARKING_CENTER_COLOR, emissive: scale([0.55 * night, 0.45 * night, 0.05 * night], visual.markingGlow) },
    markingWhite: { baseColor: MARKING_WHITE_COLOR, emissive: scale([0.35 * night, 0.35 * night, 0.38 * night], visual.markingGlow) },
    signs: { baseColor: SIGN_DAY_COLOR, emissive: [signGlow, 0.62 * signGlow, 0.3 * signGlow] },
    // Warm pools under traffic lights fade in after dusk.
    lightPool: {
      baseColor: [1, 0.85, 0.5, Math.min(Math.max(0.35 * night * visual.lightPoolGlow, 0), 1)],
      emissive: scale([0.9 * night, 0.65 * night, 0.25 * night], visual.lightPoolGlow),
    },
  };
}
