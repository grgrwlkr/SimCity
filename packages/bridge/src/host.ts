// The worker's world, driver and render buffer behind the message interface. Free of worker
// globals, so the whole request path runs under Vitest.
import {
  buildCity,
  bumpVersion,
  CityCommuteScenario,
  createWorld,
  CROSS_LAYOUT,
  despawnVehicle,
  forEachCitizenCar,
  forEachRegionalStanding,
  forEachWalker,
  detectIntersections,
  fingerprint,
  linkRoomMeters,
  LivingCityScenario,
  parseRustCommand,
  recordSystemError,
  refSlot,
  requestState,
  rngProbeDigest,
  SignalizedCrossScenario,
  spawnVehicle,
  step,
  summarizeTraffic,
  toHex64,
  VEHICLE_CAPACITY,
  vehicleRef,
  worldRectToTiles,
  worldToTile,
  type TileView,
  type World,
} from '@simcity/sim';
import { FixedStepDriver, SPEED_MULTIPLIER } from './driver';
import {
  GRID_LAYER_NAMES,
  type DebugVehicle,
  type FingerprintReply,
  type GridLayers,
  type MesoLinksReply,
  type Reply,
  type ReplyByRequest,
  type Request,
  type WorldSnapshot,
  type WorldView,
} from './protocol';
import {
  PARKED_TRUCK_KIND,
  PARKED_VEHICLE_KIND,
  PEDESTRIAN_KIND,
  RENDER_ID_SPACE,
  RenderWriter,
  TRUCK_KIND,
  createRenderBuffer,
  extraCars,
  type RenderExtras,
} from './renderBuffer';
import { debugOverlayOf, renderLayersOf } from './renderLayers';
import { SAMPLE_CARS, sampleCutoff, sampled } from './sample';
import type { ScenarioName } from './scenarios';

/** Vehicles a frame holds: the micro vehicles, meso traffic, parked cars, standing trucks and people on foot. */
export const RENDER_CAPACITY = 32_768;
/** Links a frame carries the load of: a map of a thousand tiles a side has fewer. */
export const RENDER_LINK_CAPACITY = 1 << 18;
/**
 * Render ids after the micro vehicle slots, each source in a range of its own: the vehicles of meso traffic, the tiles
 * with parked cars of citizens, citizens on foot, and the cars and trucks of the region standing at their buildings.
 */
const DRIVING_ID_BASE = VEHICLE_CAPACITY;
const PARKED_ID_BASE = 1 << 21;
const WALKER_ID_BASE = 1 << 22;
const STANDING_ID_BASE = (1 << 22) + (1 << 21);
/** From this speed up a frame shows the load of the roads and a sample of the cars on them. */
const LOAD_VIEW_MULTIPLIER = 60;
/** The part of the view's width and height added on every side, so a pan does not show an empty edge. */
const VIEW_MARGIN = 0.25;

/** A scenario the host feeds before every tick; one with commuters also reports them. */
interface HostScenario {
  advance(w: World): void;
  stats?(w: World): { readonly citizens: number; readonly travelling: number; readonly requested: number; readonly arrived: number };
}

/** `?scenario=city`: commuters, their departures spread over five minutes, a stay of two to six. */
const CITY_COMMUTE = { citizens: 2000, departureWindowTicks: 3000, stayTicks: [1200, 3600] } as const;

/** A builder for every scenario of the menu: a listed name without one fails the typecheck. */
const SCENARIO_BUILDERS: Readonly<Record<ScenarioName, (w: World) => HostScenario>> = {
  // Without zones: grown citizens would drive among the commuters and share their ids.
  city: (w) => {
    const plan = buildCity(w, { zones: false });
    return new CityCommuteScenario(w, { ...CITY_COMMUTE, homes: plan.homes, workplaces: plan.workplaces });
  },
  livingCity: (w) => new LivingCityScenario(w),
  signalizedCross: (w) => new SignalizedCrossScenario(w, undefined, CROSS_LAYOUT.signalizedCross),
  signalizedCross4: (w) => new SignalizedCrossScenario(w, undefined, CROSS_LAYOUT.signalizedCross4),
};

export class SimHost {
  readonly render: SharedArrayBuffer;
  private readonly world: World;
  private readonly driver: FixedStepDriver;
  private readonly writer: RenderWriter;
  private readonly extras: RenderExtras;
  private readonly loads = new Uint8Array(RENDER_LINK_CAPACITY);
  /** What the camera sees with its margin, in world coordinates and in tiles; `null` for everything. */
  private view: { readonly world: WorldView; readonly tiles: TileView } | null = null;
  private lastReported: string | null = null;
  private scenario: HostScenario | null = null;
  /** Recent average cost of a fixed tick, ms. */
  private tickMs: number | null = null;

