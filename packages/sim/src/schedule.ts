// Order of systems is data: the position in the array is the execution order (Rust: `GameSet`
// chained with its `SimStep` / `TrafficStep` / `PostSimStep` sub-sets). A new system takes a
// concrete position with a comment saying what it runs after and what it reads.
import { reportBuildingsWithoutPower } from './buildings/blockers';
import { updateConstructionProgress } from './buildings/construction';
import { buildingDecayEconomic, buildingDecayLowHappiness, buildingDecayNoRoadAccess, despawnInvalidBuildings } from './buildings/decay';
import { growBuildings } from './buildings/growth';
import { updateOccupancy } from './buildings/occupancy';
import { updateCityPopulation } from './buildings/population';
import { upgradeBuildings } from './buildings/upgrade';
import { citizenTripPlanner, cleanupHomelessCitizens, handleTripFinished, planCitizenBacklog, recoverStuckTrips, spawnCitizensFromResidential } from './citizens';
import { simTick } from './city';
import type { GameCommand } from './commands';
import { computeRciDemand } from './demand';
import { applyDailyEconomy } from './economy/economy';
import { assignJobs, clearInvalidWorkplaces, computeEmploymentStats } from './employment';
import { updateServiceCoverage } from './services/coverage';
import { beginTickEvents } from './events';
import { detectIntersections } from './intersections/index';
import { computeLandValue } from './landValue';
import { applyGameCommandsToGrid } from './map/apply';
import { updateDistrictTimes } from './meso/districts';
import { rebuildMesoGraph } from './meso/graph';
import { runMesoTraffic } from './meso/traffic';
import { handleRegionalArrivals, planRegionalTrips } from './regional';
import { computePollution } from './pollution';
import { resetGrowthRngOnNewMap, resetSimRngOnNewMap } from './seeding';
import { ALL_STATES, IN_GAME, IN_GAME_OR_PAUSED, type AppState } from './state';
import { SECOND_NS } from './timer';
import { arbitrateLaneletReservations, checkRingFreeTopology, nudgeLaneletStallReroute } from './traffic/arbiter';
import { cleanupRightOnRedMarkers, moveVehicles } from './traffic/drive';
import { clearVehicles } from './traffic/lifecycle';
import { handleTrafficLightCommands, syncTrafficLights, updateTrafficLights } from './traffic/lights';
import { updateTrafficIndex, updateTrafficOccupancy } from './traffic/occupancy';
import { invalidateRoutesOnGraphChange } from './traffic/reroute';
import { cleanupIntersectionReservations } from './traffic/reservations';
import { assignVehicleSeq } from './traffic/seq';
import { spawnTripVehicles } from './traffic/spawn';
import { initStuckTimers, resolveStuckVehicles, trackVehicleMotion, updateStuckTimers } from './traffic/stuck';
import { buildTrafficSpatialIndex } from './traffic/spatialIndex';
import { updateVehicleTrafficState } from './traffic/state';
import { breakTileSwaps } from './traffic/swapBreak';
import { buildLaneGraph } from './transport/laneGraph';
import { buildLaneletGraph } from './transport/lanelet/build';
import { rebuildRegionGraph } from './transport/regionGraph';
import { rebuildRoadGraph } from './transport/roadGraph';
import { autogenTurnLanes } from './transport/turnLanes';
import { updateUtilityNetwork } from './utilities';
import { WALKER_STEP_NS, moveWalkers } from './walkers';
import type { World } from './world';

export type System = (w: World, dtNs: number) => void;
export type CommandSystem = (w: World, commands: readonly GameCommand[]) => void;

export interface SystemEntry {
  readonly name: string;
  readonly run: System;
  /** `run_if(in_state(...))` as data. */
  readonly runIn: readonly AppState[];
  /**
   * The system runs once per this much game time, on the tick that period completes; every tick when absent. It reads
   * the clock rather than `dtNs`. A tick with nothing for it costs one check.
   */
  readonly everyGameNs?: number;
}

export interface CommandSystemEntry {
  readonly name: string;
  readonly run: CommandSystem;
  readonly runIn: readonly AppState[];
}

export { TICK_DT_NS, TICK_HZ } from './rates';

