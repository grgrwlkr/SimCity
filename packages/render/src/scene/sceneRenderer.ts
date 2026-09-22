// The scene the player sees (stage R2): textured ground, pseudo-3D buildings, cars and people as instanced meshes with
// the materials of `RenderPrimitives`, street furniture, traffic lamps and emergency markers, all sampling one atlas.
// The camera is the debug renderer's — straight above the ground, the zoom picking the projection — so picking, the
// view controls and `__sim.camera` behave the same; its tilt, the sun and the post-processing are stage R3, and the
// lights here are a flat placeholder until then. Draw calls follow the kinds of things on screen, not their number.
import {
  PEDESTRIAN_KIND,
  type MapLayersReply,
  type RenderFrameCopy,
  type RenderReader,
  type TrafficLightView,
  type WorldView,
} from '@simcity/bridge';
import { BUILDING_KINDS, VEHICLE_LENGTH_TILES, VEHICLE_WIDTH_TILES, tileToWorld, type BuildingProfile, type MapConfig, type TilePos } from '@simcity/sim';
import * as THREE from 'three/webgpu';
import { OrthoView } from '../camera';
import { orthographicFrustum, perspectiveFovDeg, type ProjectionPlan } from '../cameraProjection';
import type { RenderStats } from '../debugRenderer';
import { EmergencyMarkers, type EmergencyView } from '../emergencyMarkers';
import { FpsMeter } from '../fpsMeter';
import { interpolateHeading, interpolatePositions, pairVehicles } from '../interpolate';
import { lampSignal } from '../lamps';
import { changedChunks, chunkGrid } from '../mapChunks';
import { LAMP_COLORS, VEHICLE_COLORS } from '../palette';
import { PlaybackClock } from '../playback';
import { PARKED_CAR_TINTS } from '../props';
import { RenderPrimitives, type CompositeMesh, type PropMeshKind } from '../renderPrimitives';
import { drawnScale, vehicleScale } from '../vehicleLook';
import { SceneMaterials, createAtlasTexture } from './atlasNode';
import { BuildingVisuals } from './buildings';
import { placeFurniture, type PropPose } from './furniture';
import { buildGroundChunk } from './ground';
import type { Renderer } from './renderer';

/** Sim frames kept for playback: the display draws a gap or two behind the newest one. */
const FRAME_HISTORY = 6;
const SKY = 0x7f93a0;
const VIEW_REPORT_MS = 100;
/** Emergency markers float above the tallest buildings. */
const MARKER_Z = 48;
const MARKER_TILES = 0.6;
/** The grid carries a building's kind per tile, not its level or profile: every building shows as a first-level medium one. */
const GRID_PROFILE: BuildingProfile = { density: 'Medium', class: 'Middle' };
/**
 * The seed street furniture is rolled with. `MapLayersReply` carries no map seed yet (unit U0 adds it); until then every
 * map rolls with 0, so furniture is stable per layout but the same pattern on every map.
 */
export const SCENE_MAP_SEED = 0n;

export interface SceneStats extends RenderStats {
  readonly renderer: 'scene';
  /** Draw calls of the last frame, as three counted them. */
  readonly drawCalls: number;
  readonly buildings: number;
  /** Instanced draws the buildings take: one per (shape, material). */
  readonly buildingBatches: number;
  readonly props: number;
}

/** A turn arrow along +x, `size` world units long, centred on the origin (the debug renderer's). */
function arrowGeometry(size: number): THREE.ShapeGeometry {
  const [half, neck, stem, head] = [size / 2, size * 0.1, size * 0.12, size * 0.3];
  const shape = new THREE.Shape().moveTo(-half, -stem).lineTo(neck, -stem).lineTo(neck, -head).lineTo(half, 0).lineTo(neck, head).lineTo(neck, stem).lineTo(-half, stem).closePath();
  return new THREE.ShapeGeometry(shape);
}

