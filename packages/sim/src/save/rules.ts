// What a load holds a save against beyond the fresh world: what its `null`s may become and what the elements of its
// collections look like. Each sample is the shape of the type the field is declared with. The strictness is structural
// (w6 decision 21:13): a value has its type's fields and kinds, a union's value is one of its variants and a string of
// a literal union one of its strings; numbers are not held to ranges.
import { PROBLEM_KINDS } from '../advisor';
import { newBuilding } from '../buildings/building';
import { CIVIC_KINDS } from '../civicCoverage';
import { BUILDING_KINDS, LANE_TYPES, ROAD_DIRS, ROAD_KINDS, ZONE_DENSITIES, ZONE_KINDS } from '../commands';
import { BudgetLines, LOAN_SIZES, TAX_ZONES } from '../economy/economy';
import { WEALTH_CLASSES } from '../economy/wealth';
import { EMERGENCY_KINDS } from '../emergencies';
import type { StdRng } from '../rng';
import { CityCommuteScenario } from '../scenarios/cityCommute';
import { CitizenTripCounter, LivingCityScenario } from '../scenarios/livingCity';
import { MetropolisScenario } from '../scenarios/metropolis';
import { SignalizedCrossScenario } from '../scenarios/signalizedCross';
import { SERVICE_KINDS } from '../services/stations';
import { SERVICE_VEHICLE_STATES } from '../services/vehicles';
import { LIGHT_PHASES } from '../traffic/lights';
import { MANEUVER_KINDS } from '../traffic/maneuver';
import { IntersectionLedger } from '../traffic/reservations';
import { TRIP_PURPOSES } from '../traffic/vehicles';
import { BUS_STATES } from '../transit/buses';
import { ConflictMatrix } from '../transport/lanelet/conflict';
import { UTILITY_KINDS } from '../utilities';
import { ListOf, Literal, MapOf, NullOr, OneOf, Optional, SetOf, TupleOf, type DecodeRules } from './codec';

const tile = () => ({ x: 0, y: 0 });
const tiles = () => new ListOf(tile());
const numbers = () => new ListOf(0);
const numberMap = () => new MapOf(0, 0);
const oneOf = (values: readonly string[]) => new Literal(values);

const roadCell = () => ({
  kind: oneOf(ROAD_KINDS),
  dir: oneOf(ROAD_DIRS),
  lane: 0,
  flow: new OneOf('kind', { TwoWay: { kind: 'TwoWay' }, OneWay: { kind: 'OneWay', dir: oneOf(ROAD_DIRS) } }),
  laneType: oneOf(LANE_TYPES),
});

/** A building as `newBuilding` makes it, its phase one of `BuildingPhase`. */
const building = {
  ...newBuilding({ kind: 'Residential', anchor: tile() }),
  kind: oneOf(BUILDING_KINDS),
  phase: new OneOf('kind', { UnderConstruction: { kind: 'UnderConstruction', hoursRemaining: 0 }, Operational: { kind: 'Operational' } }),
  profile: { density: 'Medium', class: 'Middle' },
  noRoadAccessDecay: new NullOr({ accessLostDay: 0 }),
  lowHappinessDecay: new NullOr({ decayStartDay: 0, avgHappiness: 0 }),
  economicDecay: new NullOr({ decayStartDay: 0, cumulativeLosses: 0 }),
};

