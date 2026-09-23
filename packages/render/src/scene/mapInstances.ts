// The instances the map itself puts on screen — buildings, their roof glyphs and street furniture — kept up to date edit
// by edit: a map edit swaps out the tiles of the chunks it changed (and, for props, the ring of chunks around them) and
// leaves the rest of every buffer alone. No renderer here, so a test can compare an edited map with a fresh build.
import type { MapLayersReply } from '@simcity/bridge';
import { BUILDING_KINDS, tileToWorld, type BuildingProfile, type MapConfig } from '@simcity/sim';
import * as THREE from 'three/webgpu';
import { CHUNK_TILES, chunkGrid } from '../mapChunks';
import { PARKED_CAR_TINTS, PROPS_CONFIG } from '../props';
import type { CompositeMesh, MaterialSpec, PropMeshKind, RenderPrimitives } from '../renderPrimitives';
import type { SceneMaterials } from './atlasNode';
import { BuildingVisuals } from './buildings';
import { placeFurniture, type PropPose, type TileArea } from './furniture';
import { InstanceBatch } from './instanceBatch';

/** The grid carries a building's kind per tile, not its level or profile: every building shows as a first-level medium one. */
const GRID_PROFILE: BuildingProfile = { density: 'Medium', class: 'Middle' };
/**
 * The seed street furniture is rolled with. `MapLayersReply` carries no map seed yet (unit U0 adds it); until then every
 * map rolls with 0, so furniture is stable per layout but the same pattern on every map.
 */
export const SCENE_MAP_SEED = 0n;

/** Tiles of chunk `index`. */
function chunkArea(map: MapLayersReply, index: number): TileArea {
  const { cols } = chunkGrid(map.width, map.height);
  const x0 = (index % cols) * CHUNK_TILES;
  const y0 = Math.floor(index / cols) * CHUNK_TILES;
  return { x0, y0, x1: Math.min(x0 + CHUNK_TILES, map.width), y1: Math.min(y0 + CHUNK_TILES, map.height) };
}

/** The shared night-glow materials of `lighting.ts`; without them windows and signs wear a flat cached material. */
export interface GlowMaterials {
  readonly windows: THREE.Material;
  readonly signs: THREE.Material;
}

export class MapInstances {
  readonly buildingGroup = new THREE.Group();
  readonly propGroup = new THREE.Group();
  private visuals: BuildingVisuals | null = null;
  private tileSize = 0;
  /** Building instances by (shape, material), and the batch each tile's building sits in. */
  private readonly buildingBatchByKey = new Map<CompositeMesh, Map<MaterialSpec, InstanceBatch>>();
  private readonly buildingBatchOf = new Map<number, InstanceBatch>();
  /** Window instances by window mesh, all on the one window material, and the batch each tile's windows sit in. */
  private readonly windowBatchByMesh = new Map<CompositeMesh, InstanceBatch>();
  private readonly windowBatchOf = new Map<number, InstanceBatch>();
  private glyphBatch: InstanceBatch | null = null;
  /** One unit quad for every glyph piece, sized per instance. */
  private readonly glyphGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly propBatches = new Map<PropMeshKind, InstanceBatch>();
  /** The kinds of prop each tile owns instances of. */
  private readonly propsOf = new Map<number, PropMeshKind[]>();

  constructor(
    private readonly prims: RenderPrimitives,
    private readonly materials: SceneMaterials,
    private readonly geometryOf: (mesh: CompositeMesh) => THREE.BufferGeometry,
    private readonly glow: GlowMaterials | null = null,
  ) {}

  /** Brings the instances to `map`, redoing the tiles of `changed` chunks; `fresh` drops everything first (a new map). */
  apply(map: MapLayersReply, changed: readonly number[], fresh: boolean): void {
    if (fresh || this.visuals === null || this.tileSize !== map.tileSize) {
      this.reset();
      this.visuals = new BuildingVisuals(this.prims, map.tileSize);
      this.tileSize = map.tileSize;
    }
    if (changed.length === 0) return;
    this.updateBuildings(map, this.visuals, changed);
    this.updateProps(map, changed);
  }

  get buildings(): number {
    return this.visuals?.size ?? 0;
  }

  get props(): number {
    return [...this.propBatches.values()].reduce((n, b) => n + b.count, 0);
  }

