// Worker ↔ main thread messages. Requests carry an id so `window.__sim` can await each reply.
import type {
  AppState,
  BudgetItem,
  City,
  EmergencyKind,
  HistoryLine,
  LightPhase,
  ManeuverKind,
  MapCell,
  MapGrid,
  Milestone,
  ServiceKind,
  ShownToast,
  SystemError,
  TaxZone,
  TilePos,
  TrafficSummary,
  WealthClass,
} from '@simcity/sim';
import type { SimSpeed } from './driver';
import type { ScenarioName } from './scenarios';

/** A traffic light by the tile bounds of its intersection box. */
export interface TrafficLightView {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly phase: LightPhase;
}

export interface WorldSnapshot {
  readonly tick: number;
  readonly appState: AppState;
  readonly speed: SimSpeed;
  /** Game seconds a real second carries now: the speed, or less when the worker cannot afford its ticks. */
  readonly realRate: number;
  /** Systems that threw and how often; the world went on without them for those ticks. */
  readonly errors: readonly SystemError[];
  /** `u64` as a decimal string: structured clone keeps bigint, JSON and Playwright do not. */
  readonly mapSeed: string;
  readonly city: City;
  /** The render side refetches `mapLayers` when this moves. */
  readonly mapEditVersion: number;
  readonly graphVersion: number;
  readonly lights: readonly TrafficLightView[];
  readonly traffic: TrafficView;
  readonly services: ServicesView;
  readonly budget: BudgetView;
  /** Whole percent per zone and wealth class. */
  readonly taxRates: Readonly<Record<TaxZone, Readonly<Record<WealthClass, number>>>>;
  /** Whole percent of its full budget per service. */
  readonly serviceFunding: Readonly<Record<ServiceKind, number>>;
  readonly loans: readonly LoanView[];
  /**
   * The feed's toasts on screen now, stamped by `stampAndExpire` against the host's memory of the screen: a wall
   * clock decides them, so they live outside the world and its fingerprint.
   */
  readonly toasts: readonly ShownToast[];
  /** The feed's last events, oldest first. */
  readonly history: readonly HistoryLine[];
  readonly milestones: MilestonesView;
  /** The advisor's first three problems, worst first; empty until the first tick of a game (or of a scenario) assesses it. */
  readonly advisor: readonly AdvisorProblemView[];
}

/** One budget line of a month, whole dollars: income positive, spending negative. */
export interface BudgetLineView {
  readonly item: BudgetItem;
  readonly amount: number;
}

export interface BudgetMonthView {
  readonly month: number;
  readonly moneyStart: number;
  /** The treasury when the month closed; for the month in progress, the treasury now. */
  readonly moneyEnd: number;
  /** The lines posted, in `BUDGET_ITEMS` order. */
  readonly lines: readonly BudgetLineView[];
}

export interface BudgetView {
  readonly current: BudgetMonthView;
  /** The month closed last; `null` before the first closes. */
  readonly last: BudgetMonthView | null;
  readonly daysElapsed: number;
  readonly daysPerMonth: number;
}

export interface LoanView {
  readonly principal: number;
  readonly monthlyPayment: number;
  readonly monthsLeft: number;
}

export interface MilestonesView {
  /** The largest population the city has reached. */
  readonly bestPopulation: number;
  /** The next milestone ahead; `null` once none is left. */
  readonly next: Milestone | null;
}

/** A problem of the city the advisor names: `ProblemKind` of crates/simcity_sim/src/game/advisor.rs, as S3 ports it. */
export interface AdvisorProblemView {
  readonly kind: string;
  readonly severity: number;
  readonly text: string;
  readonly at: TilePos | null;
}

/** Why a zoned tile is held back, for the tooltip: `tileDiagnosis` of packages/sim. */
export interface TileDiagnosisReply {
  readonly zone: string;
  readonly reason: string;
}

/** An emergency under way, at the anchor of the building it broke out at. */
export interface EmergencyView {
  readonly id: number;
  readonly kind: EmergencyKind;
  readonly x: number;
  readonly y: number;
}

/** The HUD's services line and the emergency markers (stage 4). */
export interface ServicesView {
  readonly emergencies: readonly EmergencyView[];
  /** Vehicles of the service stations, and those away from their station. */
  readonly vehicles: number;
  readonly vehiclesOut: number;
  readonly buses: number;
  /** Emergencies resolved in time and failed, since the game started. */
  readonly resolved: number;
  readonly failed: number;
}

