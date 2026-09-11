// The stage 1½ debug renderer: map chunks, vehicles as cubes, overlays, a top-down orthographic
// camera. Colours reach the screen exactly as written, so a screenshot can be read back per tile.
import type { DebugOverlayReply, MapLayersReply, RenderFrameCopy, RenderReader } from '@simcity/bridge';
import { tileToWorld, type MapConfig, type TilePos } from '@simcity/sim';
import * as THREE from 'three/webgpu';
import { OrthoView } from './camera';
import { interpolateHeading, interpolatePositions } from './interpolate';
import { buildChunkGeometry, changedChunks, chunkGrid } from './mapChunks';
import { VEHICLE_COLORS } from './palette';

/** A sim frame is 100 ms; drawn frames in between interpolate towards the newest one. */
const SIM_FRAME_MS = 100;
const BACKGROUND = 0x1b1d1a;
const MANEUVER_COLORS: Record<string, number> = { Straight: 0x2fd67e, RightTurn: 0x3b8cff, LeftTurn: 0xff4d4d, UTurn: 0xc26bff };

export interface RenderStats {
  readonly backend: 'WebGPU' | 'WebGL2';
  readonly frames: number;
  readonly chunks: number;
  readonly chunksRebuiltLast: number;
  /** The `mapEditVersion` of the map on screen; `null` before the first map. */
  readonly mapEditVersion: number | null;
  readonly vehicles: number;
  readonly overlayLanelets: number;
  readonly hovered: TilePos | null;
}

