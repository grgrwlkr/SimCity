// The worker's world, driver and render buffer behind the message interface. Free of worker
// globals, so the whole request path runs under Vitest.
import {
  buildCity,
  bumpVersion,
  CitizenTripCounter,
  CityCommuteScenario,
  createWorld,
  CROSS_LAYOUT,
  despawnVehicle,
  forEachCitizenCar,
  forEachRegionalStanding,
  forEachWalker,
  detectIntersections,
  fingerprint,
  frame,
  linkRoomMeters,
  LivingCityScenario,
  loadWorld,
  MetropolisScenario,
  objectiveValue,
  parseRustCommand,
  presetById,
  recordSystemError,
  refSlot,
  requestState,
  rngProbeDigest,
  saveWorld,
  SignalizedCrossScenario,
  spawnVehicle,
  stampAndExpire,
  startEmergency,
  startScenario,
  step,
  summarizeTraffic,
  tileDiagnosis,
  toHex64,
  type BudgetLines,
  type ScenarioRuntime,
  type ShownToast,
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
  type BudgetMonthView,
  type DebugVehicle,
  type FingerprintReply,
  type GridLayers,
  type MesoLinksReply,
  isSlotRequest,
  type ScenarioProgressView,
  type ImmediateRequest,
  type Reply,
  type ReplyByRequest,
  type Request,
  type SlotRequest,
  type TickStatsReply,
  type WorldSnapshot,
  type WorldView,
} from './protocol';
import {
  AMBULANCE_KIND,
  BUS_KIND,
  FIRE_KIND,
  PARKED_TRUCK_KIND,
  PARKED_VEHICLE_KIND,
  PEDESTRIAN_KIND,
  POLICE_KIND,
  RENDER_ID_SPACE,
  RenderWriter,
  TRUCK_KIND,
  createRenderBuffer,
  extraCars,
  type RenderExtras,
} from './renderBuffer';
import { debugOverlayOf, renderLayersOf } from './renderLayers';
import { dataMapLayer } from './requests/dataMap';
import { SAMPLE_CARS, sampleCutoff, sampled } from './sample';
import { createOpfsSaveFiles, type SaveFiles } from './saveFiles';
import { SCENARIOS, type ScenarioName } from './scenarios';

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
/** The render kind of each `MesoTraffic.vehicle` class: car, truck, bus, fire engine, police car, ambulance. */
const MESO_KINDS = [0, TRUCK_KIND, BUS_KIND, FIRE_KIND, POLICE_KIND, AMBULANCE_KIND] as const;
/** Ticks whose cost `tickStats` reads. */
const TICK_SAMPLES = 4096;
/** A save file is UTF-8 JSON; the text never leaves the worker. */
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
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

/** A catalog preset on its own seed or `seed`; its runtime only counts the trips of its citizens for the HUD. */
const preset = (id: string) => (w: World, seed: bigint | undefined) => {
  startScenario(w, presetById(id)!, seed);
  return new CitizenTripCounter();
};

/** A builder for every scenario of the menu: a listed name without one fails the typecheck. */
const SCENARIO_BUILDERS: Readonly<Record<ScenarioName, (w: World, seed: bigint | undefined) => ScenarioRuntime>> = {
  sandbox: preset('sandbox'),
  starter: preset('starter'),
  // Without zones: grown citizens would drive among the commuters and share their ids.
  city: (w) => {
    const plan = buildCity(w, { zones: false });
    return new CityCommuteScenario(w, { ...CITY_COMMUTE, homes: plan.homes, workplaces: plan.workplaces });
  },
  livingCity: (w) => new LivingCityScenario(w),
  metropolis: (w) => new MetropolisScenario(w),
  signalizedCross: (w) => new SignalizedCrossScenario(w, undefined, CROSS_LAYOUT.signalizedCross),
  signalizedCross4: (w) => new SignalizedCrossScenario(w, undefined, CROSS_LAYOUT.signalizedCross4),
};

