// Driving the world one app update at a time, in the order of Bevy's main schedule:
// StateTransition → FixedUpdate (as many ticks as the frame owes) → Update's CommandApply.
import { COMMAND_APPLY, FIXED_UPDATE, TICK_DT_NS, UPDATE_GRAPH } from './schedule';
import { applyStateTransition } from './state';
import type { World } from './world';

export function runFixedTick(w: World): void {
  for (const system of FIXED_UPDATE) {
    if (system.runIn.includes(w.appState)) system.run(w, TICK_DT_NS);
  }
  w.tick += 1;
}

/**
 * `CommandApply`: every system reads the whole frame's commands, in schedule order. Commands and
 * undo/redo requests no system reads are dropped with the frame, as unread Bevy messages are.
 */
export function applyCommands(w: World): void {
  const commands = w.commands;
  w.commands = [];
  for (const system of COMMAND_APPLY) {
    if (system.runIn.includes(w.appState)) system.run(w, commands);
  }
  w.undoRedo = [];
}

/** `Update` / `GameSet::GraphUpdate`. These systems read no frame time. */
export function runUpdateGraph(w: World): void {
  for (const system of UPDATE_GRAPH) {
    if (system.runIn.includes(w.appState)) system.run(w, 0);
  }
}

export function frame(w: World, fixedTicks: number): void {
  applyStateTransition(w);
  for (let i = 0; i < fixedTicks; i++) runFixedTick(w);
  applyCommands(w);
  runUpdateGraph(w);
}

/** `headless_sim::tick`: `n` frames of one fixed tick each. */
export function step(w: World, n: number): void {
  for (let i = 0; i < n; i++) frame(w, 1);
}