export class DebugRenderer {
  readonly view: OrthoView;
  hovered: TilePos | null = null;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 5000);
  private readonly chunkMeshes = new Map<number, THREE.Mesh>();
  private readonly overlay = new THREE.Group();
  private readonly chunkMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
  private vehicles: THREE.InstancedMesh | null = null;
  private map: MapLayersReply | null = null;
  private reader: RenderReader | null = null;
  /** The two newest sim frames and a spare buffer the next read goes into. */
  private frameBuffers: { before: RenderFrameCopy; latest: RenderFrameCopy; spare: RenderFrameCopy } | null = null;
  private latestSequence = -1;
  private latestArrivedMs = 0;
  private interpolated: { x: Float32Array; y: Float32Array } | null = null;
  private frames = 0;
  private chunksRebuiltLast = 0;
  private drawnMapEditVersion: number | null = null;
  private pendingMapEditVersion: number | null = null;
  private overlayLanelets = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly zAxis = new THREE.Vector3(0, 0, 1);

  private constructor(
    private readonly renderer: THREE.WebGPURenderer,
    canvas: HTMLCanvasElement,
  ) {
    this.view = new OrthoView({ width: canvas.clientWidth, height: canvas.clientHeight });
    this.scene.background = new THREE.Color(BACKGROUND);
    this.camera.position.set(0, 0, 1000);
    this.overlay.visible = false;
    this.scene.add(this.overlay);
  }

  /** WebGPU where the browser has it, WebGL2 otherwise (three picks the backend). */
  static async create(canvas: HTMLCanvasElement): Promise<DebugRenderer> {
    THREE.ColorManagement.enabled = false;
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
    await renderer.init();
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    const r = new DebugRenderer(renderer, canvas);
    renderer.setAnimationLoop(() => r.draw(performance.now()));
    return r;
  }

  get backend(): 'WebGPU' | 'WebGL2' {
    return (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true ? 'WebGPU' : 'WebGL2';
  }

  resize(width: number, height: number): void {
    this.view.viewport = { width, height };
    this.renderer.setSize(width, height, false);
  }

  attachRenderBuffer(reader: RenderReader): void {
    this.reader = reader;
    this.frameBuffers = { before: reader.allocate(), latest: reader.allocate(), spare: reader.allocate() };
    this.interpolated = { x: new Float32Array(reader.capacity), y: new Float32Array(reader.capacity) };
  }

  /** Rebuilds the chunks whose tiles changed since the last map. */
  setMap(map: MapLayersReply): void {
    const changed = changedChunks(this.map, map);
    const { cols } = chunkGrid(map.width, map.height);
    if (this.map !== null && (this.map.width !== map.width || this.map.height !== map.height)) {
      for (const mesh of this.chunkMeshes.values()) this.removeMesh(mesh);
      this.chunkMeshes.clear();
    }
    for (const index of changed) {
      const old = this.chunkMeshes.get(index);
      if (old !== undefined) this.removeMesh(old);
      const g = buildChunkGeometry(map, index % cols, Math.floor(index / cols));
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(g.colors, 3));
      const mesh = new THREE.Mesh(geometry, this.chunkMaterial);
      mesh.name = `chunk-${index}`;
      this.chunkMeshes.set(index, mesh);
      this.scene.add(mesh);
    }
    this.chunksRebuiltLast = changed.length;
    this.map = map;
    this.pendingMapEditVersion = map.mapEditVersion;
    if (this.vehicles === null) this.createVehicleMesh(map.tileSize);
  }

  /** Grid lines, intersection boxes and lanelet paths; `null` hides them. */
  setOverlay(overlay: DebugOverlayReply | null): void {
    for (const child of [...this.overlay.children]) {
      this.overlay.remove(child);
      if (child instanceof THREE.LineSegments) child.geometry.dispose();
    }
    this.overlay.visible = overlay !== null && this.map !== null;
    this.overlayLanelets = 0;
    if (overlay === null || this.map === null) return;
    const cfg: MapConfig = { width: this.map.width, height: this.map.height, tileSize: this.map.tileSize };
    const half = cfg.tileSize / 2;

    const grid: number[] = [];
    const sw = tileToWorld(cfg, { x: 0, y: 0 });
    const ne = tileToWorld(cfg, { x: cfg.width - 1, y: cfg.height - 1 });
    for (let x = 0; x <= cfg.width; x += 1) {
      const wx = sw.x - half + x * cfg.tileSize;
      grid.push(wx, sw.y - half, 0.2, wx, ne.y + half, 0.2);
    }
    for (let y = 0; y <= cfg.height; y += 1) {
      const wy = sw.y - half + y * cfg.tileSize;
      grid.push(sw.x - half, wy, 0.2, ne.x + half, wy, 0.2);
    }
    this.overlay.add(lines(grid, null, 0x000000));

    const boxes: number[] = [];
    for (const cluster of overlay.clusters) {
      for (let i = 0; i < cluster.tiles.length; i += 2) {
        const c = tileToWorld(cfg, { x: cluster.tiles[i]!, y: cluster.tiles[i + 1]! });
        const [l, r, b, t] = [c.x - half, c.x + half, c.y - half, c.y + half];
        boxes.push(l, b, 0.4, r, b, 0.4, r, b, 0.4, r, t, 0.4, r, t, 0.4, l, t, 0.4, l, t, 0.4, l, b, 0.4);
      }
    }
    this.overlay.add(lines(boxes, null, 0xffffff));

    const paths: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color();
    for (const ll of overlay.lanelets) {
      color.setHex(MANEUVER_COLORS[ll.maneuver] ?? 0xffffff);
      for (let i = 2; i < ll.path.length; i += 2) {
        const a = tileToWorld(cfg, { x: ll.path[i - 2]!, y: ll.path[i - 1]! });
        const b = tileToWorld(cfg, { x: ll.path[i]!, y: ll.path[i + 1]! });
        paths.push(a.x, a.y, 0.6, b.x, b.y, 0.6);
        colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      }
    }
    this.overlay.add(lines(paths, colors, 0xffffff));
    this.overlayLanelets = overlay.lanelets.length;
  }

  stats(): RenderStats {
    return {
      backend: this.backend,
      frames: this.frames,
      chunks: this.chunkMeshes.size,
      chunksRebuiltLast: this.chunksRebuiltLast,
      mapEditVersion: this.drawnMapEditVersion,
      vehicles: this.vehicles?.count ?? 0,
      overlayLanelets: this.overlay.visible ? this.overlayLanelets : 0,
      hovered: this.hovered,
    };
  }

  private draw(nowMs: number): void {
    this.updateVehicles(nowMs);
    const b = this.view.bounds();
    this.camera.left = b.left;
    this.camera.right = b.right;
    this.camera.top = b.top;
    this.camera.bottom = b.bottom;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    this.frames += 1;
    if (this.pendingMapEditVersion !== null) {
      this.drawnMapEditVersion = this.pendingMapEditVersion;
      this.pendingMapEditVersion = null;
    }
  }

  private createVehicleMesh(tileSize: number): void {
    if (this.reader === null) return;
    const size = tileSize * 0.6;
    const geometry = new THREE.BoxGeometry(size, size * 0.5, size * 0.5);
    geometry.translate(0, 0, size * 0.25);
    this.vehicles = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ color: 0xffffff }), this.reader.capacity);
    // Created up front: a material compiled before the first `setColorAt` would ignore instance colours.
    this.vehicles.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.reader.capacity * 3), 3);
    this.vehicles.count = 0;
    this.vehicles.frustumCulled = false;
    this.scene.add(this.vehicles);
  }

  /** Copies the newest sim frame when it moved and draws the cubes between the last two frames. */
  private updateVehicles(nowMs: number): void {
    const { reader, vehicles, frameBuffers: fb, interpolated } = this;
    if (reader === null || vehicles === null || fb === null || interpolated === null) return;
    const sequence = reader.readInto(fb.spare);
    if (sequence !== this.latestSequence) {
      this.frameBuffers = { before: fb.latest, latest: fb.spare, spare: fb.before };
      this.latestSequence = sequence;
      this.latestArrivedMs = nowMs;
    }
    const { before: from, latest: to } = this.frameBuffers!;
    const n = to.count;
    // Slots line up only while the count holds; until vehicles carry ids (stage 2), a change snaps.
    const alpha = from.count === n ? Math.min((nowMs - this.latestArrivedMs) / SIM_FRAME_MS, 1) : 1;
    interpolatePositions(from.x, to.x, alpha, n, interpolated.x);
    interpolatePositions(from.y, to.y, alpha, n, interpolated.y);
    const color = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const heading = from.count === n ? interpolateHeading(from.heading[i]!, to.heading[i]!, alpha) : to.heading[i]!;
      this.quaternion.setFromAxisAngle(this.zAxis, heading);
      this.matrix.compose(new THREE.Vector3(interpolated.x[i]!, interpolated.y[i]!, 1), this.quaternion, new THREE.Vector3(1, 1, 1));
      vehicles.setMatrixAt(i, this.matrix);
      const [r, g, b] = VEHICLE_COLORS[to.kind[i]! % VEHICLE_COLORS.length]!;
      vehicles.setColorAt(i, color.setRGB(r / 255, g / 255, b / 255));
    }
    vehicles.count = n;
    vehicles.instanceMatrix.needsUpdate = true;
    if (vehicles.instanceColor !== null) vehicles.instanceColor.needsUpdate = true;
  }

  private removeMesh(mesh: THREE.Mesh): void {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
  }
}

function lines(positions: number[], colors: number[] | null, color: number): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (colors !== null) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial(
    colors !== null ? { vertexColors: true } : { color, transparent: true, opacity: 0.25 },
  );
  return new THREE.LineSegments(geometry, material);
}
