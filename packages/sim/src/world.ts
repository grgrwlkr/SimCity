// The simulation state: struct-of-arrays per entity kind, plus the resources the Rust sim keeps as
// Bevy `Resource`s. Capacities are fixed; nothing here allocates per tick.
import { createSimClock, defaultCity, type City } from './city';
import type { GameCommand } from './commands';
import { emptyEvents, type TickEvents } from './events';
import { Notifications } from './notifications';
import { DEFAULT_RNG_SEED, stdRngSeedFromU64, type StdRng } from './rng';
import type { AppState, PendingState } from './state';
import { SECOND_NS, Timer } from './timer';

export const MAP_W = 128;
export const MAP_H = 128;
export const TILE_COUNT = MAP_W * MAP_H;
export const VEHICLE_CAPACITY = 4096;

/** `MapSeed(1)` inserted by `init_map_grid` at startup. */
export const STARTUP_MAP_SEED = 1n;
/** `BuildingUpgradeClock::default()`: a five-second repeating timer. */
export const BUILDING_UPGRADE_PERIOD_NS = 5 * SECOND_NS;

export interface TileLayers {
  readonly kind: Uint8Array;
  readonly zone: Uint8Array;
  readonly road: Uint8Array;
  readonly landValue: Float32Array;
  readonly pollution: Float32Array;
}

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
  readonly w: typeof MAP_W;
  readonly h: typeof MAP_H;
  readonly tiles: TileLayers;
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

export function createWorld(): World {
  return {
    w: MAP_W,
    h: MAP_H,
    tiles: {
      kind: new Uint8Array(TILE_COUNT),
      zone: new Uint8Array(TILE_COUNT),
      road: new Uint8Array(TILE_COUNT),
      landValue: new Float32Array(TILE_COUNT),
      pollution: new Float32Array(TILE_COUNT),
    },
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
