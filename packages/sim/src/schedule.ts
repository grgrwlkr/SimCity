// Order of systems is data: the position in the array is the execution order (Rust: `GameSet`
// chained with its `SimStep` / `TrafficStep` / `PostSimStep` sub-sets). A new system takes a
// concrete position with a comment saying what it runs after and what it reads.
import { simTick } from './city';
import type { GameCommand } from './commands';
import { beginTickEvents } from './events';
import { detectIntersections } from './intersections/index';
import { applyGameCommandsToGrid } from './map/apply';
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
import { buildTrafficSpatialIndex } from './traffic/spatialIndex';
import { updateVehicleTrafficState } from './traffic/state';
import { breakTileSwaps } from './traffic/swapBreak';
import { buildLaneGraph } from './transport/laneGraph';
import { buildLaneletGraph } from './transport/lanelet/build';
import { rebuildRegionGraph } from './transport/regionGraph';
import { rebuildRoadGraph } from './transport/roadGraph';
import { autogenTurnLanes } from './transport/turnLanes';
import type { World } from './world';

export type System = (w: World, dtNs: number) => void;
export type CommandSystem = (w: World, commands: readonly GameCommand[]) => void;

export interface SystemEntry {
  readonly name: string;
  readonly run: System;
  /** `run_if(in_state(...))` as data. */
  readonly runIn: readonly AppState[];
}

export interface CommandSystemEntry {
  readonly name: string;
  readonly run: CommandSystem;
  readonly runIn: readonly AppState[];
}

export const TICK_HZ = 10;
export const TICK_DT_NS = SECOND_NS / TICK_HZ;

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
  // After buildLaneletGraph, in game: a graph version bump re-checks active routes against the new grid.
  { name: 'invalidateRoutesOnGraphChange', run: invalidateRoutesOnGraphChange, runIn: IN_GAME },
  // SimStep::Tick — the game clock; writes HourAdvanced / DayAdvanced for every system after it.
  { name: 'simTick', run: simTick, runIn: IN_GAME },
  // SimStep::Traffic, before the vehicle states that read the phase.
  { name: 'updateTrafficLights', run: updateTrafficLights, runIn: IN_GAME },
  // TrafficStep::Flow, first: last tick's positions, so routing and the capacity gate see fresh counts.
  { name: 'updateTrafficOccupancy', run: updateTrafficOccupancy, runIn: IN_GAME },
  // After updateTrafficOccupancy and the lights: approach, stop and release states.
  { name: 'updateVehicleTrafficState', run: updateVehicleTrafficState, runIn: IN_GAME },
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
  // TrafficStep::Recovery: the mandatory-merge nudge reads the stall tracker the arbiter wrote. The
  // stuck-timer systems around it arrive with stage 2c.
  { name: 'nudgeLaneletStallReroute', run: nudgeLaneletStallReroute, runIn: IN_GAME },
  // PostSimStep::TrafficIndex: the end-of-tick metrics RCI demand reads.
  { name: 'updateTrafficIndex', run: updateTrafficIndex, runIn: IN_GAME },
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