function srgbTable(bytes: ReadonlyArray<readonly [number, number, number]>): THREE.Color[] {
  return bytes.map(([r, g, b]) => new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace));
}

export class SceneRenderer implements Renderer {
  readonly view: OrthoView;
  hovered: TilePos | null = null;
  onViewChange: ((view: WorldView) => void) | null = null;
  onLinksNeeded: ((graphVersion: number) => void) | null = null;

  private readonly scene = new THREE.Scene();
  private readonly orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  private readonly perspectiveCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
  private drawnPlan: ProjectionPlan | null = null;
  private readonly prims = new RenderPrimitives();
  private readonly materials = new SceneMaterials(createAtlasTexture());
  private readonly geometries = new Map<CompositeMesh, THREE.BufferGeometry>();
  private readonly chunkMeshes = new Map<number, THREE.Mesh>();
  private readonly buildingGroup = new THREE.Group();
  private readonly propGroup = new THREE.Group();
  private buildings: BuildingVisuals | null = null;
  private buildingBatches = 0;
  private propCount = 0;
  private map: MapLayersReply | null = null;
  private reader: RenderReader | null = null;
  private cars: THREE.InstancedMesh | null = null;
  private meeples: THREE.InstancedMesh | null = null;
  private tileSize = 1;
  private readonly history: RenderFrameCopy[] = [];
  private readonly spareFrames: RenderFrameCopy[] = [];
  private latestSequence = -1;
  private readonly clock = new PlaybackClock();
  private playbackTick = NaN;
  private scratch: { table: Int32Array; pairs: Int32Array; x: Float32Array; y: Float32Array; carKind: Uint8Array } | null = null;
  private pairedFrom: RenderFrameCopy | null = null;
  private pairedTo: RenderFrameCopy | null = null;
  private readonly vehicleColors = srgbTable(VEHICLE_COLORS);
  private lamps: THREE.InstancedMesh;
  private arrows: THREE.InstancedMesh;
  private readonly lampColors = { green: srgbTable([LAMP_COLORS.green])[0]!, yellow: srgbTable([LAMP_COLORS.yellow])[0]!, red: srgbTable([LAMP_COLORS.red])[0]! };
  private readonly markers = new EmergencyMarkers(new RenderPrimitives());
  private emergencies: readonly EmergencyView[] = [];
  private markerMesh: THREE.InstancedMesh | null = null;
  private lastDrawMs: number | null = null;
  private reportedView: WorldView | null = null;
  private reportedViewMs = -Infinity;
  private frames = 0;
  private drawCalls = 0;
  private readonly fpsMeter = new FpsMeter();
  private readonly sizedWaiters: Array<() => void> = [];
  private chunksRebuiltLast = 0;
  private drawnMapEditVersion: number | null = null;
  private pendingMapEditVersion: number | null = null;

