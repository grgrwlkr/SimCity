// Shared materials and meshes of the pseudo-3D world: port of the caches in
// crates/simcity_sim/src/game/render_primitives.rs. Recolouring an instance is a swap to another cached material, so
// GPU batching (same mesh, same material) survives data maps that retint thousands of tiles. Gradient maps quantize
// before asking, so the cache stays bounded. The scene turns a spec into a Three.js material once per spec.
import { IDENTITY_UV, cellUv, type AtlasCell, type CellUv } from './atlas';
import type { Rgb } from './buildingLook';

/** sRGB with alpha, each channel 0..1. */
export type Rgba = readonly [number, number, number, number];

export interface MaterialSpec {
  /** sRGB, 0..255 per channel, alpha last. */
  readonly color: readonly [number, number, number, number];
  readonly cell: AtlasCell;
  /** Whether the atlas texture is bound: every cell but `Plain`, and every vertex-mapped material. */
  readonly atlas: boolean;
  readonly uv: CellUv;
  /** Alpha blending for a colour below full alpha; opaque otherwise. */
  readonly blend: boolean;
  /** Lit and matte, so the flat palette reads without specular glare. */
  readonly roughness: number;
}

/** Axis-aligned boxes with vertex colours, Z up, base at z = 0; no bottom faces, nothing is seen from below. */
export interface CompositeMesh {
  /** xyz per vertex. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  /** Linear rgba per vertex. */
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
}

const u8 = (channel: number) => Math.round(Math.min(Math.max(channel, 0), 1) * 255);

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

type Vec3 = readonly [number, number, number];
type Color4 = readonly [number, number, number, number];

class MeshBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uv: number[] = [];
  private readonly col: number[] = [];
  private readonly idx: number[] = [];

  private quad(verts: readonly [Vec3, Vec3, Vec3, Vec3], n: Vec3, c: Color4): void {
    const base = this.pos.length / 3;
    for (const v of verts) {
      this.pos.push(...v);
      this.nor.push(...n);
      this.col.push(...c);
    }
    this.uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Top (+Z), then the walls +Y, −Y, +X, −X, counter-clockwise seen from outside. */
  box([x0, y0, z0]: Vec3, [x1, y1, z1]: Vec3, c: Color4): this {
    this.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], c);
    this.quad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0], c);
    this.quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], c);
    this.quad([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0], c);
    this.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], c);
    return this;
  }

  build(): CompositeMesh {
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nor),
      uvs: new Float32Array(this.uv),
      colors: new Float32Array(this.col),
      indices: new Uint32Array(this.idx),
    };
  }
}

const SKIN: Rgb = [0.92, 0.76, 0.6];

export class RenderPrimitives {
  private readonly materials = new Map<string, MaterialSpec>();
  private readonly cars = new Map<string, CompositeMesh>();
  private readonly meeples = new Map<string, CompositeMesh>();

  /** A flat material of `color`. */
  material(color: Rgb | Rgba): MaterialSpec {
    return this.materialIn(color, 'Plain', 1);
  }

  /** A material of `color` sampling `cell`; the atlas is grey detail around white, so the colour still comes from here. */
  materialIn(color: Rgb | Rgba, cell: AtlasCell, repeat: number): MaterialSpec {
    return this.keyed(color, cell, repeat, false);
  }

  /** A material for a mesh whose vertices carry atlas-space UVs, so faces of one mesh can use different cells. */
  materialVertexMapped(color: Rgb | Rgba): MaterialSpec {
    return this.keyed(color, 'Plain', 1, true);
  }

  private keyed(color: Rgb | Rgba, cell: AtlasCell, repeat: number, vertexMapped: boolean): MaterialSpec {
    const rgba = [u8(color[0]), u8(color[1]), u8(color[2]), u8(color[3] ?? 1)] as const;
    // Quantized to sixteenths so near-identical repeats share a material.
    const repeatSteps = Math.round(Math.min(Math.max(repeat, 0.01), 64) * 16);
    const key = `${rgba.join(',')}|${cell}|${repeatSteps}|${vertexMapped ? 1 : 0}`;
    let spec = this.materials.get(key);
    if (spec === undefined) {
      spec = {
        color: rgba,
        cell,
        atlas: vertexMapped || cell !== 'Plain',
        uv: vertexMapped ? IDENTITY_UV : cellUv(cell, repeatSteps / 16),
        blend: rgba[3] < 255,
        roughness: 1,
      };
      this.materials.set(key, spec);
    }
    return spec;
  }

  /** Distinct cached materials. */
  cacheLen(): number {
    return this.materials.size;
  }

  /** A car of `length` × `width`: a white body the material tints and a dark cabin slightly behind the centre. */
  carMesh(length: number, width: number): CompositeMesh {
    const key = `${length},${width}`;
    let mesh = this.cars.get(key);
    if (mesh === undefined) {
      mesh = new MeshBuilder()
        .box([-length / 2, -width / 2, 0], [length / 2, width / 2, 4.5], [1, 1, 1, 1])
        .box([-length * 0.3, -width * 0.42, 4.5], [length * 0.18, width * 0.42, 7.7], [0.1, 0.12, 0.16, 1])
        .build();
      this.cars.set(key, mesh);
    }
    return mesh;
  }

  /** A person 4.6 units tall: body in the outfit colour, skin head; the outfit is baked in, so every meeple shares one white material. */
  meepleMesh(outfit: Rgb): CompositeMesh {
    const key = [u8(outfit[0]), u8(outfit[1]), u8(outfit[2])].join(',');
    let mesh = this.meeples.get(key);
    if (mesh === undefined) {
      const lin = (c: Rgb): Color4 => [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), 1];
      mesh = new MeshBuilder().box([-0.85, -0.55, 0], [0.85, 0.55, 3.2], lin(outfit)).box([-0.55, -0.55, 3.2], [0.55, 0.55, 4.6], lin(SKIN)).build();
      this.meeples.set(key, mesh);
    }
    return mesh;
  }
}
