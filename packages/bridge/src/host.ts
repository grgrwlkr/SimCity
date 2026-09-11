// The worker's world, driver and render buffer behind the message interface. Free of worker
// globals, so the whole request path runs under Vitest.
import {
  bumpVersion,
  createWorld,
  despawnVehicle,
  detectIntersections,
  fingerprint,
  parseRustCommand,
  refSlot,
  requestState,
  rngProbeDigest,
  spawnVehicle,
  step,
  toHex64,
  vehicleRef,
  worldToTile,
  type World,
} from '@simcity/sim';
import { FixedStepDriver } from './driver';
import {
  GRID_LAYER_NAMES,
  type DebugVehicle,
  type FingerprintReply,
  type GridLayers,
  type Reply,
  type ReplyByRequest,
  type Request,
  type WorldSnapshot,
} from './protocol';
import { RenderWriter, createRenderBuffer } from './renderBuffer';
import { debugOverlayOf, renderLayersOf } from './renderLayers';

export class SimHost {
  readonly render: SharedArrayBuffer;
  private readonly world: World;
  private readonly driver: FixedStepDriver;
  private readonly writer: RenderWriter;
  private lastReported: string | null = null;

  constructor(renderCapacity: number) {
    this.world = createWorld();
    this.driver = new FixedStepDriver(this.world);
    this.render = createRenderBuffer(renderCapacity);
    this.writer = new RenderWriter(this.render);
  }

  handle<T extends Request['t']>(req: Extract<Request, { t: T }>): ReplyByRequest[T] {
    return this.dispatch(req) as ReplyByRequest[T];
  }

  private dispatch(req: Request): Reply {
    switch (req.t) {
      case 'cmd':
        this.world.commands.push(parseRustCommand(req.cmd));
        return null;
      case 'step':
        step(this.world, req.ticks);
        this.publish();
        return this.fingerprintReply();
      case 'snapshot':
        return this.snapshot();
      case 'fingerprint':
        return this.fingerprintReply();
      case 'setState':
        requestState(this.world, req.state);
        return null;
      case 'setSpeed':
        this.driver.speed = req.speed;
        return null;
      case 'rngProbe':
        return rngProbeDigest(BigInt(req.seed), req.draws);
      case 'undoRedo':
        this.world.undoRedo.push(req.redo);
        return null;
      case 'tile':
        return this.world.grid.get(req.pos) ?? null;
      case 'mapLayers':
        return renderLayersOf(this.world.grid, this.world.mapConfig, this.world.mapEditVersion, this.world.graphVersion);
      case 'loadGrid':
        this.loadGrid(req.layers);
        return null;
      case 'debugVehicles':
        this.placeVehicles(req.vehicles);
        return null;
      case 'debugOverlay':
        return debugOverlayOf(this.world);
    }
  }

  /** One loop iteration at real time `nowMs`: the snapshot if tick, state, speed or the map changed since the last report. */
  update(nowMs: number): WorldSnapshot | null {
    if (this.driver.update(nowMs) > 0) this.publish();
    const snapshot = this.snapshot();
    const key = `${snapshot.tick}|${snapshot.appState}|${snapshot.speed}|${snapshot.mapEditVersion}|${snapshot.graphVersion}`;
    if (key === this.lastReported) return null;
    this.lastReported = key;
    return snapshot;
  }

  snapshot(): WorldSnapshot {
    const w = this.world;
    return {
      tick: w.tick,
      appState: w.appState,
      speed: this.driver.speed,
      mapSeed: w.mapSeed.toString(),
      city: { ...w.city },
      mapEditVersion: w.mapEditVersion,
      graphVersion: w.graphVersion,
    };
  }

  /**
   * Writes every layer, then does what CommandApply and GraphUpdate do after a map edit in Rust:
   * bump both versions, mark every tile dirty and detect intersections, so the next fixed tick
   * rebuilds the graphs on fresh clusters.
   */
  private loadGrid(layers: GridLayers): void {
    const grid = this.world.grid;
    for (const name of GRID_LAYER_NAMES) {
      const layer = layers[name];
      if (layer?.length !== grid.len()) {
        throw new RangeError(`loadGrid: layer ${name} has ${layer?.length ?? 0} tiles, the map has ${grid.len()}`);
      }
    }
    for (const name of GRID_LAYER_NAMES) grid[name].set(layers[name]);
    const w = this.world;
    w.graphVersion = bumpVersion(w.graphVersion);
    w.mapEditVersion = bumpVersion(w.mapEditVersion);
    w.dirty.markAll();
    w.roadDirty.markAll();
    detectIntersections(w);
  }

  private placeVehicles(vehicles: readonly DebugVehicle[]): void {
    const layers = this.world.vehicles;
    if (vehicles.length > layers.alive.length) {
      throw new RangeError(`debugVehicles: ${vehicles.length} vehicles, capacity ${layers.alive.length}`);
    }
    const w = this.world;
    for (const slot of [...layers.order]) {
      // Debug placement is not a Rust path: release, so repeated placements do not grow the pool.
      w.pathPool.release(layers.pathHandle[slot]!);
      despawnVehicle(w, vehicleRef(layers, slot));
    }
    for (const v of vehicles) {
      const tile = worldToTile(w.mapConfig, v) ?? { x: 0, y: 0 };
      const slot = refSlot(layers, spawnVehicle(w, { route: [tile], kind: v.kind }));
      layers.x[slot] = v.x;
      layers.y[slot] = v.y;
      layers.heading[slot] = v.heading;
    }
    this.publish();
  }

  private fingerprintReply(): FingerprintReply {
    return { tick: this.world.tick, fingerprint: toHex64(fingerprint(this.world)) };
  }

  private publish(): void {
    this.writer.publish(this.world.tick, this.world.vehicles);
  }
}
