// The worker's world, driver and render buffer behind the message interface. Free of worker
// globals, so the whole request path runs under Vitest.
import {
  buildCity,
  bumpVersion,
  CityCommuteScenario,
  createWorld,
  CROSS_LAYOUT,
  despawnVehicle,
  detectIntersections,
  fingerprint,
  parseRustCommand,
  refSlot,
  requestState,
  rngProbeDigest,
  SignalizedCrossScenario,
  spawnVehicle,
  step,
  summarizeTraffic,
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

/** A scenario the host feeds before every tick; one with commuters also reports them. */
interface HostScenario {
  advance(w: World): void;
  stats?(): { readonly citizens: number; readonly travelling: number; readonly requested: number; readonly arrived: number };
}

/** `?scenario=city`: commuters, their departures spread over five minutes, a stay of two to six. */
const CITY_COMMUTE = { citizens: 2000, departureWindowTicks: 3000, stayTicks: [1200, 3600] } as const;

export class SimHost {
  readonly render: SharedArrayBuffer;
  private readonly world: World;
  private readonly driver: FixedStepDriver;
  private readonly writer: RenderWriter;
  private lastReported: string | null = null;
  private scenario: HostScenario | null = null;
  /** Recent average cost of a fixed tick, ms. */
  private tickMs: number | null = null;

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
        for (let i = 0; i < req.ticks; i++) {
          this.scenario?.advance(this.world);
          const started = performance.now();
          step(this.world, 1);
          this.recordTickCost(performance.now() - started);
        }
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
      case 'scenario':
        if (req.name === 'city') {
          const plan = buildCity(this.world);
          this.scenario = new CityCommuteScenario(this.world, { ...CITY_COMMUTE, homes: plan.homes, workplaces: plan.workplaces });
        } else {
          this.scenario = new SignalizedCrossScenario(this.world, undefined, CROSS_LAYOUT[req.name]);
        }
        return null;
    }
  }

  /** One loop iteration at real time `nowMs`: the snapshot if tick, state, speed or the map changed since the last report. */
  update(nowMs: number): WorldSnapshot | null {
    // A frame at ×1 runs at most a tick or two, so feeding the scenario once per frame keeps waves on time.
    this.scenario?.advance(this.world);
    const started = performance.now();
    const ticks = this.driver.update(nowMs);
    if (ticks > 0) {
      this.recordTickCost((performance.now() - started) / ticks);
      this.publish();
    }
    const snapshot = this.snapshot();
    const key = `${snapshot.tick}|${snapshot.appState}|${snapshot.speed}|${snapshot.mapEditVersion}|${snapshot.graphVersion}`;
    if (key === this.lastReported) return null;
    this.lastReported = key;
    return snapshot;
  }

  snapshot(): WorldSnapshot {
    const w = this.world;
    const stats = this.scenario?.stats?.();
    return {
      tick: w.tick,
      appState: w.appState,
      speed: this.driver.speed,
      mapSeed: w.mapSeed.toString(),
      city: { ...w.city },
      mapEditVersion: w.mapEditVersion,
      graphVersion: w.graphVersion,
      lights: w.trafficLights.map((light) => {
        const box = w.intersections.clusterById(light.intersectionId);
        return {
          minX: box?.aabbMin.x ?? light.pos.x,
          minY: box?.aabbMin.y ?? light.pos.y,
          maxX: box?.aabbMax.x ?? light.pos.x,
          maxY: box?.aabbMax.y ?? light.pos.y,
          phase: light.phase,
        };
      }),
      traffic: {
        ...summarizeTraffic(w),
        citizens: stats?.citizens ?? null,
        travelling: stats?.travelling ?? null,
        tripsStarted: stats?.requested ?? null,
        tripsDone: stats?.arrived ?? null,
        simTickMs: this.tickMs,
      },
    };
  }

  /** Smooths the per-tick cost over roughly the last ten ticks. */
  private recordTickCost(ms: number): void {
    this.tickMs = this.tickMs === null ? ms : this.tickMs * 0.9 + ms * 0.1;
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
