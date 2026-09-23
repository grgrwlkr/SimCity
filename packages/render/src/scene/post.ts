// The scene's post-processing, built from `renderSettings.ts` as one node graph: the scene pass (multisampled when the
// config asks for MSAA), ambient occlusion, bloom, tone mapping, the colour grade, the vignette and FXAA, in that order.
// A disabled effect is left out of the graph, not run at zero. Separate render passes are only the scene, GTAO, bloom
// and FXAA; tone mapping, the grade and the vignette fold into the output shader. Exposure is the renderer's
// `toneMappingExposure`, read by the tone mapping. Colour grading happens after tone mapping, on display values, through
// a 3D table sampled from `gradeRgb`, so the shader carries no second copy of the maths the tests pin.
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import type GTAONode from 'three/addons/tsl/display/GTAONode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { lut3D } from 'three/addons/tsl/display/Lut3DNode.js';
import { float, mrt, normalView, output, pass, renderOutput, screenUV, texture, texture3D, vec3, vec4 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { ColorGradingConfig, RenderConfig, VignetteConfig } from '../renderConfig';
import type { ResolvedRenderSettings } from '../renderSettings';
import { vignetteImage } from '../vignette';

export type PostPassName = 'scene' | 'ao' | 'bloom' | 'tonemap' | 'grade' | 'vignette' | 'fxaa';

/** Effects `?off=` can turn off, for a measurement or a side-by-side. */
export const OPTIONAL_EFFECTS = ['ao', 'bloom', 'fxaa', 'grade', 'vignette', 'shadows'] as const;
export type OptionalEffect = (typeof OPTIONAL_EFFECTS)[number];

/** `?off=ao,shadows`: the named effects, unknown names dropped. */
export function effectsOffFromQuery(search: string): Set<OptionalEffect> {
  const names = (new URLSearchParams(search).get('off') ?? '').split(',').map((n) => n.trim());
  return new Set(OPTIONAL_EFFECTS.filter((e) => names.includes(e)));
}

/** `cfg` with the effects of `off` disabled the way the config itself disables them. */
export function configWithout(cfg: RenderConfig, off: ReadonlySet<OptionalEffect>): RenderConfig {
  return {
    ...cfg,
    ssao: off.has('ao') ? { ...cfg.ssao, enabled: false } : cfg.ssao,
    bloom: off.has('bloom') ? { ...cfg.bloom, enabled: false } : cfg.bloom,
    antiAliasing: off.has('fxaa') && cfg.antiAliasing === 'Fxaa' ? 'None' : cfg.antiAliasing,
    colorGrading: off.has('grade') ? { ...cfg.colorGrading, contrast: 1, saturation: 1, gamma: 1 } : cfg.colorGrading,
    vignette: off.has('vignette') ? { ...cfg.vignette, enabled: false } : cfg.vignette,
    shadows: off.has('shadows') ? { ...cfg.shadows, cascades: 0 } : cfg.shadows,
  };
}

/** Side of the grade table: 32³ is smooth for a gentle grade and 128 kB. */
export const GRADE_LUT_SIZE = 32;
/**
 * Linear brightness above which bloom picks light up. The Rust bloom had no threshold (energy-conserving); here only
 * what outshines white — the lit windows and signs at night — should glow, not every sunlit roof.
 */
const BLOOM_THRESHOLD = 0.9;
/** GTAO at half resolution: occlusion is soft, and the full-size pass doubles the cost for no visible gain. */
const AO_RESOLUTION = 0.5;
/**
 * GTAO's reach and depth tolerance in world units. three's defaults (0.25 and 1) suit a metre-scale scene; a tile here is
 * 16 units, and at those values a flat street seen at a slant bands into stripes of false occlusion.
 */
const AO_RADIUS = 4;
const AO_THICKNESS = 4;

/** Rec. 709 luma: what saturation spreads colour away from. */
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * The grade of one display colour, 0..1: saturation away from its luma, contrast about mid-grey, then gamma as a power
 * (above 1 darkens, as Bevy's). Exposure is not here: it scales light before tone mapping.
 */
export function gradeRgb([r, g, b]: readonly [number, number, number], cfg: ColorGradingConfig): [number, number, number] {
  const l = luma(r, g, b);
  return [r, g, b].map((c) => {
    const saturated = l + (c - l) * cfg.saturation;
    const contrasted = (saturated - 0.5) * cfg.contrast + 0.5;
    return Math.min(Math.max(Math.max(contrasted, 0) ** cfg.gamma, 0), 1);
  }) as [number, number, number];
}

export function gradeIsIdentity(cfg: ColorGradingConfig): boolean {
  return cfg.contrast === 1 && cfg.saturation === 1 && cfg.gamma === 1;
}

/** RGBA8 table, red fastest, then green, then blue: `gradeRgb` at every grid point. */
export function gradeLutData(cfg: ColorGradingConfig, n = GRADE_LUT_SIZE): Uint8Array {
  const data = new Uint8Array(n * n * n * 4);
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const o = ((b * n + g) * n + r) * 4;
        const [x, y, z] = gradeRgb([r / (n - 1), g / (n - 1), b / (n - 1)], cfg);
        data.set([Math.round(x * 255), Math.round(y * 255), Math.round(z * 255), 255], o);
      }
    }
  }
  return data;
}

