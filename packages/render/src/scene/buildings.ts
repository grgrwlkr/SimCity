// Building bodies of the scene: port of crates/simcity_sim/src/game/buildings/visual.rs (tag rust-final). A body is walls
// of facade and a roof of gravel in one mesh whose vertices carry atlas UVs per face, so one material covers both; the
// mesh is cached by shape, so buildings of one shape are instances of one mesh, and a decay tint is a swap to another
// cached material. Windows and their night glow belong to the lighting stage (R3) and are not built here.
import { serviceKindFromBuilding, type BuildingKind, type BuildingProfile } from '@simcity/sim';
import { uvIn, type AtlasCell } from '../atlas';
import { profileColor, profileHeight, type Rgb } from '../buildingLook';
import { RENDER_CONFIG, type AtlasConfig } from '../renderConfig';
import { MeshBuilder, type Color4, type CompositeMesh, type MaterialSpec, type RenderPrimitives } from '../renderPrimitives';
import { GLYPH_COLOR, glyphPieces, type GlyphPiece } from '../serviceGlyphs';

type Vec3 = readonly [number, number, number];

/** How far a roof glyph floats over the roof: `layer::CHILD_ABOVE`. */
const CHILD_ABOVE = 0.05;

export interface BuildingShape {
  readonly kind: BuildingKind;
  readonly level: number;
  /** Footprint in tiles. */
  readonly width: number;
  readonly length: number;
  readonly profile: BuildingProfile;
}

export interface BuildingVisual {
  readonly shape: BuildingShape;
  /** Shared by every building of the same shape. */
  readonly body: CompositeMesh;
  /** The body material: white, or the decay tint; vertex-mapped, so the mesh picks the atlas cells. */
  readonly material: MaterialSpec;
  /** The service glyph on the roof, empty for anything but a station. */
  readonly glyph: readonly GlyphPiece[];
  readonly glyphZ: number;
}

/** How many times a cell repeats across `len` world units, bounded by the config. */
export function atlasRepeats(len: number, cfg: AtlasConfig): number {
  if (!(cfg.worldUnitsPerCell > 0) || !Number.isFinite(cfg.worldUnitsPerCell)) return 1;
  return Math.min(Math.max(Math.round(len / cfg.worldUnitsPerCell), 1), Math.max(cfg.maxRepeats, 1));
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** The base colour in linear light, times `k`, clipped at 1. */
function scaled(base: Rgb, k: number): Color4 {
  return [Math.min(srgbToLinear(base[0]) * k, 1), Math.min(srgbToLinear(base[1]) * k, 1), Math.min(srgbToLinear(base[2]) * k, 1), 1];
}

/**
 * A quad split into `nu × nv` sub-quads, each carrying the whole cell: an atlas cell cannot repeat through the sampler
 * (its neighbours are other cells), so the repetition lives in the geometry. Corners 0 = (u0, v0), 1 = (u1, v0),
 * 2 = (u1, v1), 3 = (u0, v1).
 */
function quadTiled(b: MeshBuilder, verts: readonly [Vec3, Vec3, Vec3, Vec3], n: Vec3, c: Color4, cell: AtlasCell, nu: number, nv: number): void {
  const lerp = (a: Vec3, z: Vec3, t: number): Vec3 => [a[0] + (z[0] - a[0]) * t, a[1] + (z[1] - a[1]) * t, a[2] + (z[2] - a[2]) * t];
  const at = (u: number, v: number) => lerp(lerp(verts[0], verts[1], u), lerp(verts[3], verts[2], u), v);
  const uv = [...uvIn(cell, 0, 0), ...uvIn(cell, 1, 0), ...uvIn(cell, 1, 1), ...uvIn(cell, 0, 1)];
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) {
      const [u0, u1, v0, v1] = [iu / nu, (iu + 1) / nu, iv / nv, (iv + 1) / nv];
      b.quad([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)], n, c, uv);
    }
  }
}