  buildingBatches(): InstanceBatch[] {
    return [...this.buildingBatchByKey.values()].flatMap((m) => [...m.values()]);
  }

  /**
   * Every instance as `batch|tile|matrix`, sorted: two builds of the same map give the same list whatever order their
   * edits came in, and a stale matrix or a stale prop shows as a difference.
   */
  windowBatches(): InstanceBatch[] {
    return [...this.windowBatchByMesh.values()];
  }

  digest(): string[] {
    const all = [...this.buildingBatches(), ...this.windowBatches(), ...(this.glyphBatch === null ? [] : [this.glyphBatch]), ...this.propBatches.values()];
    return all.flatMap((b) => b.entries().map((e) => `${b.name}|${e}`)).sort();
  }

  /** Instances per batch name, the empty ones left out: a duplicated instance shows here even where `buildings` does not. */
  batchCounts(): Record<string, number> {
    const all = [...this.buildingBatches(), ...this.windowBatches(), ...(this.glyphBatch === null ? [] : [this.glyphBatch]), ...this.propBatches.values()];
    const out: Record<string, number> = {};
    for (const b of all) if (b.count > 0) out[b.name] = (out[b.name] ?? 0) + b.count;
    return out;
  }

  private reset(): void {
    for (const batch of this.buildingBatches()) batch.dispose();
    for (const batch of this.windowBatches()) batch.dispose();
    for (const batch of this.propBatches.values()) batch.dispose();
    this.glyphBatch?.dispose();
    this.buildingBatchByKey.clear();
    this.buildingBatchOf.clear();
    this.windowBatchByMesh.clear();
    this.windowBatchOf.clear();
    this.propBatches.clear();
    this.propsOf.clear();
    this.glyphBatch = null;
    this.visuals?.clear();
  }

  private buildingBatch(body: CompositeMesh, material: MaterialSpec, label: string): InstanceBatch {
    let byMaterial = this.buildingBatchByKey.get(body);
    if (byMaterial === undefined) this.buildingBatchByKey.set(body, (byMaterial = new Map()));
    let batch = byMaterial.get(material);
    if (batch === undefined) byMaterial.set(material, (batch = new InstanceBatch(this.buildingGroup, this.geometryOf(body), this.materials.get(material), label)));
    return batch;
  }

  private windowBatch(windows: CompositeMesh): InstanceBatch {
    let batch = this.windowBatchByMesh.get(windows);
    if (batch === undefined) {
      const material = this.glow?.windows ?? this.materials.get(this.prims.material([1, 1, 1]));
      this.windowBatchByMesh.set(windows, (batch = new InstanceBatch(this.buildingGroup, this.geometryOf(windows), material, `windows ${this.windowBatchByMesh.size}`)));
    }
    return batch;
  }

  /**
   * The buildings of the tiles in `changed` chunks, out and back in: one instanced draw per (shape, material) and one for
   * every roof glyph piece of every station, whatever the number of buildings.
   */
  private updateBuildings(map: MapLayersReply, visuals: BuildingVisuals, changed: readonly number[]): void {
    const cfg: MapConfig = { width: map.width, height: map.height, tileSize: map.tileSize };
    const glyphs = (this.glyphBatch ??= new InstanceBatch(this.buildingGroup, this.glyphGeometry, this.materials.get(visuals.glyphMaterial), 'glyphs'));
    const touched = new Set<InstanceBatch>([glyphs]);
    const matrix = new THREE.Matrix4();
    const turn = new THREE.Quaternion();
    const z = new THREE.Vector3(0, 0, 1);
    for (const index of changed) {
      const a = chunkArea(map, index);
      for (let y = a.y0; y < a.y1; y++) {
        for (let x = a.x0; x < a.x1; x++) {
          const i = y * map.width + x;
          const old = this.buildingBatchOf.get(i);
          if (old !== undefined) {
            old.remove(i);
            touched.add(old);
            this.buildingBatchOf.delete(i);
            visuals.delete(i);
          }
          const oldWindows = this.windowBatchOf.get(i);
          if (oldWindows !== undefined) {
            oldWindows.remove(i);
            touched.add(oldWindows);
            this.windowBatchOf.delete(i);
          }
          glyphs.remove(i);
          const code = map.layers.building[i]!;
          if (code === 0) continue;
          const kind = BUILDING_KINDS[code - 1]!;
          const v = visuals.set(i, { kind, level: 1, width: 1, length: 1, profile: GRID_PROFILE });
          const c = tileToWorld(cfg, { x, y });
          const batch = this.buildingBatch(v.body, v.material, `buildings ${kind} L1 ${v.material.color.join(',')}`);
          batch.put(i, matrix.makeTranslation(c.x, c.y, 0));
          touched.add(batch);
          this.buildingBatchOf.set(i, batch);
          const windows = this.windowBatch(v.windows);
          windows.put(i, matrix);
          touched.add(windows);
          this.windowBatchOf.set(i, windows);
          for (const p of v.glyph) {
            glyphs.put(i, matrix.compose(new THREE.Vector3(c.x + p.offset[0], c.y + p.offset[1], v.glyphZ), turn.setFromAxisAngle(z, p.rotation), new THREE.Vector3(p.size[0], p.size[1], 1)));
          }
        }
      }
    }
    for (const batch of touched) batch.flush();
  }