/** `GameCommand`, a variant for each kind. */
const gameCommand = new OneOf('kind', {
  GenerateMap: { kind: 'GenerateMap', seed: 0n },
  SetRoad: { kind: 'SetRoad', pos: tile(), road: roadCell() },
  SetZone: { kind: 'SetZone', pos: tile(), zone: oneOf(ZONE_KINDS), density: oneOf(ZONE_DENSITIES) },
  PlaceBuilding: { kind: 'PlaceBuilding', pos: tile(), building: oneOf(BUILDING_KINDS) },
  EraseTile: { kind: 'EraseTile', pos: tile() },
  DumpSaveContract: { kind: 'DumpSaveContract' },
  SaveGame: { kind: 'SaveGame', slot: 0 },
  LoadGame: { kind: 'LoadGame', slot: 0 },
  PlaceTrafficLight: { kind: 'PlaceTrafficLight', pos: tile() },
  RemoveTrafficLight: { kind: 'RemoveTrafficLight', pos: tile() },
  LoadTestCity: { kind: 'LoadTestCity' },
  AdjustTaxRate: { kind: 'AdjustTaxRate', zone: oneOf(TAX_ZONES), wealth: oneOf(WEALTH_CLASSES), delta: 0 },
  AdjustServiceFunding: { kind: 'AdjustServiceFunding', service: oneOf(SERVICE_KINDS), delta: 0 },
  TakeLoan: { kind: 'TakeLoan', principal: LOAN_SIZES[0] },
});

/** `UndoableCommand`: what an undo or redo step keeps. */
const undoStep = new OneOf('kind', {
  SetRoad: { kind: 'SetRoad', pos: tile(), old: roadCell(), new: roadCell() },
  SetZone: { kind: 'SetZone', pos: tile(), old: oneOf(ZONE_KINDS), new: oneOf(ZONE_KINDS), oldDensity: oneOf(ZONE_DENSITIES), newDensity: oneOf(ZONE_DENSITIES) },
  PlaceBuilding: { kind: 'PlaceBuilding', pos: tile(), building: oneOf(BUILDING_KINDS), oldZones: new ListOf(new TupleOf([tile(), oneOf(ZONE_KINDS)])) },
  EraseTile: { kind: 'EraseTile', pos: tile(), oldRoad: roadCell(), oldZone: oneOf(ZONE_KINDS), oldBuilding: new NullOr(building) },
});

/** `VehicleTrafficState`. */
const trafficState = new OneOf('kind', {
  FreeFlow: { kind: 'FreeFlow' },
  Approaching: { kind: 'Approaching', intersection: '', stopTile: tile(), distanceToStop: 0 },
  Stopped: { kind: 'Stopped', intersection: '', stopTile: tile(), queuePosition: 0 },
  WaitingForGreen: { kind: 'WaitingForGreen', intersection: '', stopTile: tile() },
  Accelerating: { kind: 'Accelerating' },
  CrossingIntersection: { kind: 'CrossingIntersection', intersection: '' },
});

/** `TripRequested`: a car of the pocket and a vehicle other than a car are fields a trip may leave out. */
const tripRequested = {
  citizen: 0,
  from: tile(),
  carParkedAt: new NullOr(tile()),
  to: tile(),
  purpose: oneOf(TRIP_PURPOSES),
  mode: oneOf(['Walk', 'Car']),
  pocket: new Optional(true),
  vehicle: new Optional(oneOf(['Truck', 'Bus', 'Fire', 'Police', 'Ambulance'])),
};

const tickEvents = (path: string) => ({
  [`${path}.hourAdvanced`]: new ListOf({ hour: 0, day: 0 }),
  [`${path}.dayAdvanced`]: numbers(),
  [`${path}.tripRequested`]: new ListOf(tripRequested),
  [`${path}.tripFinished`]: new ListOf({ citizen: 0, purpose: oneOf(TRIP_PURPOSES) }),
  [`${path}.walksFinished`]: numbers(),
  [`${path}.tripDropped`]: numbers(),
});

/**
 * The fields a fresh world holds as `null`, with the shape each takes once the world runs. A `null` field missing here
 * must stay `null` in a save: a new one shows up in the save tests as soon as the test world fills it in.
 */