  constructor(renderCapacity: number) {
    this.world = createWorld();
    this.driver = new FixedStepDriver(this.world);
    this.render = createRenderBuffer(renderCapacity, RENDER_LINK_CAPACITY);
    this.writer = new RenderWriter(this.render);
    this.extras = extraCars(renderCapacity);
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
        this.scenario = SCENARIO_BUILDERS[req.name](this.world);
        return null;
      case 'debugFailSystem':
        this.world.debugFailSystem = req.system;
        return null;
      case 'setView':
        this.setView(req.view);
        return null;
      case 'mesoLinks':
        return this.mesoLinks();
    }
  }

  private setView(view: WorldView | null): void {
    if (view === null) {
      this.view = null;
      return;
    }
    const [mx, my] = [(view.right - view.left) * VIEW_MARGIN, (view.top - view.bottom) * VIEW_MARGIN];
    const world = { left: view.left - mx, right: view.right + mx, bottom: view.bottom - my, top: view.top + my };
    this.view = { world, tiles: worldRectToTiles(this.world.mapConfig, world.left, world.right, world.bottom, world.top) };
  }

  private mesoLinks(): MesoLinksReply {
    const g = this.world.meso;
    return {
      builtFor: g.builtFor,
      count: g.linkCount,
      dir: g.dir.slice(),
      lanes: g.lanes.slice(),
      startX: g.startX.slice(),
      startY: g.startY.slice(),
      endX: g.endX.slice(),
      endY: g.endY.slice(),
    };
  }

  /** One loop iteration at real time `nowMs`: the snapshot if tick, state, speed or the map changed since the last report. */
  update(nowMs: number): WorldSnapshot | null {
    try {
      const started = performance.now();
      // The scenario is fed before every tick: at ×3 a frame runs several, each with its own events.
      this.driver.tickCostMs = this.tickMs;
      const ticks = this.driver.update(nowMs, (w) => this.scenario?.advance(w));
      if (ticks > 0) {
        this.recordTickCost((performance.now() - started) / ticks);
        this.publish();
      }
    } catch (error) {
      // The worker must not die: the frame's error goes to the snapshot and the next frame runs.
      recordSystemError(this.world, 'frame', error);
    }
    const snapshot = this.snapshot();
    const failures = snapshot.errors.reduce((sum, e) => sum + e.count, 0);
    const key = `${snapshot.tick}|${snapshot.appState}|${snapshot.speed}|${snapshot.mapEditVersion}|${snapshot.graphVersion}|${failures}`;
    if (key === this.lastReported) return null;
    this.lastReported = key;
    return snapshot;
  }

  snapshot(): WorldSnapshot {
    const w = this.world;
    const stats = this.scenario?.stats?.(w);
    return {
      tick: w.tick,
      appState: w.appState,
      speed: this.driver.speed,
      realRate: this.driver.realRate(),
      errors: [...w.systemErrors.values()].map((e) => ({ ...e })),
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

  /**
   * The frame: what lies in view — every vehicle up to ×10; from ×60 up a sample of the driving ones and the load of every
   * link instead of what stands or walks.
   */
  private publish(): void {
    const w = this.world;
    const extras = this.extras;
    const view = this.view;
    const fast = SPEED_MULTIPLIER[this.driver.speed] >= LOAD_VIEW_MULTIPLIER;
    const capacity = fast ? Math.min(extras.x.length, SAMPLE_CARS) : extras.x.length;
    const v = w.vehicles;
    let microDriving = 0;
    for (const slot of v.order) if (v.parked[slot] !== 1) microDriving += 1;
    const cutoff = fast ? sampleCutoff(microDriving + w.mesoTraffic.carCount(), SAMPLE_CARS) : Infinity;
    extras.count = 0;
    /** Under `id` when it is below the range of the next source, in view, and in the sample of a fast frame. */
    const push = (id: number, limit: number, generation: number, x: number, y: number, heading: number, kind: number) => {
      if (extras.count >= capacity || id >= limit) return;
      if (view !== null && (x < view.world.left || x > view.world.right || y < view.world.bottom || y > view.world.top)) return;
      if (fast && !sampled(id, cutoff)) return;
      const i = extras.count;
      extras.x[i] = x;
      extras.y[i] = y;
      extras.heading[i] = heading;
      extras.slot[i] = id;
      extras.generation[i] = generation;
      extras.kind[i] = kind;
      extras.count += 1;
    };
    for (const slot of v.order) {
      if (fast && v.parked[slot] === 1) continue;
      push(slot, DRIVING_ID_BASE, v.generation[slot]!, v.x[slot]!, v.y[slot]!, v.heading[slot]!, v.parked[slot] === 1 ? PARKED_VEHICLE_KIND : v.kind[slot]!);
    }
    const tiles = view?.tiles;
    forEachCitizenCar(
      w,
      (parked, id, generation, x, y, heading, truck) => {
        if (!parked) push(DRIVING_ID_BASE + id, PARKED_ID_BASE, generation, x, y, heading, truck ? TRUCK_KIND : 0);
        else if (!fast) push(PARKED_ID_BASE + id, WALKER_ID_BASE, generation, x, y, heading, PARKED_VEHICLE_KIND);
      },
      tiles,
      !fast,
    );
    if (!fast) {
      forEachRegionalStanding(
        w,
        (slot, generation, x, y, heading, truck) =>
          push(STANDING_ID_BASE + slot, RENDER_ID_SPACE, generation, x, y, heading, truck ? PARKED_TRUCK_KIND : PARKED_VEHICLE_KIND),
        tiles,
      );
      forEachWalker(w, (slot, generation, x, y, heading) => push(WALKER_ID_BASE + slot, STANDING_ID_BASE, generation, x, y, heading, PEDESTRIAN_KIND), tiles);
    }
    this.writer.publish(w.tick, null, extras, fast ? this.linkLoads() : undefined);
  }

  /** The load of every link: the metres its queue takes against its room, as a byte. */
  private linkLoads(): { count: number; builtFor: number; load: Uint8Array } | undefined {
    const w = this.world;
    const g = w.meso;
    const m = w.mesoTraffic;
    if (g.builtFor === null || m.linksFor !== g.builtFor) return undefined;
    const count = Math.min(g.linkCount, this.loads.length);
    for (let link = 0; link < count; link++) this.loads[link] = Math.round(255 * Math.min(m.usedMeters[link]! / linkRoomMeters(w, link), 1));
    return { count, builtFor: g.builtFor, load: this.loads };
  }
}
