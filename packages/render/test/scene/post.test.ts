// The scene's post-processing graph follows `renderSettings.ts`: a disabled effect leaves no node in the graph, rather
// than a node run at zero, and the grade the shader samples is the tested `gradeRgb`.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import BloomNode from 'three/addons/tsl/display/BloomNode.js';
import FXAANode from 'three/addons/tsl/display/FXAANode.js';
import GTAONode from 'three/addons/tsl/display/GTAONode.js';
import Lut3DNode from 'three/addons/tsl/display/Lut3DNode.js';
import { RENDER_CONFIG, type RenderConfig } from '../../src/renderConfig';
import { resolveRenderSettings } from '../../src/renderSettings';
import { GRADE_LUT_SIZE, configWithout, effectsOffFromQuery, gradeLutData, gradeRgb, postGraph, vignetteGateFor } from '../../src/scene/post';

type NodeLike = { getChildren(): Iterable<NodeLike> };

/** Every node reachable from `root`, each once. */
function nodesOf(root: NodeLike): Set<NodeLike> {
  const seen = new Set<NodeLike>();
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const c of n.getChildren()) stack.push(c);
  }
  return seen;
}

function graphOf(cfg: RenderConfig) {
  const g = postGraph(new THREE.Scene(), new THREE.PerspectiveCamera(), resolveRenderSettings(cfg), cfg.vignette);
  const nodes = [...nodesOf(g.output as unknown as NodeLike)];
  const has = (k: abstract new (...a: never[]) => unknown) => nodes.some((n) => n instanceof k);
  return { g, has };
}

describe('post-processing graph', () => {
  it('theShippedConfigBuildsAoGradeVignetteAndFxaaWithoutBloom', () => {
    const { g, has } = graphOf(RENDER_CONFIG);
    expect(g.passes).toEqual(['scene', 'ao', 'tonemap', 'grade', 'vignette', 'fxaa']);
    expect(has(GTAONode)).toBe(true);
    expect(has(FXAANode)).toBe(true);
    expect(has(Lut3DNode)).toBe(true);
    expect(has(BloomNode), 'bloom is off in the shipped config').toBe(false);
  });

  it('aDisabledEffectLeavesNoNodeInTheGraph', () => {
    const off: RenderConfig = {
      ...RENDER_CONFIG,
      antiAliasing: 'None',
      ssao: { ...RENDER_CONFIG.ssao, enabled: false },
      vignette: { ...RENDER_CONFIG.vignette, enabled: false },
      colorGrading: { exposure: 0, contrast: 1, saturation: 1, gamma: 1 },
    };
    const { g, has } = graphOf(off);
    expect(g.passes).toEqual(['scene', 'tonemap']);
    for (const k of [GTAONode, FXAANode, Lut3DNode, BloomNode]) expect(has(k), k.name).toBe(false);
  });

  it('bloomJoinsWhenEnabled', () => {
    const { g, has } = graphOf({ ...RENDER_CONFIG, bloom: { ...RENDER_CONFIG.bloom, enabled: true } });
    expect(g.passes).toContain('bloom');
    expect(has(BloomNode)).toBe(true);
  });

  it('theAddressBarTurnsNamedEffectsOff', () => {
    const off = effectsOffFromQuery('?renderer=scene&off=ao,fxaa,nonsense');
    expect([...off].sort()).toEqual(['ao', 'fxaa']);
    const { g, has } = graphOf(configWithout(RENDER_CONFIG, off));
    expect(g.passes).toEqual(['scene', 'tonemap', 'grade', 'vignette']);
    expect(has(GTAONode)).toBe(false);
    expect(configWithout(RENDER_CONFIG, new Set(['shadows'])).shadows.cascades).toBe(0);
    expect(configWithout(RENDER_CONFIG, new Set())).toEqual(RENDER_CONFIG);
  });

  it('theVignetteAndTheGradeAreSampledByTheOutput', () => {
    // The textures themselves must be reachable from the output, not only listed in `passes`.
    const textures = (cfg: RenderConfig) => {
      const g = postGraph(new THREE.Scene(), new THREE.PerspectiveCamera(), resolveRenderSettings(cfg), cfg.vignette);
      return [...nodesOf(g.output as unknown as NodeLike)].map((n) => (n as { value?: { name?: string } }).value?.name).filter((n) => n === 'vignette' || n === 'grade');
    };
    expect(textures(RENDER_CONFIG).sort()).toEqual(['grade', 'vignette']);
    expect(textures({ ...RENDER_CONFIG, vignette: { ...RENDER_CONFIG.vignette, enabled: false } })).toEqual(['grade']);
  });

  it('msaaReachesTheScenePass', () => {
    const cfg: RenderConfig = { ...RENDER_CONFIG, antiAliasing: 'Msaa4', ssao: { ...RENDER_CONFIG.ssao, enabled: false } };
    const { g, has } = graphOf(cfg);
    expect((g.scenePass as unknown as { options: { samples?: number } }).options.samples).toBe(4);
    expect(has(FXAANode)).toBe(false);
  });
});