/** `FixedUpdate`: GraphUpdate → Sim → PostSim. */
export const FIXED_UPDATE: readonly SystemEntry[] = [
  // First, in every state: events written since the last tick become this tick's events.
  { name: 'beginTickEvents', run: beginTickEvents, runIn: ALL_STATES },
  // GraphUpdate (TransportPlugin chain, no state condition). Turn-lane marks first: the road graph
  // caches lane-type-dependent edges for a whole graph version.
  { name: 'autogenTurnLanes', run: autogenTurnLanes, runIn: ALL_STATES },
  // After autogenTurnLanes: reads the lane-type marks.
  { name: 'rebuildRoadGraph', run: rebuildRoadGraph, runIn: ALL_STATES },
  // After rebuildRoadGraph, keyed on the same graph version.
  { name: 'rebuildRegionGraph', run: rebuildRegionGraph, runIn: ALL_STATES },
  // After rebuildRegionGraph, keyed on the same graph version.
  { name: 'buildLaneGraph', run: buildLaneGraph, runIn: ALL_STATES },
  // After buildLaneGraph: resolves approach and exit lanes by tile; reads the intersection clusters.
  { name: 'buildLaneletGraph', run: buildLaneletGraph, runIn: ALL_STATES },
  // After buildLaneletGraph: the meso links and their joins, keyed on the same graph version; reads the clusters.
  { name: 'rebuildMesoGraph', run: rebuildMesoGraph, runIn: ALL_STATES },
  // After rebuildMesoGraph: a few rows of district travel times a tick, the old rows serving until rebuilt.
  { name: 'updateDistrictTimes', run: updateDistrictTimes, runIn: ALL_STATES },
  // After buildLaneletGraph, in game: a graph version bump re-checks active routes against the new grid.
  { name: 'invalidateRoutesOnGraphChange', run: invalidateRoutesOnGraphChange, runIn: IN_GAME },
  // SimStep::Tick — the game clock; writes HourAdvanced / DayAdvanced for every system after it.
  { name: 'simTick', run: simTick, runIn: IN_GAME },
  // SimStep::Citizens, chained as in Rust: the open homes of the last tick fill up first, so the planner may send a
  // new citizen out this tick; its trip requests are read by spawnTripVehicles later in this tick.
  { name: 'spawnCitizensFromResidential', run: spawnCitizensFromResidential, runIn: IN_GAME },
  // After spawnCitizensFromResidential, before the planner: a backlog of thousands without a plan (a city opening lived in)
  // is planned a few thousand a tick instead of all in the planner's minute.
  { name: 'planCitizenBacklog', run: planCitizenBacklog, runIn: IN_GAME },
  // Plans are made in game minutes: once a game minute, on the tick the minute turns (and so on the day's turn too).
  { name: 'citizenTripPlanner', run: citizenTripPlanner, runIn: IN_GAME, everyGameNs: 60 * SECOND_NS },
  // After the citizens' planner, on the same minute: the region's trips set out; traffic spawns them later in this tick.
  { name: 'planRegionalTrips', run: planRegionalTrips, runIn: IN_GAME, everyGameNs: 60 * SECOND_NS },
  // After the planner: a trip requested this tick is never taken for an orphan.
  // Every citizen is looked at: once a game minute, against a timeout of minutes.
  { name: 'recoverStuckTrips', run: recoverStuckTrips, runIn: IN_GAME, everyGameNs: 60 * SECOND_NS },
  // SimStep::Employment: a job goes with its workplace before the unemployed are matched to open ones.
  { name: 'clearInvalidWorkplaces', run: clearInvalidWorkplaces, runIn: IN_GAME, everyGameNs: 60 * SECOND_NS },
  { name: 'assignJobs', run: assignJobs, runIn: IN_GAME },
  // SimStep::Buildings, chained as in Rust: growth on this tick's hour, reading the demand, fields and utility
  // network of the last tick; it produces and levels the buildings the decay pipeline after it scans.
  { name: 'growBuildings', run: growBuildings, runIn: IN_GAME },
  // After growBuildings: the upgrade clock and the same blockers.
  { name: 'upgradeBuildings', run: upgradeBuildings, runIn: IN_GAME },
  // Decay counts days: judged once a game minute.
  { name: 'buildingDecayEconomic', run: buildingDecayEconomic, runIn: IN_GAME, everyGameNs: 60 * SECOND_NS },
  { name: 'buildingDecayLowHappiness', run: buildingDecayLowHappiness, runIn: IN_GAME, everyGameNs: 60 * SECOND_NS },
  // Before buildingDecayNoRoadAccess: records the grid no longer backs are removed before road access is scanned.
  { name: 'despawnInvalidBuildings', run: despawnInvalidBuildings, runIn: IN_GAME },
  { name: 'buildingDecayNoRoadAccess', run: buildingDecayNoRoadAccess, runIn: IN_GAME, everyGameNs: 60 * SECOND_NS },
  // SimStep::Traffic, before the vehicle states that read the phase.
  { name: 'updateTrafficLights', run: updateTrafficLights, runIn: IN_GAME },
  // After updateTrafficLights: walkers wait at a crossing by this tick's lights; the planner of this tick set out the new ones.
  // A second at a time; the renderer draws them on between their seconds.
  { name: 'moveWalkers', run: moveWalkers, runIn: IN_GAME, everyGameNs: WALKER_STEP_NS },
  // TrafficStep::Flow, first: last tick's positions, so routing and the capacity gate see fresh counts.
  { name: 'updateTrafficOccupancy', run: updateTrafficOccupancy, runIn: IN_GAME },
  // After updateTrafficOccupancy and the lights: approach, stop and release states.
  { name: 'updateVehicleTrafficState', run: updateVehicleTrafficState, runIn: IN_GAME },
  // After updateVehicleTrafficState: this tick's trip requests and the backlog become vehicles; plans
  // read the fresh occupancy.
  { name: 'spawnTripVehicles', run: spawnTripVehicles, runIn: IN_GAME },
  // After spawnTripVehicles: the car trips of citizens join meso traffic and its queues move on; handleTripFinished reads
  // its arrivals later in the tick.
  { name: 'runMesoTraffic', run: runMesoTraffic, runIn: IN_GAME },
  // TrafficStep::Movement. Numbers vehicles that appeared since the last tick before any tie-break.
  { name: 'assignVehicleSeq', run: assignVehicleSeq, runIn: IN_GAME },
  // After assignVehicleSeq: per-tile vehicles by progress for the leaders below.
  { name: 'buildTrafficSpatialIndex', run: buildTrafficSpatialIndex, runIn: IN_GAME },
  // After the spatial index: the sole reservation producer; reads routes, lights, pedestrians, seq.
  { name: 'arbitrateLaneletReservations', run: arbitrateLaneletReservations, runIn: IN_GAME },
  // After the arbiter: reads tile occupants and seq.
  { name: 'breakTileSwaps', run: breakTileSwaps, runIn: IN_GAME },
  // After breakTileSwaps: reads the rewritten routes, reservations, occupancy and the spatial index.
  { name: 'moveVehicles', run: moveVehicles, runIn: IN_GAME },
  // After moveVehicles: drops right-on-red markers of vehicles that left the intersection.
  { name: 'cleanupRightOnRedMarkers', run: cleanupRightOnRedMarkers, runIn: IN_GAME },
  // After cleanupRightOnRedMarkers (both only after moveVehicles in Rust): stale and exited holds.
  { name: 'cleanupIntersectionReservations', run: cleanupIntersectionReservations, runIn: IN_GAME },
  // TrafficStep::Recovery, first: vehicles spawned since the last tick get their stuck timer.
  { name: 'initStuckTimers', run: initStuckTimers, runIn: IN_GAME },
  // After moveVehicles: the no-progress and moving streaks from this tick's positions.
  { name: 'trackVehicleMotion', run: trackVehicleMotion, runIn: IN_GAME },
  // After trackVehicleMotion: the stuck timer reads the no-progress streak for its waiting cap.
  { name: 'updateStuckTimers', run: updateStuckTimers, runIn: IN_GAME },
  // After updateStuckTimers, so the bump survives: the mandatory-merge nudge reads the arbiter's stall tracker.
  { name: 'nudgeLaneletStallReroute', run: nudgeLaneletStallReroute, runIn: IN_GAME },
  // Last: re-routes, or as the last resort removes, vehicles stuck past their thresholds.
  { name: 'resolveStuckVehicles', run: resolveStuckVehicles, runIn: IN_GAME },
  // After traffic, which writes this tick's arrivals, removals included: citizens take them in the same tick (Rust read
  // them on the next, a message living two frames).
  { name: 'handleTripFinished', run: handleTripFinished, runIn: IN_GAME },
  // Beside handleTripFinished: the arrivals of the region's trips, which carry negative ids.
  { name: 'handleRegionalArrivals', run: handleRegionalArrivals, runIn: IN_GAME },
  // PostSimStep::Citizens: residents a shrunken or vanished home no longer holds leave, then their parked cars go.
  { name: 'cleanupHomelessCitizens', run: cleanupHomelessCitizens, runIn: IN_GAME, everyGameNs: 60 * SECOND_NS },
  // PostSimStep::TrafficIndex: the end-of-tick metrics RCI demand reads.
  { name: 'updateTrafficIndex', run: updateTrafficIndex, runIn: IN_GAME },
  // PostSimStep::Pollution: one chunk from the open factories of this tick; land value reads it below.
  { name: 'computePollution', run: computePollution, runIn: IN_GAME },
  // PostSimStep::Coverage: after this tick's map edits and buildings; land value and the daily economy read it.
  { name: 'updateServiceCoverage', run: updateServiceCoverage, runIn: IN_GAME },
  // PostSimStep::Utilities: after this tick's buildings and map edits; growth reads it next tick.
  { name: 'updateUtilityNetwork', run: updateUtilityNetwork, runIn: IN_GAME },
  // PostSimStep::LandValue: one chunk from the pollution and coverage above, the traffic heat and the city fields.
  { name: 'computeLandValue', run: computeLandValue, runIn: IN_GAME },
  // PostSimStep::EmploymentStats: after this tick's assignments and departures; demand reads the class gaps.
  { name: 'computeEmploymentStats', run: computeEmploymentStats, runIn: IN_GAME, everyGameNs: 60 * SECOND_NS },
  // PostSimStep::Demand: the employment stats above, this tick's land value, traffic index and shopping; growth reads
  // it on the next tick.
  { name: 'computeRciDemand', run: computeRciDemand, runIn: IN_GAME, everyGameNs: 60 * SECOND_NS },
  // PostSimStep::Economy, last of PostSim: the day's taxes from the occupancy of the day before, upkeep of what is
  // open, happiness from the coverage above.
  { name: 'applyDailyEconomy', run: applyDailyEconomy, runIn: IN_GAME },
  // Rust runs the next four on Update, after the frame's fixed ticks: the day's construction, then occupancy
  // on the network just computed, then the population and the feed line that read the occupancy.
  { name: 'updateConstructionProgress', run: updateConstructionProgress, runIn: IN_GAME },
  { name: 'updateOccupancy', run: updateOccupancy, runIn: IN_GAME },
  { name: 'updateCityPopulation', run: updateCityPopulation, runIn: IN_GAME },
  { name: 'reportBuildingsWithoutPower', run: reportBuildingsWithoutPower, runIn: IN_GAME },
];

