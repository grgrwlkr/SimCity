// Port of crates/simcity_frontend/src/game/render_settings.rs (mod tests): `RENDER_CONFIG` resolved into what the camera,
// the post-processing and the sun get. The Bevy tests ran `apply_render_config` on an App; here the resolution is a value.
import { ACESFilmicToneMapping, NeutralToneMapping, NoToneMapping, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { RENDER_CONFIG, SSAO_QUALITIES, type RenderConfig } from '../src/renderConfig';
import type { Vec3 } from '../src/picking';
import { aoSamplesOf, resolveRenderSettings, sunDirection, toneMappingOf } from '../src/renderSettings';

const closeVec = (a: Vec3, b: Vec3, eps: number) => a.every((v, i) => Math.abs(v - b[i]!) <= eps);

describe('render settings', () => {
  it('tonemappingMapsEveryConfiguredCurve', () => {
    expect(toneMappingOf('None')).toBe(NoToneMapping);
    expect(toneMappingOf('AcesFitted')).toBe(ACESFilmicToneMapping);
    // Three.js has no TonyMcMapface; Khronos PBR Neutral is the "neutral, less contrasty than ACES" curve the config asks for.
    expect(toneMappingOf('TonyMcMapface')).toBe(NeutralToneMapping);
  });

  it('ssaoQualityMapsEveryConfiguredLevel', () => {
    const samples = SSAO_QUALITIES.map(aoSamplesOf);
    expect(new Set(samples).size, 'each level is a level of its own').toBe(SSAO_QUALITIES.length);
    for (let i = 1; i < samples.length; i++) expect(samples[i]!, `${SSAO_QUALITIES[i]} costs more than ${SSAO_QUALITIES[i - 1]}`).toBeGreaterThan(samples[i - 1]!);
  });

  it('configReachesTheCameraAndTheSun', () => {
    // `RENDER_CONFIG` keeps bloom off on measurement; switched on here so its values have somewhere to go.
    const cfg: RenderConfig = { ...RENDER_CONFIG, bloom: { ...RENDER_CONFIG.bloom, enabled: true } };
    const s = resolveRenderSettings(cfg);

    expect(s.toneMapping).toBe(ACESFilmicToneMapping);
    expect(s.bloom, 'bloom should be enabled').not.toBeNull();
    expect(Math.abs(s.bloom!.intensity - cfg.bloom.intensity)).toBeLessThan(1e-6);
    expect(s.bloom!.maxMipDimension).toBe(cfg.bloom.maxMipDimension);
    expect(s.ao, 'ssao should be enabled').not.toBeNull();
    expect(s.ao!.quality).toBe('Medium');
    expect(s.ao!.samples).toBe(aoSamplesOf('Medium'));
    expect(s.colorGrading.exposure).toBe(cfg.colorGrading.exposure);
    expect(s.colorGrading.contrast).toBe(cfg.colorGrading.contrast);
    expect(s.colorGrading.saturation).toBe(cfg.colorGrading.saturation);

    const expected = sunDirection(cfg.sun.noonElevationDeg, cfg.sun.azimuthDeg);
    const toTarget = new Vector3(...s.sun.target).sub(new Vector3(...s.sun.position)).normalize();
    expect(closeVec([toTarget.x, toTarget.y, toTarget.z], expected, 1e-4), `sun should face ${expected}, faces ${toTarget.toArray()}`).toBe(true);
    expect(s.sun.cascades, 'cascades must be rebuilt from the config').toEqual({
      cascades: cfg.shadows.cascades,
      minimumDistance: 0.1,
      maximumDistance: cfg.shadows.maximumDistance,
      firstCascadeFarBound: cfg.shadows.firstSliceDepth,
      overlapProportion: cfg.shadows.overlapProportion,
    });

    expect(resolveRenderSettings(RENDER_CONFIG).bloom, 'RENDER_CONFIG as shipped has no bloom').toBeNull();
  });

  it('softShadowSizeReachesTheSunAndZeroMeansHardEdges', () => {
    const soft = resolveRenderSettings({ ...RENDER_CONFIG, shadows: { ...RENDER_CONFIG.shadows, softSize: 2.5 } });
    expect(soft.sun.softShadowSize).toBe(2.5);
    const hard = resolveRenderSettings({ ...RENDER_CONFIG, shadows: { ...RENDER_CONFIG.shadows, softSize: 0 } });
    expect(hard.sun.softShadowSize, 'zero must mean hard shadows, not a zero-width penumbra').toBeNull();
  });

  /** SSAO cannot run on a multisampled target, so a file asking for both resolves to SSAO and FXAA. */
  it('ssaoForcesMsaaOffAndFallsBackToFxaa', () => {
    const s = resolveRenderSettings({ ...RENDER_CONFIG, ssao: { ...RENDER_CONFIG.ssao, enabled: true }, antiAliasing: 'Msaa4' });
    expect(s.antiAliasing.msaaSamples).toBe(0);
    expect(s.antiAliasing.fxaa, 'edges still need anti-aliasing once MSAA is gone').toBe(true);
  });

  it('msaaSurvivesWhenSsaoIsOff', () => {
    const s = resolveRenderSettings({ ...RENDER_CONFIG, ssao: { ...RENDER_CONFIG.ssao, enabled: false }, antiAliasing: 'Msaa4' });
    expect(s.antiAliasing.msaaSamples).toBe(4);
    expect(s.antiAliasing.fxaa).toBe(false);
  });

  it('disabledEffectsAreRemovedNotMerelyIgnored', () => {
    const s = resolveRenderSettings({
      ...RENDER_CONFIG,
      bloom: { ...RENDER_CONFIG.bloom, enabled: false },
      ssao: { ...RENDER_CONFIG.ssao, enabled: false },
    });
    expect(s.bloom).toBeNull();
    expect(s.ao).toBeNull();
  });

  it('sunDirectionPointsDownFromOverheadAndSidewaysFromTheHorizon', () => {
    // Straight overhead: the light travels straight down.
    const overhead = sunDirection(90, 0);
    expect(closeVec(overhead, [0, 0, -1], 1e-5), `overhead sun should point down, got ${overhead}`).toBe(true);
    // On the horizon due north (+Y): the light travels toward −Y, flat.
    const horizon = sunDirection(0, 0);
    expect(closeVec(horizon, [0, -1, 0], 1e-5), `horizon sun should point sideways, got ${horizon}`).toBe(true);
    // A low sun stays mostly horizontal: that is what makes shadows long.
    const low = sunDirection(15, 135);
    expect(Math.abs(Math.hypot(...low) - 1), 'direction must be a unit vector').toBeLessThan(1e-6);
    expect(low[2] < -0.2 && low[2] > -0.3, `15 degrees of elevation should tilt the light only slightly, got z=${low[2]}`).toBe(true);
  });
});
