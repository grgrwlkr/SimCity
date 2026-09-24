// What a load holds a save against beyond the fresh world: what its `null`s may become and what the elements of its
// collections look like. Each sample is the shape of the type the field is declared with.
import { newBuilding } from '../buildings/building';
import { BudgetLines } from '../economy/economy';
import type { StdRng } from '../rng';
import { CityCommuteScenario } from '../scenarios/cityCommute';
import { CitizenTripCounter, LivingCityScenario } from '../scenarios/livingCity';
import { MetropolisScenario } from '../scenarios/metropolis';
import { SignalizedCrossScenario } from '../scenarios/signalizedCross';
import { NullOr, type DecodeRules } from './codec';

const tile = () => ({ x: 0, y: 0 });

/**
 * The fields a fresh world holds as `null`, with the shape each takes once the world runs. A `null` field missing here
 * must stay `null` in a save: a new one shows up in the save tests as soon as the test world fills it in.
 */
export const NULLABLE_FIELDS: DecodeRules['nullable'] = {
  // Graphs and the versions they were built for: hashed by the fingerprint and bound to the saved graph, so loaded.
  'MesoGraph.builtFor': 0,
  'MesoTraffic.linksFor': 0,
  'LaneGraph.builtFor': 0,
  'LaneGraph.builtDims': [0, 0],
  'LaneletGraph.builtFor': 0,
  'LaneletGraph.builtDims': [0, 0],
  'PedestrianGraph.builtFor': 0,
  'BudgetLedger.last': { month: 0, moneyStart: 0, moneyEnd: 0, lines: new BudgetLines() },
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
  'SignalizedCrossScenario.routes': [],
};

/** The classes of `ScenarioRuntime`, by their save names: the only ones a save may hold as the running scenario. */
export const SCENARIO_RUNTIMES: readonly string[] = ['CitizenTripCounter', 'LivingCityScenario', 'MetropolisScenario', 'CityCommuteScenario', 'SignalizedCrossScenario'];

/**
 * An instance of each scenario runtime with every field it saves, built without a world (their constructors build a
 * city into one): a runtime in a save is held to its class's fields. `rng` is a generator of the fresh world.
 */
export function runtimeSamples(rng: StdRng): Map<string, object> {
  const sample = (cls: { readonly prototype: object }, fields: object): object => Object.assign(Object.create(cls.prototype) as object, fields);
  const counter = { requested: 0, arrived: 0, lastTick: 0 };
  return new Map([
    ['CitizenTripCounter', sample(CitizenTripCounter, counter)],
    ['LivingCityScenario', sample(LivingCityScenario, counter)],
    ['MetropolisScenario', sample(MetropolisScenario, { ...counter, plan: { lights: [], first: 0, last: 0 } })],
    ['CityCommuteScenario', sample(CityCommuteScenario, { requested: 0, arrived: 0, rng, commuters: [], stayTicks: [0, 0], lastTick: 0 })],
    ['SignalizedCrossScenario', sample(SignalizedCrossScenario, { spawned: 0, routes: null, nextWaveTick: 0, wave: 0, spawnEvery: 0, layout: 'twoLane' })],
  ]);
}

/** A building as `newBuilding` makes it; its phase is a union and any of its shapes passes. */
const building = {
  ...newBuilding({ kind: 'Residential', anchor: tile() }),
  phase: new NullOr(undefined),
  profile: { density: 'Medium', class: 'Middle' },
  noRoadAccessDecay: new NullOr({ accessLostDay: 0 }),
  lowHappinessDecay: new NullOr({ decayStartDay: 0, avgHappiness: 0 }),
  economicDecay: new NullOr({ decayStartDay: 0, cumulativeLosses: 0 }),
};

/** Templates for the elements of collections, by the collection's path. */
export const ELEMENT_TEMPLATES: DecodeRules['elements'] = {
  'world.buildings.list': building,
  'world.buildings.byId': building,
  // Every `ScenarioObjective` is a kind and a target.
  'world.scenario.objectives': { kind: 'PopulationAtLeast', target: 0 },
  'world.scenario.met': false,
  'world.scenarioRuntime.commuters': { home: tile(), work: tile(), atWork: false, driving: false, departAt: 0 },
  'world.scenarioRuntime.plan.lights': tile(),
};