describe('colour grade', () => {
  it('theIdentityGradeChangesNothing', () => {
    const id = { exposure: 0, contrast: 1, saturation: 1, gamma: 1 };
    for (const c of [
      [0, 0, 0],
      [0.2, 0.5, 0.9],
      [1, 1, 1],
    ] as const) {
      const out = gradeRgb(c, id);
      out.forEach((v, i) => expect(v).toBeCloseTo(c[i]!, 6));
    }
  });

  it('theVignetteHasAGateADataMapClosesWithoutRebuildingTheGraph', () => {
    const { g } = graphOf(RENDER_CONFIG);
    expect(g.vignetteGate, 'the shipped look draws a vignette').not.toBeNull();
    expect(g.vignetteGate!.value).toBe(1);
    expect(nodesOf(g.output as unknown as NodeLike).has(g.vignetteGate as unknown as NodeLike), 'the gate is in the frame').toBe(true);
    expect(vignetteGateFor(RENDER_CONFIG.vignette, 'None')).toBe(1);
    expect(vignetteGateFor(RENDER_CONFIG.vignette, 'LandValue'), 'a data map needs its corners read like its centre').toBe(0);
    expect(vignetteGateFor(RENDER_CONFIG.vignette, 'Path')).toBe(1);
    expect(graphOf(configWithout(RENDER_CONFIG, new Set(['vignette']))).g.vignetteGate, 'no vignette, no gate').toBeNull();
  });

  it('contrastSpreadsAroundMidGreyAndSaturationAwayFromGrey', () => {
    const g = { exposure: 0, contrast: 1.5, saturation: 1, gamma: 1 };
    expect(gradeRgb([0.7, 0.7, 0.7], g)[0]).toBeGreaterThan(0.7);
    expect(gradeRgb([0.3, 0.3, 0.3], g)[0]).toBeLessThan(0.3);
    const grey = gradeRgb([0.4, 0.4, 0.4], { exposure: 0, contrast: 1, saturation: 2, gamma: 1 });
    grey.forEach((v) => expect(v).toBeCloseTo(0.4, 6));
    const red = gradeRgb([0.6, 0.3, 0.3], { exposure: 0, contrast: 1, saturation: 2, gamma: 1 });
    expect(red[0] - red[1]).toBeGreaterThan(0.3);
  });

  it('theLutSamplesTheGradeAtItsGridPoints', () => {
    const g = RENDER_CONFIG.colorGrading;
    const data = gradeLutData(g);
    const n = GRADE_LUT_SIZE;
    expect(data.length).toBe(n * n * n * 4);
    for (const [r, gg, b] of [
      [0, 0, 0],
      [5, 17, 30],
      [n - 1, n - 1, n - 1],
    ] as const) {
      const want = gradeRgb([r / (n - 1), gg / (n - 1), b / (n - 1)], g);
      const o = ((b * n + gg) * n + r) * 4;
      for (let i = 0; i < 3; i++) expect(Math.abs(data[o + i]! - want[i]! * 255)).toBeLessThanOrEqual(0.5);
    }
  });
});