export const NULLABLE_FIELDS: DecodeRules['nullable'] = {
  // Graphs and the versions they were built for: hashed by the fingerprint and bound to the saved graph, so loaded.
  'MesoGraph.builtFor': 0,
  'MesoTraffic.linksFor': 0,
  'LaneGraph.builtFor': 0,
  'LaneGraph.builtDims': new TupleOf([0, 0]),
  'LaneletGraph.builtFor': 0,
  'LaneletGraph.builtDims': new TupleOf([0, 0]),
  'PedestrianGraph.builtFor': 0,
  'BudgetLedger.last': { month: 0, moneyStart: 0, moneyEnd: 0, lines: new BudgetLines() },
  'IntersectionLedger.coarseHeld': 0,
  'world.routeInvalidation.lastSeen': 0,
  'world.trafficIndex.maxCongestionTile': tile(),
  'world.motionStats.worstTile': tile(),
  'world.nextState': { state: 'InGame', ifNeq: false },
  'world.debugFailSystem': '',
  'world.scenario.activeId': '',
  'world.scenario.activeName': '',
  // One of `SCENARIO_RUNTIMES`, held to the fields of its sample in `runtimeSamples`; the loader refuses any other.
  'world.scenarioRuntime': undefined,
  // Its routes are found once the lanelets are built.
  'SignalizedCrossScenario.routes': new ListOf(new ListOf({ tiles: tiles(), sidecar: new ListOf(new TupleOf([0, 0, 0])) })),
};

/** The classes of `ScenarioRuntime`, by their save names: the only ones a save may hold as the running scenario. */
export const SCENARIO_RUNTIMES: readonly string[] = ['CitizenTripCounter', 'LivingCityScenario', 'MetropolisScenario', 'CityCommuteScenario', 'SignalizedCrossScenario'];

const sample = (cls: { readonly prototype: object }, fields: object): object => Object.assign(Object.create(cls.prototype) as object, fields);

/**
 * An instance of each scenario runtime with every field it saves, built without a world (their constructors build a
 * city into one): a runtime in a save is held to its class's fields. `rng` is a generator of the fresh world.
 */
export function runtimeSamples(rng: StdRng): Map<string, object> {
  const counter = { requested: 0, arrived: 0, lastTick: 0 };
  return new Map([
    ['CitizenTripCounter', sample(CitizenTripCounter, counter)],
    ['LivingCityScenario', sample(LivingCityScenario, counter)],
    ['MetropolisScenario', sample(MetropolisScenario, { ...counter, plan: { lights: [], first: 0, last: 0 } })],
    ['CityCommuteScenario', sample(CityCommuteScenario, { requested: 0, arrived: 0, rng, commuters: [], stayTicks: new TupleOf([0, 0]), lastTick: 0 })],
    ['SignalizedCrossScenario', sample(SignalizedCrossScenario, { spawned: 0, routes: null, nextWaveTick: 0, wave: 0, spawnEvery: 0, layout: 'twoLane' })],
  ]);
}

/** An instance of each saved class a fresh world holds none of but a running one does, with the shapes of its fields. */
export const CLASS_SAMPLES: ReadonlyMap<string, object> = new Map([
    [
      'ConflictMatrix',
      sample(ConflictMatrix, {
        rows: new ListOf(new Uint32Array(0)),
        semantic: new ListOf(new Uint32Array(0)),
        yields: new ListOf(new Uint32Array(0)),
        pathTiles: new ListOf(numbers()),
        waits: numbers(),
        n: 0,
        base: 0,
        tileTotal: 0,
      }),
    ],
    [
      'IntersectionLedger',
      sample(IntersectionLedger, {
        holdList: new ListOf({ vehicle: 0, localIdx: 0, tiles: numbers(), from: 0, limit: 0, since: 0 }),
        occupied: numbers(),
        semanticHeld: numbers(),
        pedMask: numbers(),
        inboxTiles: numbers(),
        builtFor: 0,
        coarseHeld: null,
      }),
    ],
]);

