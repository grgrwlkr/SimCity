// A diagnostic frame for the atlas gates (e2e/scene.spec.ts): every cell drawn unlit through the scene's own atlas node,
// one square per cell in `ATLAS_CELLS` order, left to right, the pattern repeated so densely that the sampler sits on the
// far mips. Whatever a cell reads there must be its own: a neighbour bleeding in, or a level spike along the seams of the
// repeat, shows as pixels off that value. Not used by the game.
import { vec3, vec4 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { ATLAS_CELLS, ATLAS_SIZE, CELL_SIZE, atlasCellIndex, buildAtlasImage, type AtlasCell, type AtlasImage } from '../atlas';
import { RenderPrimitives } from '../renderPrimitives';
import { atlasDetail, createAtlasTexture } from './atlasNode';

/** An atlas with `lit` white and every other cell and slot black: any bleed across a cell border is a full-scale step. */
export function isolatedCellImage(lit: AtlasCell): AtlasImage {
  const data = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  const [col, row] = atlasCellIndex(lit);
  for (let y = 0; y < ATLAS_SIZE; y++) {
    for (let x = 0; x < ATLAS_SIZE; x++) {
      const v = Math.floor(x / CELL_SIZE) === col && Math.floor(y / CELL_SIZE) === row ? 255 : 0;
      data.set([v, v, v, 255], (y * ATLAS_SIZE + x) * 4);
    }
  }
  return { width: ATLAS_SIZE, height: ATLAS_SIZE, data };
}

/**
 * Draws the probe into `canvas`, `side` CSS pixels per cell, sampling `lit`'s isolated atlas when given and the game's
 * atlas otherwise, and resolves once the frame is submitted.
 */
export async function drawAtlasProbe(canvas: HTMLCanvasElement, side: number, repeat: number, lit?: AtlasCell): Promise<'WebGPU' | 'WebGL2'> {
  THREE.ColorManagement.enabled = true;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setSize(side * ATLAS_CELLS.length, side, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.OrthographicCamera(0, ATLAS_CELLS.length, 1, 0, -1, 1);
  const atlas = createAtlasTexture(lit === undefined ? buildAtlasImage() : isolatedCellImage(lit));
  const prims = new RenderPrimitives();
  ATLAS_CELLS.forEach((cell, i) => {
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = vec4(vec3(atlasDetail(atlas, prims.materialIn([1, 1, 1], cell, repeat))), 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    quad.position.set(i + 0.5, 0.5, 0);
    scene.add(quad);
  });
  renderer.render(scene, camera);
  return (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true ? 'WebGPU' : 'WebGL2';
}
