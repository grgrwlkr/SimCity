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
import { buildLaneGraph } from './transport/laneGraph';
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
  // After rebuildRegionGraph; the lanelet graph joins after it.
  { name: 'buildLaneGraph', run: buildLaneGraph, runIn: ALL_STATES },
  // SimStep::Tick — the game clock; writes HourAdvanced / DayAdvanced for every system after it.
  { name: 'simTick', run: simTick, runIn: IN_GAME },
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
];

/** `Update` / `GameSet::GraphUpdate`: derived structures, after the frame's commands. */
export const UPDATE_GRAPH: readonly SystemEntry[] = [
  // detect_intersections: reads the graph version CommandApply may have bumped.
  { name: 'detectIntersections', run: detectIntersections, runIn: IN_GAME_OR_PAUSED },
];
