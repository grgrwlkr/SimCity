// A diagnostic frame for the atlas gate (e2e/scene.spec.ts): every cell drawn unlit through the scene's own atlas node,
// one square per cell in `ATLAS_CELLS` order, left to right, with the pattern repeated so densely that the sampler sits
// on the last mip. Whatever a cell reads there must be its own mean: a neighbour bleeding in, or a level spike along the
// seams of the repeat, shows as pixels off that value. Not used by the game.
import { vec3, vec4 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { ATLAS_CELLS } from '../atlas';
import { RenderPrimitives } from '../renderPrimitives';
import { atlasDetail, createAtlasTexture } from './atlasNode';

/** Draws the probe into `canvas`, `side` CSS pixels per cell, and resolves once the frame is on it. */
export async function drawAtlasProbe(canvas: HTMLCanvasElement, side: number, repeat: number): Promise<'WebGPU' | 'WebGL2'> {
  THREE.ColorManagement.enabled = true;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setSize(side * ATLAS_CELLS.length, side, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.OrthographicCamera(0, ATLAS_CELLS.length, 1, 0, -1, 1);
  const atlas = createAtlasTexture();
  const prims = new RenderPrimitives();
  ATLAS_CELLS.forEach((cell, i) => {
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = vec4(vec3(atlasDetail(atlas, prims.materialIn([1, 1, 1], cell, repeat))), 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    quad.position.set(i + 0.5, 0.5, 0);
    scene.add(quad);
  });
  await renderer.renderAsync(scene, camera);
  return (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true ? 'WebGPU' : 'WebGL2';
}