/** Solid box, Z up, base at z = 0: four facade walls, then a gravel roof, each tiled by the surface size. */
export function buildingBodyMesh(w: number, d: number, h: number, base: Rgb, atlas: AtlasConfig): CompositeMesh {
  const [hw, hd] = [w / 2, d / 2];
  const wall = scaled(base, 0.55);
  const [nx, ny, nz] = [atlasRepeats(w, atlas), atlasRepeats(d, atlas), atlasRepeats(h, atlas)];
  const b = new MeshBuilder();
  quadTiled(b, [[-hw, hd, 0], [-hw, hd, h], [hw, hd, h], [hw, hd, 0]], [0, 1, 0], wall, 'Facade', nz, nx);
  quadTiled(b, [[-hw, -hd, 0], [hw, -hd, 0], [hw, -hd, h], [-hw, -hd, h]], [0, -1, 0], wall, 'Facade', nx, nz);
  quadTiled(b, [[hw, -hd, 0], [hw, hd, 0], [hw, hd, h], [hw, -hd, h]], [1, 0, 0], wall, 'Facade', ny, nz);
  quadTiled(b, [[-hw, -hd, 0], [-hw, -hd, h], [-hw, hd, h], [-hw, hd, 0]], [-1, 0, 0], wall, 'Facade', nz, ny);
  // The roof is gravel, not more facade: what a per-material UV transform could never express for a single mesh.
  quadTiled(b, [[-hw, -hd, h], [hw, -hd, h], [hw, hd, h], [-hw, hd, h]], [0, 0, 1], scaled(base, 1), 'RoofGravel', nx, ny);
  return b.build();
}

/** Body meshes by (kind, level, footprint, profile): buildings of one shape are GPU instances of one mesh. */
export class BuildingMeshCache {
  private readonly byKey = new Map<string, CompositeMesh>();

  constructor(
    private readonly tileSize: number,
    private readonly atlas: AtlasConfig,
  ) {}

  get(s: BuildingShape): CompositeMesh {
    // Inset a unit per side, so neighbouring buildings read as separate blocks.
    const w = s.width * this.tileSize - 2;
    const d = s.length * this.tileSize - 2;
    const key = `${s.kind}|${s.level}|${w}|${d}|${s.profile.density}|${s.profile.class}`;
    let mesh = this.byKey.get(key);
    if (mesh === undefined) {
      mesh = buildingBodyMesh(w, d, profileHeight(s.kind, s.level, s.profile), profileColor(s.kind, s.profile), this.atlas);
      this.byKey.set(key, mesh);
    }
    return mesh;
  }

  get size(): number {
    return this.byKey.size;
  }
}

export interface BuildingBatch {
  readonly body: CompositeMesh;
  readonly material: MaterialSpec;
  /** In the order the buildings were set. */
  readonly ids: number[];
}

/** The visuals of every building on screen, by id: what `rebuild_building_visuals` and `apply_building_tint` kept as children. */
export class BuildingVisuals {
  private readonly cache: BuildingMeshCache;
  private readonly byId = new Map<number, BuildingVisual>();

  constructor(
    private readonly prims: RenderPrimitives,
    private readonly tileSize: number,
    atlas: AtlasConfig = RENDER_CONFIG.atlas,
  ) {
    this.cache = new BuildingMeshCache(tileSize, atlas);
  }

  /** The glyph material: one for every station. */
  get glyphMaterial(): MaterialSpec {
    return this.prims.material(GLYPH_COLOR);
  }

  /** Side of the glyph's box on a roof. */
  get glyphSize(): number {
    return this.tileSize * 1.5;
  }

  set(id: number, shape: BuildingShape, tint: Rgb | null = null): BuildingVisual {
    const service = serviceKindFromBuilding(shape.kind);
    const visual: BuildingVisual = {
      shape,
      body: this.cache.get(shape),
      material: this.prims.materialVertexMapped(tint ?? [1, 1, 1]),
      glyph: service === undefined ? [] : glyphPieces(service, this.glyphSize),
      glyphZ: profileHeight(shape.kind, shape.level, shape.profile) + CHILD_ABOVE,
    };
    this.byId.set(id, visual);
    return visual;
  }

  /** Applies or (with `null`) clears the decay tint without rebuilding the mesh. */
  setTint(id: number, tint: Rgb | null): BuildingVisual {
    const visual = this.byId.get(id);
    if (visual === undefined) throw new Error(`no building ${id}`);
    const tinted = { ...visual, material: this.prims.materialVertexMapped(tint ?? [1, 1, 1]) };
    this.byId.set(id, tinted);
    return tinted;
  }

  get(id: number): BuildingVisual | undefined {
    return this.byId.get(id);
  }

  clear(): void {
    this.byId.clear();
  }

  entries(): IterableIterator<[number, BuildingVisual]> {
    return this.byId.entries();
  }

  /** One batch per (mesh, material): what the scene draws in one instanced call each, however many buildings share it. */
  batches(): BuildingBatch[] {
    const out = new Map<CompositeMesh, Map<MaterialSpec, BuildingBatch>>();
    for (const [id, v] of this.byId) {
      let byMaterial = out.get(v.body);
      if (byMaterial === undefined) out.set(v.body, (byMaterial = new Map()));
      let batch = byMaterial.get(v.material);
      if (batch === undefined) byMaterial.set(v.material, (batch = { body: v.body, material: v.material, ids: [] }));
      batch.ids.push(id);
    }
    return [...out.values()].flatMap((m) => [...m.values()]);
  }
}
