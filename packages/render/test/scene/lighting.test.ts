// The scene's light by the world's clock: the sun and sky of `dayNight.ts` turned into three.js lights, and the shared
// window and sign materials that glow after dark (the checks of `night_glow_follows_the_clock` in
// crates/simcity_sim/src/game/day_night.rs, tag rust-final, made on the scene's own materials).
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { OrthoView, SCENE_TILT } from '../../src/camera';
import { orthographicFrustum, perspectiveFovDeg } from '../../src/cameraProjection';
import { RENDER_CONFIG } from '../../src/renderConfig';
import { resolveRenderSettings } from '../../src/renderSettings';
import { SceneLighting, cascadeSplits, hourFromQuery, sceneLightLevels } from '../../src/scene/lighting';

const brightest = (c: { r: number; g: number; b: number }) => Math.max(c.r, c.g, c.b);

describe('scene lighting', () => {
  it('noonIsBrighterThanMidnightAndMidnightStaysReadable', () => {
    const noon = sceneLightLevels(12);
    const midnight = sceneLightLevels(0);
    expect(noon.sun.intensity).toBeGreaterThan(midnight.sun.intensity * 2);
    // A new game opens at 00:00: the moon and the sky keep the city in view.
    expect(midnight.sun.intensity).toBeGreaterThan(0);
    expect(midnight.sky.intensity).toBeGreaterThan(0.5);
    expect(midnight.darkness).toBe(1);
    expect(noon.darkness).toBe(0);
  });

  it('windowsGlowAtMidnightAndAreDarkGlassAtNoon', () => {
    const lighting = new SceneLighting(resolveRenderSettings(RENDER_CONFIG));
    lighting.apply(0);
    expect(brightest(lighting.windows.emissive) * lighting.windows.emissiveIntensity, 'windows glow at midnight').toBeGreaterThan(1);
    expect(brightest(lighting.signs.emissive) * lighting.signs.emissiveIntensity, 'signs light up at midnight').toBeGreaterThan(1);
    expect(lighting.litHour, 'the hour the light is drawn at').toBe(0);
    const midnightSun = lighting.sun.intensity;
    lighting.apply(12);
    expect(brightest(lighting.windows.emissive) * lighting.windows.emissiveIntensity, 'windows dark glass at noon').toBeLessThan(0.01);
    expect(brightest(lighting.signs.emissive) * lighting.signs.emissiveIntensity).toBeLessThan(0.01);
    expect(lighting.sun.intensity).toBeGreaterThan(midnightSun);
  });

  it('theSunComesFromTheConfiguredDirectionAndCastsShadowsOnlyWithCascades', () => {
    const lighting = new SceneLighting(resolveRenderSettings(RENDER_CONFIG));
    expect(lighting.sun.castShadow, 'the shipped config casts shadows').toBe(true);
    const none = resolveRenderSettings({ ...RENDER_CONFIG, shadows: { ...RENDER_CONFIG.shadows, cascades: 0 } });
    expect(new SceneLighting(none).sun.castShadow, 'no cascades, no shadow pass').toBe(false);
    const settings = resolveRenderSettings(RENDER_CONFIG);
    const d = lighting.sun.position.clone().sub(lighting.sun.target.position).normalize();
    const want = settings.sun.position;
    const len = Math.hypot(...want);
    expect(d.x).toBeCloseTo(want[0] / len, 5);
    expect(d.y).toBeCloseTo(want[1] / len, 5);
    expect(d.z).toBeCloseTo(want[2] / len, 5);
  });

  it('cascadesStartAtTheFirstSliceAndReachTheMaximumDistance', () => {
    const { cascades } = resolveRenderSettings({ ...RENDER_CONFIG, shadows: { ...RENDER_CONFIG.shadows, cascades: 4 } }).sun;
    const splits = cascadeSplits(cascades);
    expect(splits).toHaveLength(cascades.cascades);
    expect(splits[0]).toBeCloseTo(cascades.firstCascadeFarBound / cascades.maximumDistance);
    expect(splits.at(-1)).toBe(1);
    for (let i = 1; i < splits.length; i++) expect(splits[i]!).toBeGreaterThan(splits[i - 1]!);
  });

  it('aDataMapIsLitAtNoonWhateverTheClockSays', () => {
    const lighting = new SceneLighting(resolveRenderSettings(RENDER_CONFIG));
    lighting.apply(12);
    const noon = lighting.sun.intensity;
    lighting.apply(0);
    const midnight = lighting.sun.intensity;
    expect(midnight).toBeLessThan(noon / 2);
    lighting.apply(0, 'LandValue');
    expect(lighting.sun.intensity, 'a data map is read in daylight').toBe(noon);
    expect(lighting.overlayShown).toBe('LandValue');
    lighting.apply(0, 'Path');
    expect(lighting.sun.intensity, 'the path view is not a data map').toBe(midnight);
  });

  it('theHourCanBePinnedFromTheAddressBar', () => {
    expect(hourFromQuery('?renderer=scene&hour=12')).toBe(12);
    expect(hourFromQuery('?hour=0')).toBe(0);
    expect(hourFromQuery('?hour=25.5')).toBe(1.5);
    expect(hourFromQuery('?hour=noon')).toBeNull();
    expect(hourFromQuery('?renderer=scene')).toBeNull();
  });

  /** The scene's camera for a view, set up as `SceneRenderer.frameCamera` does. */
  function sceneCamera(worldPerPixel: number): THREE.Camera {
    const view = new OrthoView({ width: 640, height: 480 });
    view.tilt = SCENE_TILT;
    view.worldPerPixel = worldPerPixel;
    const plan = view.plan();
    let camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
    if (plan.kind === 'orthographic') {
      const f = orthographicFrustum(plan, 640, 480);
      camera = new THREE.OrthographicCamera(f.left, f.right, f.top, f.bottom, 0.1, 2 * view.eyeDistance() + plan.distance);
    } else {
      camera = new THREE.PerspectiveCamera(perspectiveFovDeg(plan), 640 / 480, plan.distance / 50, plan.distance * 4);
    }
    camera.up.set(0, 0, 1);
    camera.position.set(...view.eye());
    camera.lookAt(view.centerX, view.centerY, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    return camera;
  }

  it('theGroundInTheMiddleOfTheFrameFallsInsideAShadowCascade', () => {
    // The district and street views of the render gates, orthographic then perspective, and back out: the light builds
    // its shadow once, so the one shadow node must follow each camera and each zoom.
    const lighting = new SceneLighting(resolveRenderSettings(RENDER_CONFIG));
    const scene = new THREE.Scene().add(lighting.group);
    // What of `CSMShadowNode` the renderer drives each frame: its first build, the pass before a frame, the cascade lights.
    type Cascades = { camera: THREE.Camera | null; lights: Array<THREE.Object3D & { shadow: THREE.LightShadow }>; _init(builder: unknown): void; updateBefore(): void };
    const node = () => lighting.sun.shadow.shadowNode as unknown as Cascades;
    for (const [k, worldPerPixel] of [1, 0.2, 0.15, 1].entries()) {
      const camera = sceneCamera(worldPerPixel);
      lighting.useCamera(camera);
      const csm = node();
      // The first build hands the node the camera being drawn.
      if (k === 0) csm._init({ camera, renderer: { coordinateSystem: THREE.WebGLCoordinateSystem, reversedDepthBuffer: false } });
      csm.updateBefore();
      scene.updateMatrixWorld(true);
      // Shadow-map coordinates of the point, 0..1 on every axis inside the cascade's box, depth included.
      const inside = csm.lights.map((l) => {
        l.shadow.updateMatrices(l as unknown as THREE.Light);
        const p = new THREE.Vector3(0, 0, 0).applyMatrix4(l.shadow.matrix);
        return [p.x, p.y, p.z].every((v) => v >= 0 && v <= 1);
      });
      expect(csm.camera, 'the cascades follow the camera of the frame').toBe(camera);
      expect(inside, `worldPerPixel ${worldPerPixel}: the ground at the focus is in a cascade`).toContain(true);
    }
  });
});