function scenarioView(w: World): ScenarioProgressView | null {
  const s = w.scenario;
  if (s.activeId === null) return null;
  return {
    id: s.activeId,
    // The menu's title: the preset's own name is the English of the Rust catalog.
    name: SCENARIOS.find((info) => info.name === s.activeId)?.title ?? s.activeName ?? s.activeId,
    objectives: s.objectives.map((o, i) => ({ kind: o.kind, target: o.target, current: objectiveValue(w.city, o), met: s.met[i] ?? false })),
    completed: s.objectivesCompleted,
    isCompleted: s.isCompleted,
  };
}

export class SimHost {
  readonly render: SharedArrayBuffer;
  private world: World;
  private driver: FixedStepDriver;
  private readonly writer: RenderWriter;
  private readonly extras: RenderExtras;
  private readonly loads = new Uint8Array(RENDER_LINK_CAPACITY);
  /** What the camera sees with its margin, in world coordinates and in tiles; `null` for everything. */
  private view: { readonly world: WorldView; readonly tiles: TileView } | null = null;
  private lastReported: string | null = null;
  /** Recent average cost of a fixed tick, ms. */
  private tickMs: number | null = null;
  /** The cost of each of the last ticks, a ring. */
  private readonly tickSamples = new Float64Array(TICK_SAMPLES);
  private tickSampleCount = 0;
  /** The screen's memory of the feed's toasts, `stampAndExpire`'s to keep: the host's, never the world's. */
  private shownToasts: readonly ShownToast[] = [];
  /** A toast came up or retired since the last snapshot `update` reported. */
  private toastsChanged = false;
  /** The requests `answer` holds back behind a slot request, and the end of the last of them. */
  private waiting = 0;
  private queue: Promise<void> = Promise.resolve();

  /** The running scenario, which the world keeps so a save carries it. */
  private get scenario(): HostScenario | null {
    return this.world.scenarioRuntime;
  }

  /** `saves`: where the game's save slots live; OPFS unless a test gives another. */
  constructor(
    renderCapacity: number,
    private readonly saves: SaveFiles = createOpfsSaveFiles(),
  ) {
    this.world = createWorld();
    this.driver = new FixedStepDriver(this.world);
    this.render = createRenderBuffer(renderCapacity, RENDER_LINK_CAPACITY);
    this.writer = new RenderWriter(this.render);
    this.extras = extraCars(renderCapacity);
  }

  handle<T extends ImmediateRequest['t']>(req: Extract<ImmediateRequest, { t: T }>): ReplyByRequest[T] {
    return this.dispatch(req) as ReplyByRequest[T];
  }