/** `renderer.toneMappingExposure` for the configured stops. */
export function exposureOf(cfg: ColorGradingConfig): number {
  return 2 ** cfg.exposure;
}

function gradeTexture(cfg: ColorGradingConfig): THREE.Data3DTexture {
  const n = GRADE_LUT_SIZE;
  const tex = new THREE.Data3DTexture(gradeLutData(cfg), n, n, n);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  // Display values in, display values out: no conversion on the way.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function vignetteTexture(cfg: VignetteConfig): THREE.DataTexture {
  const img = vignetteImage(cfg.innerRadius, cfg.strength);
  const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export interface PostGraph {
  /** What `RenderPipeline.outputNode` takes; the pipeline's own output transform stays off, the graph does it. */
  readonly output: THREE.Node<'vec4'>;
  /** The effects in the graph, in order. */
  readonly passes: readonly PostPassName[];
  readonly scenePass: ReturnType<typeof pass>;
  readonly ao: GTAONode | null;
}

/** The effect nodes are typed as plain `TempNode`s; each outputs the frame's vec4. */
const asColor = (node: unknown) => node as THREE.Node<'vec4'>;

export function postGraph(scene: THREE.Scene, camera: THREE.Camera, s: ResolvedRenderSettings, vignette: VignetteConfig): PostGraph {
  const passes: PostPassName[] = ['scene'];
  const scenePass = pass(scene, camera, { samples: s.antiAliasing.msaaSamples });
  let color: THREE.Node<'vec4'> = scenePass.getTextureNode('output');
  let aoPass: GTAONode | null = null;
  if (s.ao !== null) {
    scenePass.setMRT(mrt({ output, normal: normalView }));
    aoPass = ao(scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), camera);
    aoPass.samples.value = s.ao.samples;
    aoPass.resolutionScale = AO_RESOLUTION;
    aoPass.radius.value = AO_RADIUS;
    aoPass.thickness.value = AO_THICKNESS;
    color = color.mul(vec4(vec3(aoPass.getTextureNode().r), 1));
    passes.push('ao');
  }
  if (s.bloom !== null) {
    color = color.add(bloom(color, s.bloom.intensity, s.bloom.lowFrequencyBoost, BLOOM_THRESHOLD));
    passes.push('bloom');
  }
  let out: THREE.Node<'vec4'> = renderOutput(color, s.toneMapping, THREE.SRGBColorSpace);
  passes.push('tonemap');
  if (!gradeIsIdentity(s.colorGrading)) {
    out = asColor(lut3D(out, texture3D(gradeTexture(s.colorGrading)), GRADE_LUT_SIZE, float(1)));
    passes.push('grade');
  }
  if (vignette.enabled && vignette.strength > 0) {
    out = vec4(out.rgb.mul(texture(vignetteTexture(vignette), screenUV).a.oneMinus()), out.a);
    passes.push('vignette');
  }
  if (s.antiAliasing.fxaa) {
    out = asColor(fxaa(out));
    passes.push('fxaa');
  }
  return { output: out, passes, scenePass, ao: aoPass };
}
