// The stage 1½ debug renderer: map chunks, vehicles as cubes, overlays, a top-down orthographic
// camera. Colours reach the screen exactly as written, so a screenshot can be read back per tile.
import type { DebugOverlayReply, MapLayersReply, RenderFrameCopy, RenderReader, TrafficLightView } from '@simcity/bridge';
import {
  VEHICLE_LENGTH_TILES,
  VEHICLE_WIDTH_TILES,
  tileToWorld,
  type MapConfig,
  type TilePos,
} from '@simcity/sim';
import * as THREE from 'three/webgpu';
import { OrthoView } from './camera';
import { FpsMeter } from './fpsMeter';
import { interpolateHeading, interpolatePositions, pairVehicles } from './interpolate';
import { lampSignal } from './lamps';
import { buildChunkGeometry, changedChunks, chunkGrid } from './mapChunks';
import { LAMP_COLORS, VEHICLE_COLORS } from './palette';
import { PlaybackClock } from './playback';

/** Sim frames kept for playback: the display draws a gap or two behind the newest one. */
const FRAME_HISTORY = 6;
const BACKGROUND = 0x1b1d1a;
const MANEUVER_COLORS: Record<string, number> = { Straight: 0x2fd67e, RightTurn: 0x3b8cff, LeftTurn: 0xff4d4d, UTurn: 0xc26bff };

export interface RenderStats {
  readonly backend: 'WebGPU' | 'WebGL2';
  readonly frames: number;
  /** Drawn frames per second over the last second, rounded. */
  readonly fps: number;
  readonly chunks: number;
  readonly chunksRebuiltLast: number;
  /** The `mapEditVersion` of the map on screen; `null` before the first map. */
  readonly mapEditVersion: number | null;
  readonly vehicles: number;
  readonly overlayLanelets: number;
  /** Traffic light lamps on screen, four per light. */
  readonly lights: number;
  /** Green left arrows lit: two per light in a protected-left phase. */
  readonly arrows: number;
  /** The sim tick the vehicles are drawn at, fractional between frames; `null` before the first frame. */
  readonly playbackTick: number | null;
  readonly hovered: TilePos | null;
}

/** A turn arrow along +x, `size` world units long, centred on the origin. */
function arrowGeometry(size: number): THREE.ShapeGeometry {
  const half = size / 2;
  const neck = size * 0.1;
  const stem = size * 0.12;
  const head = size * 0.3;
  const shape = new THREE.Shape()
    .moveTo(-half, -stem)
    .lineTo(neck, -stem)
    .lineTo(neck, -head)
    .lineTo(half, 0)
    .lineTo(neck, head)
    .lineTo(neck, stem)
    .lineTo(-half, stem)
    .closePath();
  return new THREE.ShapeGeometry(shape);
}

type Lamp = { readonly mesh: THREE.Mesh; readonly arrow: THREE.Mesh; readonly axis: 'ns' | 'ew' };