  /**
   * Any request, strictly in arrival order: while a slot request waits on its file, the requests after it wait too, so
   * a `loadSlot` sent before a `scenario` is applied before it. Nothing waiting, an immediate request runs at once.
   */
  answer(req: Request): Promise<Reply> {
    const run = (): Reply | Promise<Reply> => (isSlotRequest(req) ? this.dispatchSlot(req) : this.dispatch(req));
    if (this.waiting === 0 && !isSlotRequest(req)) {
      try {
        return Promise.resolve(run());
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.waiting += 1;
    const result = this.queue.then(run);
    this.queue = result.then(
      () => void (this.waiting -= 1),
      () => void (this.waiting -= 1),
    );
    return result;
  }

  /** A save slot request: the world is saved at once, the file written or read after. */
  async handleSlot<T extends SlotRequest['t']>(req: Extract<SlotRequest, { t: T }>): Promise<ReplyByRequest[T]> {
    return (await this.dispatchSlot(req)) as ReplyByRequest[T];
  }

  private async dispatchSlot(req: SlotRequest): Promise<Reply> {
    switch (req.t) {
      case 'saveSlot': {
        const bytes = UTF8_ENCODER.encode(saveWorld(this.world));
        return this.saves.write(req.slot, bytes);
      }
      case 'loadSlot':
        return this.loadBytes(await this.saves.read(req.slot));
      case 'listSlots':
        return this.saves.list();
      case 'removeSlot':
        await this.saves.remove(req.slot);
        return null;
    }
  }

  /** Built aside and swapped in only whole: a file that fails leaves the running world untouched. */
  private loadBytes(bytes: Uint8Array): FingerprintReply {
    // The world brings its scenario with it.
    this.adoptWorld(loadWorld(UTF8_DECODER.decode(bytes)));
    return this.fingerprintReply();
  }

  private dispatch(req: ImmediateRequest): Reply {
    switch (req.t) {
      case 'cmd':
        this.world.commands.push(parseRustCommand(req.cmd));
        // The publish key does not see money, rates, funding or loans: the frame that applies the command reports it.
        this.lastReported = null;
        return null;
      case 'step':
        for (let i = 0; i < req.ticks; i++) {
          this.scenario?.advance(this.world);
          const started = performance.now();
          step(this.world, 1);
          const ms = performance.now() - started;
          this.recordTickCost(ms);
          this.recordTickSample(ms);
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
        // As with a command: an undo may change only what the publish key does not see.
        this.lastReported = null;
        return null;
      case 'tile':
        return this.world.grid.get(req.pos) ?? null;
      case 'tileDiagnosis': {
        const w = this.world;
        const found = tileDiagnosis(w.grid, w.utilityNetwork, w.rciDemand, req.pos, w.cityFields);
        return found === null ? null : { zone: found[0], reason: found[1] };
      }
      case 'mapLayers':
        return renderLayersOf(this.world.grid, this.world.mapConfig, this.world.mapEditVersion, this.world.graphVersion, this.world.mapSeed);
      case 'loadGrid':
        this.loadGrid(req.layers);
        return null;
      case 'debugVehicles':
        this.placeVehicles(req.vehicles);
        return null;
      case 'debugOverlay':
        return debugOverlayOf(this.world);
      case 'scenario': {
        // Every scenario in a fresh world: the same game whatever ran before it in this tab, never its map, seed,
        // treasury, hour or objectives.
        this.replaceWorld(req.size ?? SCENARIOS.find((s) => s.name === req.name)?.mapSize);
        this.world.scenarioRuntime = SCENARIO_BUILDERS[req.name](this.world, req.seed === undefined ? undefined : BigInt(req.seed));
        // Settled into its first frame here: whether the loop ran an empty frame before the next request cannot matter.
        frame(this.world, 0);
        return null;
      }
      case 'debugFailSystem':
        this.world.debugFailSystem = req.system;
        return null;
      case 'setView':
        this.setView(req.view);
        return null;
      case 'mesoLinks':
        return this.mesoLinks();
      case 'debugEmergency':
        startEmergency(this.world, req.kind, { x: req.x, y: req.y }, 0.5);
        return null;
      case 'tickStats':
        return this.tickStats();
      case 'resetTickStats':
        this.tickSampleCount = 0;
        return null;
      case 'dataMap':
        return dataMapLayer(this.world, req.overlay);
      case 'save':
        return UTF8_ENCODER.encode(saveWorld(this.world)).buffer;
      case 'load':
        return this.loadBytes(new Uint8Array(req.bytes));
    }
  }

  /**
   * A fresh world of `size` tiles a side (the default map without one) for a scenario of its own map, in the state the
   * old one was heading for, at its speed.
   */
  private replaceWorld(size: number | undefined): void {
    const old = this.world;
    const w = createWorld(size === undefined ? {} : { mapWidth: size, mapHeight: size });
    const state = old.nextState?.state ?? old.appState;
    if (state !== 'MainMenu') requestState(w, state);
    this.adoptWorld(w);
  }

  /** `w` in place of the running world, at the running speed, with the scenario it carries. */
  private adoptWorld(w: World): void {
    const driver = new FixedStepDriver(w);
    driver.speed = this.driver.speed;
    this.world = w;
    this.driver = driver;
    this.tickMs = null;
    this.lastReported = null;
    this.shownToasts = [];
  }

  private recordTickSample(ms: number): void {
    this.tickSamples[this.tickSampleCount % TICK_SAMPLES] = ms;
    this.tickSampleCount += 1;
  }

  private tickStats(): TickStatsReply {
    const count = Math.min(this.tickSampleCount, TICK_SAMPLES);
    const sorted = this.tickSamples.slice(0, count).sort();
    const at = (q: number) => sorted[Math.min(count - 1, Math.floor(q * (count - 1)))] ?? 0;
    return { count: this.tickSampleCount, p50Ms: at(0.5), p99Ms: at(0.99), maxMs: sorted[count - 1] ?? 0 };
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
      // Each tick is timed from the start of its own to the start of the next; the last to the end of the frame.
      let mark = started;
      let ran = 0;
      const ticks = this.driver.update(nowMs, (w) => {
        const now = performance.now();
        if (ran > 0) this.recordTickSample(now - mark);
        mark = now;
        ran += 1;
        this.scenario?.advance(w);
      });
      if (ticks > 0) {
        this.recordTickSample(performance.now() - mark);
        this.recordTickCost((performance.now() - started) / ticks);
        this.publish();
      }
    } catch (error) {
      // The worker must not die: the frame's error goes to the snapshot and the next frame runs.
      recordSystemError(this.world, 'frame', error);
    }
    const snapshot = this.snapshot(nowMs);
    const failures = snapshot.errors.reduce((sum, e) => sum + e.count, 0);
    const key = `${snapshot.tick}|${snapshot.appState}|${snapshot.speed}|${snapshot.mapEditVersion}|${snapshot.graphVersion}|${failures}`;
    if (key === this.lastReported && !this.toastsChanged) return null;
    this.lastReported = key;
    this.toastsChanged = false;
    return snapshot;
  }

  /** The snapshot at real time `nowMs`, which decides the toasts on screen. */
  snapshot(nowMs = performance.now()): WorldSnapshot {
    const w = this.world;
    const stats = this.scenario?.stats?.(w);
    const screen = stampAndExpire(w.notifications.messages(), this.shownToasts, nowMs / 1000);
    this.shownToasts = screen.shown;
    this.toastsChanged ||= screen.changed;
    const ledger = w.budget;
    const month = (index: number, moneyStart: number, moneyEnd: number, lines: BudgetLines): BudgetMonthView => ({
      month: index,
      moneyStart,
      moneyEnd,
      lines: lines.entries().map(([item, amount]) => ({ item, amount })),
    });
    const rates = w.taxRates.percent;
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
      services: {
        emergencies: w.emergencies.active.map((e) => ({ id: e.id, kind: e.kind, x: e.pos.x, y: e.pos.y })),
        vehicles: w.fleet.services.length,
        vehiclesOut: w.fleet.services.filter((v) => v.state !== 'AtStation').length,
        buses: w.fleet.buses.length,
        resolved: w.emergencies.stats.resolvedInTime,
        failed: w.emergencies.stats.failedResponses,
      },
      budget: {
        current: month(ledger.month, ledger.moneyStart, w.city.money, ledger.current),
        last: ledger.last === null ? null : month(ledger.last.month, ledger.last.moneyStart, ledger.last.moneyEnd, ledger.last.lines),
        daysElapsed: ledger.daysElapsed,
        daysPerMonth: w.economyConfig.daysPerMonth,
      },
      taxRates: { Residential: { ...rates.Residential }, Commercial: { ...rates.Commercial }, Industrial: { ...rates.Industrial } },
      serviceFunding: { ...w.serviceFunding.percent },
      loans: w.loans.active.map((loan) => ({ principal: loan.principal, monthlyPayment: loan.monthlyPayment, monthsLeft: loan.monthsLeft })),
      toasts: screen.visible,
      history: w.notifications.history().map((line) => ({ ...line })),
      milestones: { bestPopulation: w.milestones.bestPopulation, next: w.milestones.next() ?? null },
      advisor: w.advisor.problems.slice(0, 3).map((problem) => ({ ...problem, at: problem.at === null ? null : { ...problem.at } })),
      scenario: scenarioView(w),
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
      (parked, id, generation, x, y, heading, _truck, vehicle) => {
        if (!parked) push(DRIVING_ID_BASE + id, PARKED_ID_BASE, generation, x, y, heading, (MESO_KINDS as readonly number[])[vehicle] ?? 0);
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