/** `Update` / `GameSet::CommandApply`. */
export const COMMAND_APPLY: readonly CommandSystemEntry[] = [
  // apply_game_commands_to_grid: roads, zones, erase, GenerateMap and undo/redo. First, because
  // GenerateMap writes the map seed the re-seeds below read.
  { name: 'applyGameCommandsToGrid', run: applyGameCommandsToGrid, runIn: IN_GAME_OR_PAUSED },
  // reset_sim_rng_on_new_map: after applyGameCommandsToGrid, reads mapSeed.
  { name: 'resetSimRngOnNewMap', run: resetSimRngOnNewMap, runIn: IN_GAME_OR_PAUSED },
  // reset_growth_rng_on_new_map: after applyGameCommandsToGrid, reads mapSeed.
  { name: 'resetGrowthRngOnNewMap', run: resetGrowthRngOnNewMap, runIn: IN_GAME_OR_PAUSED },
  // handle_traffic_light_commands: reads the intersection index of the last GraphUpdate.
  { name: 'handleTrafficLightCommands', run: handleTrafficLightCommands, runIn: IN_GAME_OR_PAUSED },
  // clear_vehicles: GenerateMap drops all traffic.
  { name: 'clearVehicles', run: clearVehicles, runIn: IN_GAME_OR_PAUSED },
];

/** `Update` / `GameSet::GraphUpdate`: derived structures, after the frame's commands. */
export const UPDATE_GRAPH: readonly SystemEntry[] = [
  // detect_intersections: reads the graph version CommandApply may have bumped.
  { name: 'detectIntersections', run: detectIntersections, runIn: IN_GAME_OR_PAUSED },
  // sync_traffic_light_entities: after detectIntersections, reads the re-mapped light ids.
  { name: 'syncTrafficLights', run: syncTrafficLights, runIn: IN_GAME_OR_PAUSED },
  // check_ring_free_topology: after syncTrafficLights, counts clusters without an open-road exit.
  { name: 'checkRingFreeTopology', run: checkRingFreeTopology, runIn: IN_GAME_OR_PAUSED },
];