  private propBatch(kind: PropMeshKind): InstanceBatch {
    let batch = this.propBatches.get(kind);
    if (batch === undefined) {
      // Signs wear the shared glow material: a painted board by day, lit at night.
      const cached = this.materials.get(this.prims.material(kind === 'sign' ? [0.96, 0.82, 0.32] : [1, 1, 1]));
      const material = kind === 'sign' && this.glow !== null ? this.glow.signs : cached;
      batch = new InstanceBatch(this.propGroup, this.geometryOf(this.prims.propMesh(kind)), material, `props-${kind}`);
      this.propBatches.set(kind, batch);
    }
    return batch;
  }

  /**
   * Street furniture of the changed chunks and of the ring of chunks around them: a prop reads its neighbours (a kerb, the
   * road a shop faces, the lamp a wire reaches, at most `spacingTiles` + 1 = 5 away), so an edit can move props up to
   * that far outside its own chunk, and a chunk is 16 tiles.
   */
  private updateProps(map: MapLayersReply, changed: readonly number[]): void {
    const { cols, rows } = chunkGrid(map.width, map.height);
    const ring = new Set<number>();
    for (const index of changed) {
      const [cx, cy] = [index % cols, Math.floor(index / cols)];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (cx + dx >= 0 && cx + dx < cols && cy + dy >= 0 && cy + dy < rows) ring.add((cy + dy) * cols + cx + dx);
        }
      }
    }
    const touched = new Set<InstanceBatch>();
    const matrix = new THREE.Matrix4();
    const turn = new THREE.Quaternion();
    const z = new THREE.Vector3(0, 0, 1);
    for (const index of ring) {
      const a = chunkArea(map, index);
      for (let y = a.y0; y < a.y1; y++) {
        for (let x = a.x0; x < a.x1; x++) {
          const i = y * map.width + x;
          for (const kind of this.propsOf.get(i) ?? []) {
            const batch = this.propBatch(kind);
            batch.remove(i);
            touched.add(batch);
          }
          this.propsOf.delete(i);
        }
      }
      const f = placeFurniture(map, SCENE_MAP_SEED, PROPS_CONFIG, a);
      const lists: Array<[PropMeshKind, PropPose[]]> = [
        ['streetlight', f.lamps],
        ['wire', f.wires],
        ['bin', f.bins],
        ['awning', f.awnings],
        ['sign', f.signs],
        ...PARKED_CAR_TINTS.map((_, t) => [`parkedCar${t as 0 | 1 | 2 | 3}`, f.parkedCars[t]!] as [PropMeshKind, PropPose[]]),
      ];
      for (const [kind, poses] of lists) {
        if (poses.length === 0) continue;
        const batch = this.propBatch(kind);
        touched.add(batch);
        for (const p of poses) {
          batch.put(p.tile, matrix.compose(new THREE.Vector3(p.x, p.y, p.z), turn.setFromAxisAngle(z, p.rotation), new THREE.Vector3(p.scaleX, 1, 1)));
          const kinds = this.propsOf.get(p.tile);
          if (kinds === undefined) this.propsOf.set(p.tile, [kind]);
          else if (!kinds.includes(kind)) kinds.push(kind);
        }
      }
    }
    for (const batch of touched) batch.flush();
  }
}
