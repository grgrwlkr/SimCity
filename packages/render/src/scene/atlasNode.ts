// The atlas on the GPU: a `DataTexture` carrying the per-cell mip chain of `atlasTexture.ts`, and the node that samples
// it for a `MaterialSpec` — the shader side of `atlasUvAt`. Materials are made once per spec: `RenderPrimitives` hands
// out the same spec object for the same look, so a spec is the cache key and batching survives recolouring.
import { clamp, dFdx, dFdy, exp2, float, floor, fract, length, log2, materialColor, max, texture, uv, vec2, vec4 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { ATLAS_GRID, ATLAS_SIZE, IDENTITY_UV, buildAtlasImage } from '../atlas';
import type { MaterialSpec } from '../renderPrimitives';
import { MAX_CELL_LOD, atlasMipChain } from './atlasTexture';

/** Linear RGBA8, the whole chain given, so nothing is generated on the GPU across cell borders. */
export function createAtlasTexture(): THREE.DataTexture {
  const chain = atlasMipChain(buildAtlasImage());
  const base = chain[0]!;
  const tex = new THREE.DataTexture(base.data, base.width, base.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = chain.map((level) => ({ data: level.data, width: level.width, height: level.height })) as unknown as typeof tex.mipmaps;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  // Detail multiplies the colour: it must not be gamma-bent first.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The grey detail `spec` samples. The level is chosen from the derivatives of the unwrapped coordinate, so the wrap of
 * `fract` inside a repeated cell does not spike it into the far mips along every seam; the sample point is clamped half
 * a texel of that level inside its cell.
 */
export function atlasDetail(atlas: THREE.DataTexture, spec: MaterialSpec) {
  const t = spec.uv;
  const vertexMapped = t === IDENTITY_UV;
  const raw = uv();
  const placed = vertexMapped ? raw : vec2(t.offset[0], t.offset[1]).add(fract(raw.mul(t.repeat)).mul(t.scale));
  const texels = vertexMapped ? raw.mul(ATLAS_SIZE) : raw.mul(t.repeat * t.scale * ATLAS_SIZE);
  const rho = max(length(dFdx(texels)), length(dFdy(texels)));
  const lod = clamp(log2(max(rho, float(1e-6))), 0, MAX_CELL_LOD);
  const h = exp2(lod).mul(0.5 / ATLAS_SIZE);
  const origin = floor(placed.mul(ATLAS_GRID)).div(ATLAS_GRID);
  const at = clamp(placed, origin.add(h), origin.add(1 / ATLAS_GRID).sub(h));
  return texture(atlas, at).level(lod).r;
}

export class SceneMaterials {
  private readonly bySpec = new Map<MaterialSpec, THREE.MeshLambertNodeMaterial>();

  constructor(private readonly atlas: THREE.DataTexture) {}

  /**
   * Lit and matte: Lambert is the fully rough end of the spec's `roughness: 1`. Not the standard material: with any
   * light in the scene its pipeline fails in Chromium's WebGPU ("An error occurred while generating Tint IR", three
   * 0.185.1, measured under E2E_GPU=1), while Lambert compiles. Vertex colours multiply in where the geometry has
   * them, instance colours where the mesh has them.
   */
  get(spec: MaterialSpec): THREE.MeshLambertNodeMaterial {
    let m = this.bySpec.get(spec);
    if (m === undefined) {
      const [r, g, b, a] = spec.color;
      m = new THREE.MeshLambertNodeMaterial();
      m.color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
      m.vertexColors = true;
      if (spec.atlas) m.colorNode = vec4(materialColor.mul(atlasDetail(this.atlas, spec)), 1);
      if (spec.blend) {
        m.transparent = true;
        m.opacity = a / 255;
      }
      this.bySpec.set(spec, m);
    }
    return m;
  }

  get size(): number {
    return this.bySpec.size;
  }
}