/** The HUD's traffic line: the vehicles' summary, the running scenario's commuters and the tick cost. */
export interface TrafficView extends TrafficSummary {
  /** Commuters of the running scenario; the four are `null` without one. */
  readonly citizens: number | null;
  readonly travelling: number | null;
  readonly tripsStarted: number | null;
  readonly tripsDone: number | null;
  /** Recent average cost of a fixed tick, ms; `null` before the first tick. */
  readonly simTickMs: number | null;
}

/** Every per-tile layer of `MapGrid`, in its field order. */
export const GRID_LAYER_NAMES = [
  'elevation',
  'water',
  'terrain',
  'roadKind',
  'roadDir',
  'roadLane',
  'roadFlow',
  'laneType',
  'zone',
  'density',
  'building',
] as const satisfies ReadonlyArray<keyof MapGrid>;
export type GridLayerName = (typeof GRID_LAYER_NAMES)[number];
export type GridLayers = Record<GridLayerName, Uint8Array>;

/** The layers the debug renderer colours tiles by, copied out of the grid. */
export interface MapLayersReply {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly mapEditVersion: number;
  readonly graphVersion: number;
  /** `u64` as a decimal string, as in the snapshot: street furniture rolls on it. */
  readonly mapSeed: string;
  readonly layers: {
    readonly water: Uint8Array;
    readonly roadKind: Uint8Array;
    readonly roadDir: Uint8Array;
    readonly zone: Uint8Array;
    readonly building: Uint8Array;
  };
}

export interface DebugOverlayReply {
  readonly graphVersion: number;
  /** The lanelets are built on the fixed tick after a graph change; ask again until this catches up. */
  readonly laneletsBuiltFor: number | null;
  /** Tile coordinates flattened as `[x0, y0, x1, y1, ...]`. */
  readonly clusters: ReadonlyArray<{ readonly id: number; readonly tiles: number[] }>;
  /** Approach lane, in-box tiles, exit lane, flattened. */
  readonly lanelets: ReadonlyArray<{ readonly intersection: number; readonly maneuver: ManeuverKind; readonly path: number[] }>;
}

/** What the camera sees, in world coordinates. */
export interface WorldView {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly top: number;
}

/** The meso links as the renderer colours them by load: tile coordinates of the middle of each end. */
export interface MesoLinksReply {
  /** The graph version the links are numbered for; `null` before the first graph. */
  readonly builtFor: number | null;
  readonly count: number;
  readonly dir: Uint8Array;
  readonly lanes: Uint8Array;
  readonly startX: Float32Array;
  readonly startY: Float32Array;
  readonly endX: Float32Array;
  readonly endY: Float32Array;
}

