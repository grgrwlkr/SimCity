// The simulation state: struct-of-arrays per entity kind, plus the resources the Rust sim keeps as
// Bevy `Resource`s. Capacities are fixed; nothing here allocates per tick.
import { createSimClock, defaultCity, type City } from './city';
import type { GameCommand } from './commands';
import { emptyEvents, type TickEvents } from './events';
import { DEFAULT_MAP_CONFIG, type MapConfig } from './map/coords';
import { DirtyTiles } from './map/dirty';
import { MapGrid } from './map/grid';
import { COMMAND_HISTORY_LIMIT, CommandHistory } from './map/history';
import { Notifications } from './notifications';
import { DEFAULT_RNG_SEED, stdRngSeedFromU64, type StdRng } from './rng';
import type { AppState, PendingState } from './state';
import { SECOND_NS, Timer } from './timer';

export const VEHICLE_CAPACITY = 4096;

/** `MapSeed(1)` inserted by `init_map_grid` at startup. */
export const STARTUP_MAP_SEED = 1n;
/** `BuildingUpgradeClock::default()`: a five-second repeating timer. */
export const BUILDING_UPGRADE_PERIOD_NS = 5 * SECOND_NS;

export interface VehicleLayers {
  readonly alive: Uint8Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly heading: Float32Array;
  readonly lanelet: Int32Array;
  readonly progress: Float32Array;
  readonly state: Uint8Array;
  readonly kind: Uint8Array;
}

export interface World {
  readonly mapConfig: MapConfig;
  readonly grid: MapGrid;
  /** Tiles whose content changed since the render side last drained them. */
  readonly dirty: DirtyTiles;
  /** Tiles whose road changed (lane markings). */
  readonly roadDirty: DirtyTiles;
  /** Bumps on any edit to the grid content. */
  mapEditVersion: number;
  /** Bumps when road topology changes; transport graphs rebuild on it. */
  graphVersion: number;
  readonly history: CommandHistory;
  /** `UndoRedoRequested` messages for the next `CommandApply`, `true` for redo. */
  undoRedo: boolean[];
  readonly vehicles: VehicleLayers;
  /** Fixed ticks run since the world was created. */
  tick: number;
  appState: AppState;
  /** `NextState<AppState>`, applied at the start of the next frame. */
  nextState: PendingState | null;
  mapSeed: bigint;
  city: City;
  readonly clock: Timer;
  readonly buildingUpgradeClock: Timer;
  readonly notifications: Notifications;
  simRng: StdRng;
  growthRng: StdRng;
  events: TickEvents;
  pendingEvents: TickEvents;
  /** Commands queued for the next `CommandApply`. */
  commands: GameCommand[];
}

export interface WorldOptions {
  /** Map size in tiles; the game uses `MapConfig::default()`, tests use small maps. */
  readonly mapWidth?: number;
  readonly mapHeight?: number;
}

export function createWorld(options: WorldOptions = {}): World {
  const mapConfig: MapConfig = {
    ...DEFAULT_MAP_CONFIG,
    width: options.mapWidth ?? DEFAULT_MAP_CONFIG.width,
    height: options.mapHeight ?? DEFAULT_MAP_CONFIG.height,
  };
  const grid = new MapGrid(mapConfig.width, mapConfig.height);
  return {
    mapConfig,
    grid,
    dirty: new DirtyTiles(grid.len()),
    roadDirty: new DirtyTiles(grid.len()),
    mapEditVersion: 0,
    graphVersion: 0,
    history: new CommandHistory(COMMAND_HISTORY_LIMIT),
    undoRedo: [],
    vehicles: {
      alive: new Uint8Array(VEHICLE_CAPACITY),
      x: new Float32Array(VEHICLE_CAPACITY),
      y: new Float32Array(VEHICLE_CAPACITY),
      heading: new Float32Array(VEHICLE_CAPACITY),
      lanelet: new Int32Array(VEHICLE_CAPACITY),
      progress: new Float32Array(VEHICLE_CAPACITY),
      state: new Uint8Array(VEHICLE_CAPACITY),
      kind: new Uint8Array(VEHICLE_CAPACITY),
    },
    tick: 0,
    appState: 'MainMenu',
    nextState: null,
    mapSeed: STARTUP_MAP_SEED,
    city: defaultCity(),
    clock: createSimClock(),
    buildingUpgradeClock: new Timer(BUILDING_UPGRADE_PERIOD_NS, 'Repeating'),
    notifications: new Notifications(),
    simRng: stdRngSeedFromU64(DEFAULT_RNG_SEED),
    growthRng: stdRngSeedFromU64(DEFAULT_RNG_SEED),
    events: emptyEvents(),
    pendingEvents: emptyEvents(),
    commands: [],
  };
}
