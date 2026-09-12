// Worker ↔ main thread messages. Requests carry an id so `window.__sim` can await each reply.
import type { AppState, City, LightPhase, ManeuverKind, MapCell, MapGrid, TilePos, TrafficSummary } from '@simcity/sim';
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
  /** `u64` as a decimal string: structured clone keeps bigint, JSON and Playwright do not. */
  readonly mapSeed: string;
  readonly city: City;
  /** The render side refetches `mapLayers` when this moves. */
  readonly mapEditVersion: number;
  readonly graphVersion: number;
  readonly lights: readonly TrafficLightView[];
  readonly traffic: TrafficView;
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
  | { readonly t: 'scenario'; readonly name: ScenarioName };

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
  readonly mapLayers: MapLayersReply;
  readonly loadGrid: null;
  readonly debugVehicles: null;
  readonly debugOverlay: DebugOverlayReply;
  readonly scenario: null;
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