/** The cost of the last ticks the worker ran, stepped or at speed. */
export interface TickStatsReply {
  readonly count: number;
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

/** A vehicle placed by hand into the render layer until traffic exists (stage 2). World coordinates. */
export interface DebugVehicle {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly kind: number;
}

export interface FingerprintReply {
  readonly tick: number;
  /** 16 hex digits. */
  readonly fingerprint: string;
}

export type { DataMapOverlay, DataMapReply, DataMapRequest } from './requests/dataMap';

export type Request =
  /** `GameCommand` in its serde-JSON form, validated in the worker. */
  | { readonly t: 'cmd'; readonly cmd: unknown }
  /** Manual stepping, one fixed tick per frame, regardless of speed (as the headless harness does). */
  | { readonly t: 'step'; readonly ticks: number }
  | { readonly t: 'snapshot' }
  | { readonly t: 'fingerprint' }
  | { readonly t: 'setState'; readonly state: AppState }
  | { readonly t: 'setSpeed'; readonly speed: SimSpeed }
  | { readonly t: 'rngProbe'; readonly seed: string; readonly draws: number }
  /** `UndoRedoRequested`: not a `GameCommand` in Rust either. */
  | { readonly t: 'undoRedo'; readonly redo: boolean }
  /** One map cell, for debugging and e2e checks. */
  | { readonly t: 'tile'; readonly pos: TilePos }
  /** What holds a zoned tile back: asked when the pointer rests on it, never in every snapshot. */
  | { readonly t: 'tileDiagnosis'; readonly pos: TilePos }
  | { readonly t: 'mapLayers' }
  /**
   * Replace every grid layer at once (debug and tests, as writing the world over BRP did): the test
   * city comes from a Rust fixture until test_city.rs is ported. Same size as the map only.
   */
  | { readonly t: 'loadGrid'; readonly layers: GridLayers }
  /** Replace the vehicle slots with these and publish a render frame. Changes the fingerprint. */
  | { readonly t: 'debugVehicles'; readonly vehicles: readonly DebugVehicle[] }
  | { readonly t: 'debugOverlay' }
  /** Build a scenario into the world; the host feeds it before every fixed tick from then on. */
  | { readonly t: 'scenario'; readonly name: ScenarioName; readonly size?: number }
  /** Make a system throw on every call (`null` stops it): the worker's resilience from DevTools and Playwright. */
  | { readonly t: 'debugFailSystem'; readonly system: string | null }
  /** What the camera sees (`null` for everything): the render frame holds only what lies in it, with a margin. */
  | { readonly t: 'setView'; readonly view: WorldView | null }
  | { readonly t: 'mesoLinks' }
  /** An emergency of `kind` breaks out at the tile, as `spawnEmergencies` would start one: e2e and DevTools. */
  | { readonly t: 'debugEmergency'; readonly kind: EmergencyKind; readonly x: number; readonly y: number }
  /** The cost of the last 4 096 ticks at most, since the last reset. */
  | { readonly t: 'tickStats' }
  | { readonly t: 'resetTickStats' }
  /**
   * The whole world as a save file (packages/sim/src/save), UTF-8 bytes transferred, not copied: for a store outside the
   * worker, such as the desktop shell's files. The game's own slots are the `…Slot` requests.
   */
  | { readonly t: 'save' }
  /** A save file's bytes in place of the world; a broken file is an error and the world stays as it was. */
  | { readonly t: 'load'; readonly bytes: ArrayBuffer }
  /** One data map's numbers per tile (U4): only reads the world, the renderer paints them. */
  | import('./requests/dataMap').DataMapRequest
  | SlotRequest;

/** Save slots the worker keeps itself (OPFS): the save never crosses to the main thread. Answered asynchronously. */
export type SlotRequest =
  | { readonly t: 'saveSlot'; readonly slot: string }
  | { readonly t: 'loadSlot'; readonly slot: string }
  | { readonly t: 'listSlots' }
  | { readonly t: 'removeSlot'; readonly slot: string };

const SLOT_REQUESTS: ReadonlySet<string> = new Set<SlotRequest['t']>(['saveSlot', 'loadSlot', 'listSlots', 'removeSlot']);

export const isSlotRequest = (req: Request): req is SlotRequest => SLOT_REQUESTS.has(req.t);

/** Every request the host answers at once. */
export type ImmediateRequest = Exclude<Request, SlotRequest>;

/** One saved slot. */
export interface SaveSlotInfo {
  readonly slot: string;
  /** Size of the save file. */
  readonly bytes: number;
  /** When it was last written, ms since the epoch. */
  readonly modifiedMs: number;
}

export interface ReplyByRequest {
  readonly cmd: null;
  readonly step: FingerprintReply;
  readonly snapshot: WorldSnapshot;
  readonly fingerprint: FingerprintReply;
  readonly setState: null;
  readonly setSpeed: null;
  readonly rngProbe: string;
  readonly undoRedo: null;
  /** `null` outside the map. */
  readonly tile: MapCell | null;
  /** `null` outside the map, on an unzoned tile and where nothing is in the way. */
  readonly tileDiagnosis: TileDiagnosisReply | null;
  readonly mapLayers: MapLayersReply;
  readonly loadGrid: null;
  readonly debugVehicles: null;
  readonly debugOverlay: DebugOverlayReply;
  readonly scenario: null;
  readonly debugFailSystem: null;
  readonly setView: null;
  readonly mesoLinks: MesoLinksReply;
  readonly debugEmergency: null;
  readonly tickStats: TickStatsReply;
  readonly resetTickStats: null;
  readonly save: ArrayBuffer;
  /** The loaded world's tick and fingerprint: those of the world the save was taken of. */
  readonly load: FingerprintReply;
  readonly dataMap: import('./requests/dataMap').DataMapReply;
  readonly saveSlot: SaveSlotInfo;
  readonly loadSlot: FingerprintReply;
  /** By slot name. */
  readonly listSlots: SaveSlotInfo[];
  readonly removeSlot: null;
}

export type Reply = ReplyByRequest[keyof ReplyByRequest];

export interface ToWorker {
  readonly id: number;
  readonly req: Request;
}

export type FromWorker =
  | { readonly t: 'ready'; readonly render: SharedArrayBuffer }
  | { readonly t: 'frame'; readonly snapshot: WorldSnapshot }
  | { readonly t: 'reply'; readonly id: number; readonly value: Reply }
  | { readonly t: 'error'; readonly id: number; readonly message: string };