  private constructor(
    private readonly renderer: THREE.WebGPURenderer,
    canvas: HTMLCanvasElement,
  ) {
    this.view = new OrthoView({ width: canvas.clientWidth, height: canvas.clientHeight });
    this.scene.background = new THREE.Color(SKY);
    // A flat stand-in for the sun and sky of R3: enough to tell a wall from a roof.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f94, 2.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-0.6, -0.8, 1.6);
    this.scene.add(sun, this.buildingGroup, this.propGroup);
    const unlit = () => {
      const m = new THREE.MeshBasicNodeMaterial();
      m.color.set(0xffffff);
      return m;
    };
    this.lamps = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 20), unlit(), 64);
    this.arrows = new THREE.InstancedMesh(arrowGeometry(1), unlit(), 64);
    for (const mesh of [this.lamps, this.arrows]) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(64 * 3), 3);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    }
  }

  static async create(canvas: HTMLCanvasElement): Promise<SceneRenderer> {
    THREE.ColorManagement.enabled = true;
    // Anti-aliasing goes by `renderSettings.ts` with the rest of the post-processing (R3).
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
    await renderer.init();
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(Math.max(canvas.clientWidth, 1), Math.max(canvas.clientHeight, 1), false);
    const r = new SceneRenderer(renderer, canvas);
    renderer.setAnimationLoop(() => r.draw(performance.now()));
    return r;
  }

  get backend(): 'WebGPU' | 'WebGL2' {
    return (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true ? 'WebGPU' : 'WebGL2';
  }

  resize(width: number, height: number): void {
    this.view.viewport = { width, height };
    if (width > 0 && height > 0) {
      this.renderer.setSize(width, height, false);
      for (const resolve of this.sizedWaiters.splice(0)) resolve();
    }
  }

  whenSized(): Promise<void> {
    if (this.view.viewport.width > 0 && this.view.viewport.height > 0) return Promise.resolve();
    return new Promise((resolve) => this.sizedWaiters.push(resolve));
  }

  attachRenderBuffer(reader: RenderReader): void {
    this.reader = reader;
    for (let i = 0; i <= FRAME_HISTORY; i++) this.spareFrames.push(reader.allocate());
    const n = reader.capacity;
    this.scratch = {
      table: new Int32Array(2 ** Math.ceil(Math.log2(2 * n + 2))),
      pairs: new Int32Array(n),
      x: new Float32Array(n),
      y: new Float32Array(n),
      carKind: new Uint8Array(n).fill(255),
    };
  }

  /** Rebuilds the ground chunks whose tiles changed, and the buildings and furniture when anything did. */
  setMap(map: MapLayersReply): void {
    const resized = this.map !== null && (this.map.width !== map.width || this.map.height !== map.height);
    if (resized) {
      for (const mesh of this.chunkMeshes.values()) this.removeChunk(mesh);
      this.chunkMeshes.clear();
    }
    const changed = changedChunks(this.map, map);
    const { cols } = chunkGrid(map.width, map.height);
    const ground = this.materials.get(this.prims.materialVertexMapped([1, 1, 1]));
    for (const index of changed) {
      const old = this.chunkMeshes.get(index);
      if (old !== undefined) this.removeChunk(old);
      const g = buildGroundChunk(map, index % cols, Math.floor(index / cols));
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
      geometry.setAttribute('color', new THREE.BufferAttribute(g.colors, 3));
      const mesh = new THREE.Mesh(geometry, ground);
      mesh.name = `ground-${index}`;
      this.chunkMeshes.set(index, mesh);
      this.scene.add(mesh);
    }
    this.chunksRebuiltLast = changed.length;
    if (this.buildings === null || this.tileSize !== map.tileSize) this.buildings = new BuildingVisuals(this.prims, map.tileSize);
    this.tileSize = map.tileSize;
    if (changed.length > 0) {
      this.rebuildBuildings(map, this.buildings);
      this.rebuildProps(map);
    }
    this.map = map;
    this.pendingMapEditVersion = map.mapEditVersion;
    if (this.cars === null) this.createVehicleMeshes(map.tileSize);
  }

  /** Load colouring of links is the data-map stage's (U4): the scene draws none yet. */
  setLinks(): void {}

  /** Grid, boxes and lanelets are the debug renderer's (`?debug=1`). */
  setOverlay(): void {}

  /** Lamps beside each box, placed as the debug renderer places them; rebuilt from the snapshot, a handful per light. */
  setLights(lights: readonly TrafficLightView[]): void {
    if (this.map === null) return;
    const ts = this.map.tileSize;
    const cfg: MapConfig = { width: this.map.width, height: this.map.height, tileSize: ts };
    const matrix = new THREE.Matrix4();
    const turn = new THREE.Quaternion();
    const z = new THREE.Vector3(0, 0, 1);
    let lamps = 0;
    let arrows = 0;
    this.ensureCapacity('lamps', lights.length * 4);
    this.ensureCapacity('arrows', lights.length * 4);
    for (const light of lights) {
      const origin = tileToWorld(cfg, { x: light.minX, y: light.minY });
      const at = (tx: number, ty: number) => [origin.x + (tx - light.minX) * ts, origin.y + (ty - light.minY) * ts] as const;
      const spots = [
        { at: at(light.minX - 0.5, light.minY - 1), axis: 'ew', travel: [1, 0] },
        { at: at(light.maxX + 0.5, light.maxY + 1), axis: 'ew', travel: [-1, 0] },
        { at: at(light.maxX + 1, light.minY - 0.5), axis: 'ns', travel: [0, 1] },
        { at: at(light.minX - 1, light.maxY + 0.5), axis: 'ns', travel: [0, -1] },
      ] as const;
      for (const { at: [x, y], axis, travel: [dx, dy] } of spots) {
        const signal = lampSignal(light.phase, axis);
        const s = ts * 0.32;
        this.lamps.setMatrixAt(lamps, matrix.compose(new THREE.Vector3(x, y, 2), turn.identity(), new THREE.Vector3(s, s, 1)));
        this.lamps.setColorAt(lamps, this.lampColors[signal.main]);
        lamps += 1;
        if (!signal.leftArrow) continue;
        turn.setFromAxisAngle(z, Math.atan2(dx, -dy));
        const a = ts * 0.6;
        this.arrows.setMatrixAt(arrows, matrix.compose(new THREE.Vector3(x - dx * ts * 0.75, y - dy * ts * 0.75, 2), turn, new THREE.Vector3(a, a, 1)));
        this.arrows.setColorAt(arrows, this.lampColors.green);
        arrows += 1;
      }
    }
    for (const [mesh, count] of [
      [this.lamps, lamps],
      [this.arrows, arrows],
    ] as const) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
    }
  }

  setEmergencies(emergencies: readonly EmergencyView[]): void {
    this.emergencies = emergencies;
  }

  stats(): SceneStats {
    return {
      renderer: 'scene',
      projection: (this.drawnPlan ?? this.view.plan()).kind,
      backend: this.backend,
      frames: this.frames,
      fps: Math.round(this.fpsMeter.fps),
      chunks: this.chunkMeshes.size,
      chunksRebuiltLast: this.chunksRebuiltLast,
      mapEditVersion: this.drawnMapEditVersion,
      vehicles: (this.cars?.count ?? 0) + (this.meeples?.count ?? 0),
      overlayLanelets: 0,
      lights: this.lamps.count,
      arrows: this.arrows.count,
      loadLinks: 0,
      playbackTick: Number.isNaN(this.playbackTick) ? null : this.playbackTick,
      emergencyMarkers: this.markerMesh?.count ?? 0,
      hovered: this.hovered,
      drawCalls: this.drawCalls,
      buildings: [...(this.buildings?.entries() ?? [])].length,
      buildingBatches: this.buildingBatches,
      props: this.propCount,
    };
  }

  /** One `BufferGeometry` per cached mesh: instances of a shape share it. */
  private geometryOf(mesh: CompositeMesh): THREE.BufferGeometry {
    let g = this.geometries.get(mesh);
    if (g === undefined) {
      g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
      g.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 4));
      g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      this.geometries.set(mesh, g);
    }
    return g;
  }

  private static clearGroup(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof THREE.InstancedMesh) child.dispose();
    }
  }

  /** One instanced mesh per (shape, material), and one for every roof glyph piece of every station. */
  private rebuildBuildings(map: MapLayersReply, visuals: BuildingVisuals): void {
    SceneRenderer.clearGroup(this.buildingGroup);
    visuals.clear();
    const cfg: MapConfig = { width: map.width, height: map.height, tileSize: map.tileSize };
    const code = map.layers.building;
    for (let i = 0; i < code.length; i++) {
      if (code[i] === 0) continue;
      visuals.set(i, { kind: BUILDING_KINDS[code[i]! - 1]!, level: 1, width: 1, length: 1, profile: GRID_PROFILE });
    }
    const centre = (id: number) => tileToWorld(cfg, { x: id % map.width, y: Math.floor(id / map.width) });
    const matrix = new THREE.Matrix4();
    const batches = visuals.batches();
    for (const batch of batches) {
      const mesh = new THREE.InstancedMesh(this.geometryOf(batch.body), this.materials.get(batch.material), batch.ids.length);
      batch.ids.forEach((id, k) => {
        const c = centre(id);
        mesh.setMatrixAt(k, matrix.makeTranslation(c.x, c.y, 0));
      });
      mesh.name = 'buildings';
      this.buildingGroup.add(mesh);
    }
    const glyphs: Array<{ x: number; y: number; z: number; w: number; h: number; rotation: number }> = [];
    for (const [id, v] of visuals.entries()) {
      const c = centre(id);
      for (const p of v.glyph) glyphs.push({ x: c.x + p.offset[0], y: c.y + p.offset[1], z: v.glyphZ, w: p.size[0], h: p.size[1], rotation: p.rotation });
    }
    if (glyphs.length > 0) {
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.materials.get(visuals.glyphMaterial), glyphs.length);
      const turn = new THREE.Quaternion();
      const z = new THREE.Vector3(0, 0, 1);
      glyphs.forEach((g, k) => mesh.setMatrixAt(k, matrix.compose(new THREE.Vector3(g.x, g.y, g.z), turn.setFromAxisAngle(z, g.rotation), new THREE.Vector3(g.w, g.h, 1))));
      mesh.name = 'glyphs';
      this.buildingGroup.add(mesh);
    }
    this.buildingBatches = batches.length;
  }

  /** One instanced mesh per kind of prop (per tint for parked cars). */
  private rebuildProps(map: MapLayersReply): void {
    SceneRenderer.clearGroup(this.propGroup);
    const f = placeFurniture(map, SCENE_MAP_SEED);
    const white = this.prims.material([1, 1, 1]);
    const lists: Array<[PropMeshKind, PropPose[], ReturnType<RenderPrimitives['material']>]> = [
      ['streetlight', f.lamps, white],
      ['wire', f.wires, white],
      ['bin', f.bins, white],
      ['awning', f.awnings, white],
      // Paint by day; the night glow of the sign is R3's.
      ['sign', f.signs, this.prims.material([0.96, 0.82, 0.32])],
      ...PARKED_CAR_TINTS.map((_, t) => [`parkedCar${t as 0 | 1 | 2 | 3}`, f.parkedCars[t]!, white] as [PropMeshKind, PropPose[], typeof white]),
    ];
    const matrix = new THREE.Matrix4();
    const turn = new THREE.Quaternion();
    const z = new THREE.Vector3(0, 0, 1);
    this.propCount = 0;
    for (const [kind, poses, material] of lists) {
      if (poses.length === 0) continue;
      const mesh = new THREE.InstancedMesh(this.geometryOf(this.prims.propMesh(kind)), this.materials.get(material), poses.length);
      poses.forEach((p, k) => mesh.setMatrixAt(k, matrix.compose(new THREE.Vector3(p.x, p.y, p.z), turn.setFromAxisAngle(z, p.rotation), new THREE.Vector3(p.scaleX, 1, 1))));
      mesh.name = `props-${kind}`;
      this.propGroup.add(mesh);
      this.propCount += poses.length;
    }
  }

  private ensureCapacity(which: 'lamps' | 'arrows', needed: number): void {
    const mesh = this[which];
    if (mesh.instanceMatrix.count >= needed) return;
    const capacity = Math.max(needed, mesh.instanceMatrix.count * 2);
    const grown = new THREE.InstancedMesh(mesh.geometry, mesh.material, capacity);
    grown.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    grown.frustumCulled = false;
    this.scene.remove(mesh);
    mesh.dispose();
    this.scene.add(grown);
    this[which] = grown;
  }

  private createVehicleMeshes(tileSize: number): void {
    if (this.reader === null) return;
    const capacity = this.reader.capacity;
    const white = this.materials.get(this.prims.material([1, 1, 1]));
    const car = this.prims.carMesh(tileSize * VEHICLE_LENGTH_TILES, tileSize * VEHICLE_WIDTH_TILES);
    const [r, g, b] = VEHICLE_COLORS[PEDESTRIAN_KIND % VEHICLE_COLORS.length]!;
    const meeple = this.prims.meepleMesh([r / 255, g / 255, b / 255]);
    this.cars = new THREE.InstancedMesh(this.geometryOf(car), white, capacity);
    // Created up front: a material compiled before the first `setColorAt` would ignore instance colours.
    this.cars.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.meeples = new THREE.InstancedMesh(this.geometryOf(meeple), white, capacity);
    for (const mesh of [this.cars, this.meeples]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    }
  }

  private frameCamera(): THREE.Camera {
    const plan = this.view.plan();
    const { width, height } = this.view.viewport;
    let camera: THREE.Camera;
    if (plan.kind === 'orthographic') {
      const f = orthographicFrustum(plan, width, height);
      Object.assign(this.orthoCamera, { left: f.left, right: f.right, top: f.top, bottom: f.bottom, far: plan.distance * 4 });
      this.orthoCamera.updateProjectionMatrix();
      camera = this.orthoCamera;
    } else {
      this.perspectiveCamera.fov = perspectiveFovDeg(plan);
      this.perspectiveCamera.aspect = width / Math.max(height, 1);
      this.perspectiveCamera.far = plan.distance * 4;
      this.perspectiveCamera.updateProjectionMatrix();
      camera = this.perspectiveCamera;
    }
    camera.position.set(this.view.centerX, this.view.centerY, plan.distance);
    this.drawnPlan = plan;
    return camera;
  }

  private draw(nowMs: number): void {
    if (this.view.viewport.width === 0 || this.view.viewport.height === 0) {
      this.fpsMeter.idle(nowMs);
      return;
    }
    this.updateVehicles(nowMs);
    this.updateMarkers(nowMs);
    this.reportView(this.view.bounds(), nowMs);
    this.renderer.render(this.scene, this.frameCamera());
    this.drawCalls = this.renderer.info.render.drawCalls;
    this.frames += 1;
    this.fpsMeter.frame(nowMs);
    if (this.pendingMapEditVersion !== null) {
      this.drawnMapEditVersion = this.pendingMapEditVersion;
      this.pendingMapEditVersion = null;
    }
  }

  /** A square over each emergency, dimmed by its blink. */
  private updateMarkers(nowMs: number): void {
    const dt = this.lastDrawMs === null ? 0 : (nowMs - this.lastDrawMs) / 1000;
    this.lastDrawMs = nowMs;
    this.markers.sync(this.emergencies, dt);
    const markers = this.markers.markers;
    if (this.map === null || (markers.length === 0 && this.markerMesh === null)) return;
    const cfg: MapConfig = { width: this.map.width, height: this.map.height, tileSize: this.map.tileSize };
    let mesh = this.markerMesh;
    if (mesh === null || mesh.instanceMatrix.count < markers.length) {
      if (mesh !== null) {
        this.scene.remove(mesh);
        mesh.dispose();
      }
      const capacity = Math.max(16, markers.length);
      const side = cfg.tileSize * MARKER_TILES;
      mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(side, side), new THREE.MeshBasicNodeMaterial(), capacity);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.markerMesh = mesh;
    }
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    markers.forEach((marker, k) => {
      const at = tileToWorld(cfg, { x: marker.x, y: marker.y });
      mesh.setMatrixAt(k, matrix.makeTranslation(at.x, at.y, MARKER_Z));
      const [r, g, b, a] = marker.material.color;
      mesh.setColorAt(k, color.setRGB((r! / 255) * (a! / 255), (g! / 255) * (a! / 255), (b! / 255) * (a! / 255), THREE.SRGBColorSpace));
    });
    mesh.count = markers.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
  }

  private reportView(b: { left: number; right: number; top: number; bottom: number }, nowMs: number): void {
    const last = this.reportedView;
    if (this.onViewChange === null || nowMs - this.reportedViewMs < VIEW_REPORT_MS) return;
    if (last !== null && last.left === b.left && last.right === b.right && last.top === b.top && last.bottom === b.bottom) return;
    this.reportedView = { left: b.left, right: b.right, bottom: b.bottom, top: b.top };
    this.reportedViewMs = nowMs;
    this.onViewChange(this.reportedView);
  }

  /** The playback of the debug renderer, drawn as car bodies and people instead of cubes. */
  private updateVehicles(nowMs: number): void {
    const { reader, cars, meeples, scratch, history } = this;
    if (reader === null || cars === null || meeples === null || scratch === null || cars.instanceColor === null) return;
    if (reader.sequence() !== this.latestSequence) {
      const incoming = this.spareFrames.pop()!;
      this.latestSequence = reader.readInto(incoming);
      if (this.clock.arrive(incoming.tick, nowMs)) this.spareFrames.push(...history.splice(0));
      else if (history.length === FRAME_HISTORY) this.spareFrames.push(history.shift()!);
      history.push(incoming);
      this.pairedFrom = null;
    }
    if (history.length === 0) return;
    const tick = this.clock.advance(nowMs);
    this.playbackTick = tick;
    let i = history.length - 1;
    while (i > 0 && history[i]!.tick > tick) i -= 1;
    const from = history[i]!;
    const to = history[Math.min(i + 1, history.length - 1)]!;
    if (from !== this.pairedFrom || to !== this.pairedTo) {
      pairVehicles(from, to, scratch.table, scratch.pairs);
      this.pairedFrom = from;
      this.pairedTo = to;
    }
    const alpha = from === to ? 1 : Math.min(Math.max((tick - from.tick) / (to.tick - from.tick), 0), 1);
    const n = to.count;
    interpolatePositions(from.x, to.x, scratch.pairs, alpha, n, scratch.x);
    interpolatePositions(from.y, to.y, scratch.pairs, alpha, n, scratch.y);
    const carM = cars.instanceMatrix.array as Float32Array;
    const peopleM = meeples.instanceMatrix.array as Float32Array;
    const colors = cars.instanceColor.array as Float32Array;
    // A person grows past its size only to stay a few pixels wide when zoomed out.
    const grow = drawnScale(PEDESTRIAN_KIND, this.tileSize, this.view.worldPerPixel)[1] / vehicleScale(PEDESTRIAN_KIND)[1];
    let nc = 0;
    let np = 0;
    let recoloured = false;
    for (let k = 0; k < n; k++) {
      const j = scratch.pairs[k]!;
      const heading = j >= 0 ? interpolateHeading(from.heading[j]!, to.heading[k]!, alpha) : to.heading[k]!;
      const cos = Math.cos(heading);
      const sin = Math.sin(heading);
      const kind = to.kind[k]!;
      const person = kind === PEDESTRIAN_KIND;
      const [sx, sy, sz] = person ? [grow, grow, 1] : vehicleScale(kind);
      const m = person ? peopleM : carM;
      const o = (person ? np : nc) * 16;
      m.set([cos * sx, sin * sx, 0, 0, -sin * sy, cos * sy, 0, 0, 0, 0, sz, 0, scratch.x[k]!, scratch.y[k]!, 0, 1], o);
      if (person) {
        np += 1;
        continue;
      }
      if (scratch.carKind[nc] !== kind) {
        scratch.carKind[nc] = kind;
        const c = this.vehicleColors[kind % this.vehicleColors.length]!;
        colors.set([c.r, c.g, c.b], nc * 3);
        recoloured = true;
      }
      nc += 1;
    }
    cars.count = nc;
    meeples.count = np;
    cars.instanceMatrix.needsUpdate = true;
    meeples.instanceMatrix.needsUpdate = true;
    if (recoloured) cars.instanceColor.needsUpdate = true;
  }

  private removeChunk(mesh: THREE.Mesh): void {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
  }
}
