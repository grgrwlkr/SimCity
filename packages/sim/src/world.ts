// The simulation state: struct-of-arrays per entity kind, plus the resources the Rust sim keeps as
// Bevy `Resource`s. Capacities are fixed; nothing here allocates per tick.
import { Buildings } from './buildings/building';
import { Citizens, emptyCommuteStats, emptyShoppingStats, type CommuteStats, type ShoppingDemandStats } from './citizens';
import { DEFAULT_GAME_HOUR_NS, createSimClock, defaultCity, type City } from './city';
import { CityFields } from './cityFields';
import { CivicCoverage } from './civicCoverage';
import { Emergencies } from './emergencies';
import { Fleet } from './fleet';
import { BusRoutes } from './transit/buses';
import { ClassDemand, emptyDemand, type RciDemand } from './demand';
import { BudgetLedger, ECONOMY_CONFIG, Loans, ServiceFunding, TaxRates, type EconomyConfig } from './economy/economy';
import { emptyEmploymentStats, type EmploymentStats } from './employment';
import { LandValueIndex } from './landValue';
import { PollutionIndex } from './pollution';
import { ServiceCoverageIndex } from './services/coverage';
import { UtilityNetwork, UtilitySupply } from './utilities';
import type { GameCommand } from './commands';
import { emptyEvents, type TickEvents } from './events';
import { IntersectionIndex } from './intersections/index';
import { DEFAULT_MAP_CONFIG, type MapConfig } from './map/coords';
import { DirtyTiles } from './map/dirty';
import { MapGrid } from './map/grid';
import { COMMAND_HISTORY_LIMIT, CommandHistory } from './map/history';
import { DistrictTimes } from './meso/districts';
import { MesoGraph } from './meso/graph';
import { MesoTraffic } from './meso/traffic';
import { Milestones } from './milestones';
import { Notifications } from './notifications';
import { Parking, defaultCitizenConfig, type CitizenConfig } from './parking';
import { PedestrianGraph, defaultPedestrianConfig, type PedestrianConfig } from './pedestrians/graph';
import { RegionalTrips, defaultRegionalConfig, type RegionalConfig } from './regional';
import { DEFAULT_RNG_SEED, stdRngSeedFromU64, type StdRng } from './rng';
import type { AppState, PendingState } from './state';
import { Timer } from './timer';
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
import type { TripRequested } from './events';
import type { RouteInvalidation } from './traffic/reroute';
import { emptyMotionStats, type VehicleMotionStats } from './traffic/stuck';
import { RegionGraph } from './transport/regionGraph';
import { RoadGraph } from './transport/roadGraph';

export { VEHICLE_CAPACITY, type VehicleLayers } from './traffic/vehicles';

/** `MapSeed(1)` inserted by `init_map_grid` at startup. */
export const STARTUP_MAP_SEED = 1n;
/** `BuildingUpgradeClock`: every five game hours (Rust: five seconds of a clock of a second an hour). */
export const BUILDING_UPGRADE_GAME_HOURS = 5;

