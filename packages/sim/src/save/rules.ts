// What a load holds a save against beyond the fresh world: what its `null`s may become and what the elements of its
// collections look like. Each sample is the shape of the type the field is declared with.
import { newBuilding } from '../buildings/building';
import { BudgetLines } from '../economy/economy';
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
};

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
};
