// The scene's light by the world's clock: the sun, the sky and the night glow of `dayNight.ts` as three.js lights and
// two shared materials — the building windows and the shop signs — written once per hour change, never per object.
// The sun keeps the configured direction all day (as the Rust sun did); its strength and colour follow the clock, and
// it casts the cascaded shadows of `renderSettings.ts`.
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import * as THREE from 'three/webgpu';
import type { Rgb } from '../buildingLook';
import { dayNightLighting, type GlowLook } from '../dayNight';
import type { OverlayMode } from '../overlays';
import { DAY_NIGHT_CONFIG, RENDER_CONFIG, SIGN_NIGHT_EMISSIVE } from '../renderConfig';
import type { CascadeSettings, ResolvedRenderSettings } from '../renderSettings';

/**
 * three.js intensities of the noon sun and sky. The config speaks Bevy's lux and ambient units; the ratios over the day
 * are the config's, and these two anchor noon so the ACES frame reads as bright as R2's flat one did. The sun is low
 * (14° at noon), so it lights walls far more than the ground, and the sky carries the ground.
 */
export const NOON_SUN_INTENSITY = 3;
export const NOON_SKY_INTENSITY = 2;
/** The sky's light from below, as a share of the light from above: walls stay apart from roofs. */
const GROUND_BOUNCE = 0.55;
/** Shadow map side per cascade, texels. */
const SHADOW_MAP_SIZE = 2048;

export interface SceneLightLevels {
  /** 0 by day, 1 at the darkest night. */
  readonly darkness: number;
  readonly sun: { readonly intensity: number; readonly color: Rgb };
  readonly sky: { readonly intensity: number; readonly color: Rgb };
  readonly windows: GlowLook;
  readonly signs: GlowLook;
}

/** The light at `hour` (minutes as a fraction) in three.js terms; a data map is read in daylight. */
export function sceneLightLevels(hour: number, overlay: OverlayMode = 'None'): SceneLightLevels {
  const l = dayNightLighting(hour, overlay, DAY_NIGHT_CONFIG, RENDER_CONFIG, SIGN_NIGHT_EMISSIVE);
  return {
    darkness: l.darkness,
    sun: { intensity: (l.sun.illuminance / RENDER_CONFIG.sun.dayIlluminance) * NOON_SUN_INTENSITY, color: l.sun.color },
    sky: { intensity: (l.ambient.brightness / RENDER_CONFIG.sun.dayAmbient) * NOON_SKY_INTENSITY, color: l.ambient.color },
    windows: l.windows,
    signs: l.signs,
  };
}

/** `?hour=<h>` pins the scene's light to an hour whatever the world's clock says; `null` when absent or not a number. */
export function hourFromQuery(search: string): number | null {
  const raw = new URLSearchParams(search).get('hour');
  if (raw === null || raw.trim() === '') return null;
  const h = Number(raw);
  return Number.isFinite(h) ? ((h % 24) + 24) % 24 : null;
}

/**
 * Far bounds of the cascades as fractions of the maximum distance, what `CSMShadowNode`'s custom split takes: the first
 * ends at the configured first slice, the rest grow geometrically to the maximum, so the near cascade stays sharp.
 */
export function cascadeSplits(c: CascadeSettings): number[] {
  const n = Math.max(Math.round(c.cascades), 1);
  const first = Math.min(Math.max(c.firstCascadeFarBound / c.maximumDistance, 1e-3), 1);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? 1 : n === 1 ? 1 : first * (1 / first) ** (i / (n - 1))));
}

const setSrgb = (color: THREE.Color, [r, g, b]: Rgb | readonly [number, number, number, number]) => color.setRGB(r, g, b, THREE.SRGBColorSpace);

export class SceneLighting {
  readonly group = new THREE.Group();
  readonly sun = new THREE.DirectionalLight(0xffffff, NOON_SUN_INTENSITY);
  readonly sky = new THREE.HemisphereLight(0xffffff, 0xffffff, NOON_SKY_INTENSITY);
  /** Every building's windows: dark glass by day, warm light at night. */
  readonly windows = new THREE.MeshLambertNodeMaterial();
  /** Every shop sign: a painted board by day, lit after dark. */
  readonly signs = new THREE.MeshLambertNodeMaterial();
  private csm: CSMShadowNode | null = null;
  private csmCamera: THREE.Camera | null = null;
  private hour = NaN;
  private overlay: OverlayMode = 'None';

  constructor(private readonly settings: ResolvedRenderSettings) {
    const s = settings.sun;
    this.sun.position.set(...s.position);
    this.sun.target.position.set(...s.target);
    // No cascades configured (or `?off=shadows`): no shadow pass at all.
    this.sun.castShadow = s.cascades.cascades > 0;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.sun.shadow.bias = -0.0005;
    if (s.softShadowSize !== null) this.sun.shadow.radius = s.softShadowSize;
    this.group.add(this.sun, this.sun.target, this.sky);
    for (const m of [this.windows, this.signs]) m.emissiveIntensity = 1;
    this.apply(12);
  }

  /**
   * The cascades follow one camera from their first frame on; the scene swaps cameras where the zoom turns the
   * projection, so the shadow node is rebuilt for the new one (a handful of times per session, not per frame).
   */
  useCamera(camera: THREE.Camera): void {
    if (camera === this.csmCamera || !this.sun.castShadow) return;
    this.csmCamera = camera;
    this.csm?.dispose();
    const c = this.settings.sun.cascades;
    this.csm = new CSMShadowNode(this.sun, {
      cascades: c.cascades,
      maxFar: c.maximumDistance,
      mode: 'custom',
      customSplitsCallback: (_n: number, _near: number, _far: number, breaks: number[]) => breaks.push(...cascadeSplits(c)),
    });
    this.csm.fade = c.overlapProportion > 0;
    this.sun.shadow.shadowNode = this.csm;
  }

  /** Lights and glow materials at `hour`; nothing is written when neither the hour nor the overlay moved. */
  apply(hour: number, overlay: OverlayMode = this.overlay): void {
    if (hour === this.hour && overlay === this.overlay) return;
    this.hour = hour;
    this.overlay = overlay;
    const l = sceneLightLevels(hour, overlay);
    this.sun.intensity = l.sun.intensity;
    setSrgb(this.sun.color, l.sun.color);
    this.sky.intensity = l.sky.intensity;
    setSrgb(this.sky.color, l.sky.color);
    this.sky.groundColor.copy(this.sky.color).multiplyScalar(GROUND_BOUNCE);
    for (const [m, look] of [
      [this.windows, l.windows],
      [this.signs, l.signs],
    ] as const) {
      setSrgb(m.color, look.baseColor);
      m.emissive.setRGB(...look.emissive);
    }
  }
}