/** A system that threw: the world went on without it for those ticks. */
export interface SystemError {
  readonly system: string;
  count: number;
  readonly firstTick: number;
  lastTick: number;
  message: string;
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
  readonly roadGraph: RoadGraph;
  readonly regionGraph: RegionGraph;
  /** Carriageway links between boxes, for meso traffic and the district times. */
  meso: MesoGraph;
  /** Car travel times between districts of 16×16 tiles. */
  readonly districtTimes: DistrictTimes;
  /** The cars of citizens, queued on the meso links. */
  mesoTraffic: MesoTraffic;
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
  readonly routeProducerStats: {
    guardRefusals: number;
    swapBreakHandbuilt: number;
    stuckLanelet: number;
    stuckRoadFallback: number;
    /** Route searches recovery ran for stuck vehicles, successful or not. */
    stuckReplanAttempts: number;
    spawnLanelet: number;
    spawnRoadFallback: number;
  };
  /** Car trips no tick could serve yet (plan budget, vehicle cap, jam), oldest first. */
  readonly tripBacklog: TripRequested[];
  /** `VehicleMotionStats`, written by `trackVehicleMotion` (observability). */
  motionStats: VehicleMotionStats;
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
  /** Active `PedestrianCrossing`s: the walkers on a box, by intersection and axis, rebuilt by `moveWalkers`. */
  readonly pedestrianCrossings: Array<{ readonly intersectionId: number; readonly axisNs: boolean }>;
  /** Bumps whenever `moveWalkers` rebuilds the crossings, so their readers need not look at every one each tick. */
  pedestrianCrossingsVersion: number;
  /** Where walkers may walk, keyed on the graph version. */
  pedestrianGraph: PedestrianGraph;
  readonly pedestrianConfig: PedestrianConfig;
  /** `invalidate_routes_on_graph_change` locals: the graph version last seen and an unfinished sweep. */
  readonly routeInvalidation: RouteInvalidation;
  /** Fixed ticks run since the world was created. */
  tick: number;
  appState: AppState;
  /** `NextState<AppState>`, applied at the start of the next frame. */
  nextState: PendingState | null;
  mapSeed: bigint;
  city: City;
  /** Length of a game hour at ×1: a real hour, shorter only in tests that run days in a hurry. */
  readonly gameHourNs: number;
  /** Micro traffic runs in this world: its lane graph and lanelets are built. The metropolis drives by meso only. */
  microTraffic: boolean;
  /** The map edit and the buildings `despawnInvalidBuildings` last checked against. */
  readonly buildingsChecked: { mapEditVersion: number; buildingsVersion: number };
  /** Systems that threw, by name; the worker never dies of one. */
  readonly systemErrors: Map<string, SystemError>;
  /** A system made to throw on every tick, for resilience checks; `null` in play. */
  debugFailSystem: string | null;
  readonly clock: Timer;
  readonly buildingUpgradeClock: Timer;
  readonly notifications: Notifications;
  /** `Milestones`: the largest population the city has reached, and so what it has opened. */
  readonly milestones: Milestones;
  simRng: StdRng;
  growthRng: StdRng;
  events: TickEvents;
  pendingEvents: TickEvents;
  /** Commands queued for the next `CommandApply`. */
  commands: GameCommand[];
  /** The `Building` entities, in spawn order. */
  readonly buildings: Buildings;
  utilityNetwork: UtilityNetwork;
  readonly utilitySupply: UtilitySupply;
  /** `RciDemand`, computed every tick. */
  rciDemand: RciDemand;
  /** `ClassDemand`: the same per wealth class. */
  readonly classDemand: ClassDemand;
  /** `CityFields`; computed from stage 3c on, unmeasured until then. */
  cityFields: CityFields;
  /** `LandValueIndex`, 64 tiles a tick. */
  readonly landValue: LandValueIndex;
  /** `PollutionIndex`, 32 tiles a tick. */
  readonly pollution: PollutionIndex;
  /** `EconomyConfig`: a constant until the RON loader; tests replace it whole. */
  economyConfig: EconomyConfig;
  /** `BudgetLedger`: every dollar in or out of the treasury is a line of it. */
  readonly budget: BudgetLedger;
  taxRates: TaxRates;
  serviceFunding: ServiceFunding;
  loans: Loans;
  /** `ServiceCoverageIndex`, derived from the stations, the map and the funding. */
  serviceCoverage: ServiceCoverageIndex;
  /** How strongly schools, universities and parks reach each tile. */
  civicCoverage: CivicCoverage;
  /** The city's own vehicles: those of its service stations and its buses. */
  fleet: Fleet;
  /** The routes the buses loop. */
  readonly busRoutes: BusRoutes;
  /** Fires, crimes and medical calls under way, and how the city fared with them. */
  emergencies: Emergencies;
  /** The citizens, as typed arrays by slot. */
  readonly citizens: Citizens;
  /** How citizens get about: walking reach, parking reach. */
  readonly citizenConfig: CitizenConfig;
  /** The spots the cars of citizens hold. */
  readonly parking: Parking;
  /** The commuters, visitors, through traffic and trucks of the region. */
  readonly regional: RegionalTrips;
  /** How much of each flow the region sends. */
  readonly regionalConfig: RegionalConfig;
  employmentStats: EmploymentStats;
  shoppingStats: ShoppingDemandStats;
  commuteStats: CommuteStats;
}