/** The shapes of collections, by the collection's path or as `Class.field`. */
export const ELEMENT_TEMPLATES: DecodeRules['elements'] = {
  'world.buildings.list': new ListOf(building),
  'world.buildings.byId': new MapOf(0, building),
  // Every `ScenarioObjective` is a kind and a target.
  'world.scenario.objectives': new ListOf({ kind: 'PopulationAtLeast', target: 0 }),
  'world.scenario.met': new ListOf(false),
  'world.scenarioRuntime.commuters': new ListOf({ home: tile(), work: tile(), atWork: false, driving: false, departAt: 0 }),
  'world.scenarioRuntime.plan.lights': new ListOf(tile()),

  // The unions: queued commands, undo and redo steps, traffic states, trips and the events of a tick.
  'world.commands': new ListOf(gameCommand),
  'CommandHistory.undoStack': new ListOf(undoStep),
  'CommandHistory.redoStack': new ListOf(undoStep),
  'world.undoRedo': new ListOf(false),
  'world.vehicles.trafficState': new ListOf(trafficState),
  'world.vehicles.laneletPlan': new ListOf({ entries: new ListOf(new TupleOf([0, 0, 0])), builtFor: 0 }),
  'world.vehicles.order': numbers(),
  'world.vehicles.free': numbers(),
  'world.tripBacklog': new ListOf(tripRequested),
  'MesoTraffic.pending': new ListOf(tripRequested),
  ...tickEvents('world.events'),
  ...tickEvents('world.pendingEvents'),

  // Emergencies, the city's vehicles and its buses.
  'Emergencies.active': new ListOf({
    id: 0,
    kind: oneOf(EMERGENCY_KINDS),
    pos: tile(),
    road: new NullOr(tile()),
    severity: 0,
    responded: false,
    resolved: false,
    consequenceApplied: false,
    failed: false,
    timeRemaining: 0,
    resolutionProgress: 0,
    assignedVehicle: 0,
    triedStations: numbers(),
  }),
  'Fleet.services': new ListOf({ id: 0, kind: oneOf(SERVICE_KINDS), station: 0, homeRoad: tile(), state: oneOf(SERVICE_VEHICLE_STATES), mission: 0, at: tile() }),
  'Fleet.buses': new ListOf({ id: 0, route: 0, stop: 0, state: oneOf(BUS_STATES), until: 0, skips: 0, at: tile() }),
  'BusRoutes.routes': new ListOf({ id: 0, stops: tiles() }),

  // Meso traffic.
  'MesoTraffic.freeSlots': numbers(),
  'MesoTraffic.routes': new ListOf(new Int32Array(0)),
  'MesoTraffic.routeCache': new MapOf(0, new NullOr(new Int32Array(0))),
  'MesoTraffic.boxBusyUntil': numberMap(),
  'LinkHeap.keys': numbers(),
  'LinkHeap.links': numbers(),
  'DistrictTimes.entries': new ListOf(new Int32Array(0)),

  // Micro traffic: lights, intersections, lanes, lanelets, reservations, paths.
  'world.trafficLights': new ListOf({
    intersectionId: 0,
    intersectionKey: '',
    pos: tile(),
    phase: oneOf(LIGHT_PHASES),
    phaseTimer: 0,
    greenDuration: 0,
    yellowDuration: 0,
    allRedDuration: 0,
  }),
  'world.leftTurnDemand.ns': new SetOf(0),
  'world.leftTurnDemand.ew': new SetOf(0),
  'world.laneletStallTracker': numberMap(),
  'world.approachFairness': new MapOf('', 0),
  'world.pedestrianCrossings': new ListOf({ intersectionId: 0, axisNs: false }),
  'IntersectionIndex.clusters': new ListOf({
    id: 0,
    key: { aabbMin: tile(), aabbMax: tile(), tileCount: 0, tilesHash: 0n },
    tiles: tiles(),
    aabbMin: tile(),
    aabbMax: tile(),
    centroidTile: tile(),
  }),
  'IntersectionIndex.tileToIntersection': numberMap(),
  'IntersectionIndex.trafficLights': new SetOf(0),
  'IntersectionIndex.trafficLightKeys': new SetOf(''),
  'LaneGraph.lanes': new ListOf({ id: 0, pos: tile(), laneIdx: 0, dir: oneOf(ROAD_DIRS), kind: oneOf(ROAD_KINDS) }),
  'LaneGraph.posToId': numberMap(),
  'LaneGraph.tileLaneToId': new MapOf('', 0),
  'LaneletGraph.lanelets': new ListOf({ id: 0, intersection: 0, entryLane: 0, exitLane: 0, maneuver: oneOf(MANEUVER_KINDS), internalPath: tiles() }),
  'LaneletGraph.byIntersection': new MapOf(0, numbers()),
  'LaneletGraph.byEntryLane': new MapOf(0, numbers()),
  'LaneletConflictMatrices.byIntersection': new MapOf(0, CLASS_SAMPLES.get('ConflictMatrix')),
  'LaneletConflictMatrices.crosswalkSides': new MapOf(0, new ListOf(oneOf(ROAD_DIRS))),
  'ArbiterIndexCache.localIdx': new MapOf(0, numberMap()),
  'IntersectionReservations.byIntersection': new MapOf(
    0,
    new ListOf({ vehicle: 0, state: oneOf(['Approaching', 'Inside']), createdAtSec: 0, maneuver: oneOf(MANEUVER_KINDS), localIdx: new NullOr(0), coarse: false }),
  ),
  'IntersectionReservations.ledgers': new MapOf(0, CLASS_SAMPLES.get('IntersectionLedger')),
  'TrafficSpatialIndex.entries': new ListOf({ vehicle: 0, progress: 0, speed: 0 }),
  'TrafficSpatialIndex.touched': numbers(),
  'TrafficSpatialIndex.leaderSame': new MapOf(0, new TupleOf([0, 0])),
  'TrafficSpatialIndex.leaderSameProgress': numberMap(),
  'TrafficOccupancy.touched': numbers(),
  'PathCache.map': new MapOf('', { path: tiles(), lastUsedSec: 0 }),
  'PathCache.lru': new ListOf(new TupleOf(['', 0])),
  'PathPool.entries': new ListOf({ path: tiles(), key: '', refcount: 0, version: 0 }),
  'PathPool.freeSlots': numbers(),
  'PathPool.dedup': new MapOf('', numbers()),
  'RoadGraph.roadIndices': numbers(),
  'DirtyTiles.list': numbers(),

  // Citizens, their queues, parking and the region.
  'Citizens.freeSlots': numbers(),
  'Citizens.unplanned': numbers(),
  'Citizens.jobSeekers': numbers(),
  'Citizens.walkerList': numbers(),
  'Citizens.residents': numberMap(),
  'Citizens.workers': numberMap(),
  'MinuteQueue.buckets': new MapOf(0, numbers()),
  'MinuteQueue.heap': numbers(),
  'Parking.buildings': numberMap(),
  'Parking.buildingBuckets': new ListOf(numbers()),
  'Parking.streetBuckets': new ListOf(numbers()),
  'RegionalTrips.freeSlots': numbers(),

  // The city: its fields, coverage, supply, budget, loans, advice and feed.
  'CityFields.layers': new MapOf('', new Float32Array(0)),
  'CivicCoverage.strength': new ListOf(new Float32Array(0)),
  'CivicCoverage.sources': new ListOf({ kind: oneOf(CIVIC_KINDS), anchor: tile(), capacity: 0, residents: 0, strength: 0 }),
  'UtilitySupply.components': new ListOf({ kind: oneOf(UTILITY_KINDS), supply: 0, demand: 0, supplied: 0 }),
  'BudgetLines.amounts': new MapOf('', 0),
  'Loans.active': new ListOf({ principal: 0, monthlyPayment: 0, monthsLeft: 0 }),
  'Advisor.problems': new ListOf({ kind: oneOf(PROBLEM_KINDS), severity: 0, text: '', at: new NullOr(tile()) }),
  'Notifications.lines': new ListOf({ day: 0, text: '', kind: oneOf(['Info', 'Warning', 'Error', 'Achievement']), count: 0 }),
  'Notifications.toasts': new ListOf({ text: '', kind: oneOf(['Info', 'Warning', 'Error', 'Achievement']), count: 0, at: new NullOr(tile()), duration: 0 }),
  'world.systemErrors': new MapOf('', { system: '', count: 0, firstTick: 0, lastTick: 0, message: '' }),
};