export class DebugRenderer {
  readonly view: OrthoView;
  hovered: TilePos | null = null;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 5000);
  private readonly chunkMeshes = new Map<number, THREE.Mesh>();
  private readonly overlay = new THREE.Group();
  /** Four lamps per light, keyed by the box bounds; the meshes stay and only their colours change. */
  private readonly lamps = new Map<string, Lamp[]>();
  private readonly lampGroup = new THREE.Group();
  private readonly chunkMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
  private vehicles: THREE.InstancedMesh | null = null;
  private map: MapLayersReply | null = null;
  private reader: RenderReader | null = null;
  /** The newest sim frames, oldest first, and the copies the next reads go into. */
  private readonly history: RenderFrameCopy[] = [];
  private readonly spareFrames: RenderFrameCopy[] = [];
  private latestSequence = -1;
  private readonly clock = new PlaybackClock();
  private playbackTick = NaN;
  /** Per-vehicle scratch: pairing between the two frames drawn, drawn positions, the kind each instance is coloured as. */
  private scratch: { bySlot: Int32Array; pairs: Int32Array; x: Float32Array; y: Float32Array; drawnKind: Uint8Array } | null = null;
  private pairedFrom: RenderFrameCopy | null = null;
  private pairedTo: RenderFrameCopy | null = null;
  private frames = 0;
  private readonly fpsMeter = new FpsMeter();
  private readonly sizedWaiters: Array<() => void> = [];
  private chunksRebuiltLast = 0;
  private drawnMapEditVersion: number | null = null;
  private pendingMapEditVersion: number | null = null;
  private overlayLanelets = 0;

  private constructor(
    private readonly renderer: THREE.WebGPURenderer,
    canvas: HTMLCanvasElement,
  ) {
    this.view = new OrthoView({ width: canvas.clientWidth, height: canvas.clientHeight });
    this.scene.background = new THREE.Color(BACKGROUND);
    this.camera.position.set(0, 0, 1000);
    this.overlay.visible = false;
    this.scene.add(this.overlay);
    this.scene.add(this.lampGroup);
  }

  /** WebGPU where the browser has it, WebGL2 otherwise (three picks the backend). */
  static async create(canvas: HTMLCanvasElement): Promise<DebugRenderer> {
    THREE.ColorManagement.enabled = false;
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
    await renderer.init();
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setPixelRatio(window.devicePixelRatio);
    // A collapsed canvas (hidden pane, layout not done) is 0×0, and WebGPU rejects zero-size textures:
    // the drawing buffer keeps at least a pixel, and `draw` waits for a real size.
    renderer.setSize(Math.max(canvas.clientWidth, 1), Math.max(canvas.clientHeight, 1), false);
    const r = new DebugRenderer(renderer, canvas);
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

  /** Resolves once the canvas has a real size (a page opened in a hidden pane starts at 0×0). */
  whenSized(): Promise<void> {
    if (this.view.viewport.width > 0 && this.view.viewport.height > 0) return Promise.resolve();
    return new Promise((resolve) => this.sizedWaiters.push(resolve));
  }

  attachRenderBuffer(reader: RenderReader): void {
    this.reader = reader;
    for (let i = 0; i <= FRAME_HISTORY; i++) this.spareFrames.push(reader.allocate());
    const n = reader.capacity;
    this.scratch = {
      bySlot: new Int32Array(n),
      pairs: new Int32Array(n),
      x: new Float32Array(n),
      y: new Float32Array(n),
      drawnKind: new Uint8Array(n).fill(255),
    };
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

  /**
   * Lamps beside each box: at the mouth of every approach, the main signal of that approach's axis and,
   * in its protected-left phase, a green left arrow. Needs the map (for world coordinates); lights of
   * boxes that are gone are removed.
   */
  setLights(lights: readonly TrafficLightView[]): void {
    if (this.map === null) return;
    const cfg: MapConfig = { width: this.map.width, height: this.map.height, tileSize: this.map.tileSize };
    const seen = new Set<string>();
    for (const light of lights) {
      const key = `${light.minX},${light.minY},${light.maxX},${light.maxY}`;
      seen.add(key);
      let set = this.lamps.get(key);
      if (set === undefined) {
        const origin = tileToWorld(cfg, { x: light.minX, y: light.minY });
        const ts = cfg.tileSize;
        const at = (tx: number, ty: number) => [origin.x + (tx - light.minX) * ts, origin.y + (ty - light.minY) * ts] as const;
        // Right-hand traffic: eastbound arrives on the low row from the west, westbound on the high row
        // from the east; northbound on the high column from the south, southbound on the low column
        // from the north. Each lamp stands on the kerb side of its approach, `travel` being that
        // approach's direction in tile axes.
        const spots: Array<{ at: readonly [number, number]; axis: 'ns' | 'ew'; travel: readonly [number, number] }> = [
          { at: at(light.minX - 0.5, light.minY - 1), axis: 'ew', travel: [1, 0] },
          { at: at(light.maxX + 0.5, light.maxY + 1), axis: 'ew', travel: [-1, 0] },
          { at: at(light.maxX + 1, light.minY - 0.5), axis: 'ns', travel: [0, 1] },
          { at: at(light.minX - 1, light.maxY + 0.5), axis: 'ns', travel: [0, -1] },
        ];
        const [gr, gg, gb] = LAMP_COLORS.green;
        set = spots.map(({ at: [x, y], axis, travel: [dx, dy] }) => {
          const mesh = new THREE.Mesh(new THREE.CircleGeometry(ts * 0.32, 20), new THREE.MeshBasicMaterial({ color: 0xffffff }));
          mesh.position.set(x, y, 2);
          const arrowMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
          arrowMaterial.color.setRGB(gr / 255, gg / 255, gb / 255);
          const arrow = new THREE.Mesh(arrowGeometry(ts * 0.6), arrowMaterial);
          // The extra section just upstream of the lamp, pointing to the driver's left: (dx, dy) turned a quarter left.
          arrow.position.set(x - dx * ts * 0.75, y - dy * ts * 0.75, 2);
          arrow.rotation.z = Math.atan2(dx, -dy);
          arrow.visible = false;
          this.lampGroup.add(mesh, arrow);
          return { mesh, arrow, axis };
        });
        this.lamps.set(key, set);
      }
      for (const { mesh, arrow, axis } of set) {
        const signal = lampSignal(light.phase, axis);
        const [r, g, b] = LAMP_COLORS[signal.main];
        (mesh.material as THREE.MeshBasicMaterial).color.setRGB(r / 255, g / 255, b / 255);
        arrow.visible = signal.leftArrow;
      }
    }
    for (const [key, set] of this.lamps) {
      if (seen.has(key)) continue;
      for (const { mesh, arrow } of set) {
        for (const part of [mesh, arrow]) {
          this.lampGroup.remove(part);
          part.geometry.dispose();
          (part.material as THREE.MeshBasicMaterial).dispose();
        }
      }
      this.lamps.delete(key);
    }
  }

  stats(): RenderStats {
    return {
      backend: this.backend,
      frames: this.frames,
      fps: Math.round(this.fpsMeter.fps),
      chunks: this.chunkMeshes.size,
      chunksRebuiltLast: this.chunksRebuiltLast,
      mapEditVersion: this.drawnMapEditVersion,
      vehicles: this.vehicles?.count ?? 0,
      overlayLanelets: this.overlay.visible ? this.overlayLanelets : 0,
      lights: [...this.lamps.values()].reduce((n, set) => n + set.length, 0),
      arrows: [...this.lamps.values()].reduce((n, set) => n + set.filter((lamp) => lamp.arrow.visible).length, 0),
      playbackTick: Number.isNaN(this.playbackTick) ? null : this.playbackTick,
      hovered: this.hovered,
    };
  }

  private draw(nowMs: number): void {
    if (this.view.viewport.width === 0 || this.view.viewport.height === 0) {
      this.fpsMeter.idle(nowMs);
      return;
    }
    this.updateVehicles(nowMs);
    const b = this.view.bounds();
    this.camera.left = b.left;
    this.camera.right = b.right;
    this.camera.top = b.top;
    this.camera.bottom = b.bottom;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    this.frames += 1;
    this.fpsMeter.frame(nowMs);
    if (this.pendingMapEditVersion !== null) {
      this.drawnMapEditVersion = this.pendingMapEditVersion;
      this.pendingMapEditVersion = null;
    }
  }

  private createVehicleMesh(tileSize: number): void {
    if (this.reader === null) return;
    // The cube is the car the simulation moves: the same length and width, so queues look like queues.
    const length = tileSize * VEHICLE_LENGTH_TILES;
    const width = tileSize * VEHICLE_WIDTH_TILES;
    const geometry = new THREE.BoxGeometry(length, width, width);
    geometry.translate(0, 0, width / 2);
    this.vehicles = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ color: 0xffffff }), this.reader.capacity);
    // Created up front: a material compiled before the first `setColorAt` would ignore instance colours.
    this.vehicles.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.reader.capacity * 3), 3);
    this.vehicles.count = 0;
    this.vehicles.frustumCulled = false;
    this.scene.add(this.vehicles);
  }

  /** Copies a sim frame when a new one was published, then draws the cubes at the playback clock's tick. */
  private updateVehicles(nowMs: number): void {
    const { reader, vehicles, scratch, history } = this;
    if (reader === null || vehicles === null || scratch === null || vehicles.instanceColor === null) return;
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
      pairVehicles(from, to, scratch.bySlot, scratch.pairs);
      this.pairedFrom = from;
      this.pairedTo = to;
    }
    const alpha = from === to ? 1 : Math.min(Math.max((tick - from.tick) / (to.tick - from.tick), 0), 1);
    const n = to.count;
    interpolatePositions(from.x, to.x, scratch.pairs, alpha, n, scratch.x);
    interpolatePositions(from.y, to.y, scratch.pairs, alpha, n, scratch.y);

    // Written straight into the instance buffers: a vector per car per frame was garbage at 60 Hz.
    const matrices = vehicles.instanceMatrix.array as Float32Array;
    const colors = vehicles.instanceColor.array as Float32Array;
    let recoloured = false;
    for (let k = 0; k < n; k++) {
      const j = scratch.pairs[k]!;
      const heading = j >= 0 ? interpolateHeading(from.heading[j]!, to.heading[k]!, alpha) : to.heading[k]!;
      const cos = Math.cos(heading);
      const sin = Math.sin(heading);
      // Column-major: a turn about z, unit scale, lifted to z = 1 (what `Matrix4.compose` gave).
      const o = k * 16;
      matrices[o] = cos;
      matrices[o + 1] = sin;
      matrices[o + 2] = 0;
      matrices[o + 3] = 0;
      matrices[o + 4] = -sin;
      matrices[o + 5] = cos;
      matrices[o + 6] = 0;
      matrices[o + 7] = 0;
      matrices[o + 8] = 0;
      matrices[o + 9] = 0;
      matrices[o + 10] = 1;
      matrices[o + 11] = 0;
      matrices[o + 12] = scratch.x[k]!;
      matrices[o + 13] = scratch.y[k]!;
      matrices[o + 14] = 1;
      matrices[o + 15] = 1;
      const kind = to.kind[k]!;
      if (scratch.drawnKind[k] !== kind) {
        scratch.drawnKind[k] = kind;
        const [r, g, b] = VEHICLE_COLORS[kind % VEHICLE_COLORS.length]!;
        colors[k * 3] = r / 255;
        colors[k * 3 + 1] = g / 255;
        colors[k * 3 + 2] = b / 255;
        recoloured = true;
      }
    }
    vehicles.count = n;
    vehicles.instanceMatrix.needsUpdate = true;
    if (recoloured) vehicles.instanceColor.needsUpdate = true;
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