export interface WorldOptions {
  /** Map size in tiles; the game uses `MapConfig::default()`, tests use small maps. */
  readonly mapWidth?: number;
  readonly mapHeight?: number;
  /** A game hour at ×1; a real minute unless a test runs days in a hurry. */
  readonly gameHourNs?: number;
  /** Whether micro traffic runs (the default). */
  readonly microTraffic?: boolean;
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
    meso: new MesoGraph(),
    districtTimes: new DistrictTimes(),
    mesoTraffic: new MesoTraffic(),
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
    routeProducerStats: { guardRefusals: 0, swapBreakHandbuilt: 0, stuckLanelet: 0, stuckRoadFallback: 0, stuckReplanAttempts: 0, spawnLanelet: 0, spawnRoadFallback: 0 },
    tripBacklog: [],
    motionStats: emptyMotionStats(),
    laneletStallTracker: new Map(),
    approachFairness: new Map(),
    arbiterIndexCache: new ArbiterIndexCache(),
    arbiterStats: emptyArbiterStats(),
    ringTopology: { clustersWithoutOpenExit: 0, lastVersion: 0 },
    pedestrianCrossings: [],
    pedestrianCrossingsVersion: 0,
    pedestrianGraph: new PedestrianGraph(),
    pedestrianConfig: defaultPedestrianConfig(),
    routeInvalidation: { lastSeen: null, sweepPending: false },
    tick: 0,
    appState: 'MainMenu',
    nextState: null,
    mapSeed: STARTUP_MAP_SEED,
    city: defaultCity(),
    gameHourNs: options.gameHourNs ?? DEFAULT_GAME_HOUR_NS,
    microTraffic: options.microTraffic ?? true,
    buildingsChecked: { mapEditVersion: -1, buildingsVersion: -1 },
    systemErrors: new Map(),
    debugFailSystem: null,
    clock: createSimClock(options.gameHourNs ?? DEFAULT_GAME_HOUR_NS),
    buildingUpgradeClock: new Timer(BUILDING_UPGRADE_GAME_HOURS * (options.gameHourNs ?? DEFAULT_GAME_HOUR_NS), 'Repeating'),
    notifications: new Notifications(),
    milestones: new Milestones(),
    simRng: stdRngSeedFromU64(DEFAULT_RNG_SEED),
    growthRng: stdRngSeedFromU64(DEFAULT_RNG_SEED),
    events: emptyEvents(),
    pendingEvents: emptyEvents(),
    commands: [],
    buildings: new Buildings(),
    utilityNetwork: new UtilityNetwork(),
    utilitySupply: new UtilitySupply(),
    rciDemand: emptyDemand(),
    classDemand: new ClassDemand(),
    cityFields: new CityFields(),
    landValue: new LandValueIndex(),
    pollution: new PollutionIndex(),
    economyConfig: ECONOMY_CONFIG,
    budget: new BudgetLedger(),
    taxRates: new TaxRates(),
    serviceFunding: new ServiceFunding(),
    loans: new Loans(),
    serviceCoverage: new ServiceCoverageIndex(),
    civicCoverage: new CivicCoverage(),
    fleet: new Fleet(),
    busRoutes: new BusRoutes(),
    emergencies: new Emergencies(),
    citizens: new Citizens(mapConfig.width, mapConfig.height),
    citizenConfig: defaultCitizenConfig(),
    parking: new Parking(grid.len()),
    regional: new RegionalTrips(),
    regionalConfig: defaultRegionalConfig(),
    employmentStats: emptyEmploymentStats(),
    shoppingStats: emptyShoppingStats(),
    commuteStats: emptyCommuteStats(),
  };
}
