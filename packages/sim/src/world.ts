// The simulation state: struct-of-arrays per entity kind, plus the resources the Rust sim keeps as
// Bevy `Resource`s. Capacities are fixed; nothing here allocates per tick.
import { createSimClock, defaultCity, type City } from './city';
import type { GameCommand } from './commands';
import { emptyEvents, type TickEvents } from './events';
import { IntersectionIndex } from './intersections/index';
import { DEFAULT_MAP_CONFIG, type MapConfig } from './map/coords';
import { DirtyTiles } from './map/dirty';
import { MapGrid } from './map/grid';
import { COMMAND_HISTORY_LIMIT, CommandHistory } from './map/history';
import { Notifications } from './notifications';
import { DEFAULT_RNG_SEED, stdRngSeedFromU64, type StdRng } from './rng';
import type { AppState, PendingState } from './state';
import { SECOND_NS, Timer } from './timer';
import { ArbiterIndexCache, emptyArbiterStats, type ArbiterTickStats } from './traffic/arbiter';
import { defaultTrafficConfig, type TrafficConfig } from './traffic/config';
import type { LeftTurnDemand, TrafficLight } from './traffic/lights';
import { TrafficOccupancy, TrafficRoadCache, emptyTrafficIndex, type TrafficIndex } from './traffic/occupancy';
import { PathPool } from './traffic/pathPool';
import { IntersectionReservations } from './traffic/reservations';
import { TrafficSpatialIndex } from './traffic/spatialIndex';
import { VEHICLE_CAPACITY, createVehicleLayers, type VehicleLayers } from './traffic/vehicles';
import { LaneGraph } from './transport/laneGraph';
import { LaneletConflictMatrices } from './transport/lanelet/build';
import { LaneletGraph } from './transport/lanelet/graph';
import { PathCache, defaultPathfindingConfig, type PathfindingConfig } from './transport/pathfinding';
import { RegionGraph } from './transport/regionGraph';
import { RoadGraph } from './transport/roadGraph';

export { VEHICLE_CAPACITY, type VehicleLayers } from './traffic/vehicles';

/** `MapSeed(1)` inserted by `init_map_grid` at startup. */
export const STARTUP_MAP_SEED = 1n;
/** `BuildingUpgradeClock::default()`: a five-second repeating timer. */
export const BUILDING_UPGRADE_PERIOD_NS = 5 * SECOND_NS;

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
  readonly roadGraph: RoadGraph;
  readonly regionGraph: RegionGraph;
  laneGraph: LaneGraph;
  laneletGraph: LaneletGraph;
  laneletConflicts: LaneletConflictMatrices;
  readonly trafficConfig: TrafficConfig;
  /** `TurnLaneAutogenState`: the graph version turn-lane marks were derived for. */
  turnLaneAutogenVersion: number;
  readonly pathCache: PathCache;
  readonly pathfindingConfig: PathfindingConfig;
  readonly intersections: IntersectionIndex;
  readonly trafficOccupancy: TrafficOccupancy;
  readonly vehicles: VehicleLayers;
  readonly pathPool: PathPool;
  /** `VehicleSeqGen`: the last sequence number handed out. */
  vehicleSeq: number;
  /** One per lit intersection cluster (the Rust `TrafficLight` entities). */
  trafficLights: TrafficLight[];
  readonly leftTurnDemand: LeftTurnDemand;
  readonly reservations: IntersectionReservations;
  /** Derived each tick before use: vehicles per tile by progress. */
  readonly spatialIndex: TrafficSpatialIndex;
  readonly trafficIndex: TrafficIndex;
  readonly trafficRoadCache: TrafficRoadCache;
  /** `RouteProducerStats`: which producer built routes (observability). */
  readonly routeProducerStats: { guardRefusals: number; swapBreakHandbuilt: number };
  /** `LaneletStallTracker`: consecutive ticks a vehicle approached a box with an unresolved lanelet. */
  readonly laneletStallTracker: Map<number, number>;
  /** `ApproachFairness`: ticks an approach `${intersection}|${entryDir}` had a candidate but no grant. */
  readonly approachFairness: Map<string, number>;
  /** Derived from the lanelet graph of the matrix version. */
  readonly arbiterIndexCache: ArbiterIndexCache;
  /** Per-tick arbiter observability. */
  arbiterStats: ArbiterTickStats;
  /** `RingTopologyStatus` (advisory) and the intersection version it was counted for. */
  readonly ringTopology: { clustersWithoutOpenExit: number; lastVersion: number };
  /** Active `PedestrianCrossing`s; pedestrians arrive with stage 4, until then only tests fill it. */
  readonly pedestrianCrossings: Array<{ readonly intersectionId: number; readonly axisNs: boolean }>;
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
    roadGraph: new RoadGraph(),
    regionGraph: new RegionGraph(),
    laneGraph: new LaneGraph(),
    laneletGraph: new LaneletGraph(),
    laneletConflicts: new LaneletConflictMatrices(),
    trafficConfig: defaultTrafficConfig(),
    turnLaneAutogenVersion: 0,
    pathCache: new PathCache(),
    pathfindingConfig: defaultPathfindingConfig(),
    intersections: new IntersectionIndex(),
    trafficOccupancy: new TrafficOccupancy(),
    vehicles: createVehicleLayers(VEHICLE_CAPACITY),
    pathPool: new PathPool(),
    vehicleSeq: 0,
    trafficLights: [],
    leftTurnDemand: { ns: new Set(), ew: new Set() },
    reservations: new IntersectionReservations(),
    spatialIndex: new TrafficSpatialIndex(),
    trafficIndex: emptyTrafficIndex(),
    trafficRoadCache: new TrafficRoadCache(),
    routeProducerStats: { guardRefusals: 0, swapBreakHandbuilt: 0 },
    laneletStallTracker: new Map(),
    approachFairness: new Map(),
    arbiterIndexCache: new ArbiterIndexCache(),
    arbiterStats: emptyArbiterStats(),
    ringTopology: { clustersWithoutOpenExit: 0, lastVersion: 0 },
    pedestrianCrossings: [],
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
