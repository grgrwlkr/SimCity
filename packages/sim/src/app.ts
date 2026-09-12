// Driving the world one app update at a time, in the order of Bevy's main schedule:
// StateTransition → FixedUpdate (as many ticks as the frame owes) → Update's CommandApply.
// A system that throws is logged in the world's journal and skipped for that call: the worker never dies of one.
import { DEFAULT_GAME_HOUR_NS } from './city';
import { COMMAND_APPLY, FIXED_UPDATE, TICK_DT_NS, UPDATE_GRAPH, type SystemEntry } from './schedule';
import { applyStateTransition } from './state';
import type { World } from './world';

/** Logs that `system` threw on this tick: the first tick, the last, how often and the latest message. */
export function recordSystemError(w: World, system: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const entry = w.systemErrors.get(system);
  if (entry === undefined) {
    w.systemErrors.set(system, { system, count: 1, firstTick: w.tick, lastTick: w.tick, message });
  } else {
    entry.count += 1;
    entry.lastTick = w.tick;
    entry.message = message;
  }
}

/** Whether a system runs on this tick: every tick, or on the tick its period of game time completes. */
export function runsThisTick(w: World, system: Pick<SystemEntry, 'everyGameNs'>): boolean {
  if (system.everyGameNs === undefined) return true;
  // A tick is a tenth of a game second on the real-time clock, more on a test world's faster one.
  const gameNsPerTick = (TICK_DT_NS * DEFAULT_GAME_HOUR_NS) / w.gameHourNs;
  const period = Math.max(1, Math.round(system.everyGameNs / gameNsPerTick));
  // Aligned with the clock: the tick the minute, hour or day turns on is the last tick of a period.
  return (w.tick + 1) % period === 0;
}

function failIfAsked(w: World, system: string): void {
  if (w.debugFailSystem === system) throw new Error(`debug failure of ${system}`);
}

export function runFixedTick(w: World): void {
  for (const system of FIXED_UPDATE) {
    if (!system.runIn.includes(w.appState) || !runsThisTick(w, system)) continue;
    try {
      failIfAsked(w, system.name);
      system.run(w, TICK_DT_NS);
    } catch (error) {
      recordSystemError(w, system.name, error);
    }
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
    if (!system.runIn.includes(w.appState)) continue;
    try {
      failIfAsked(w, system.name);
      system.run(w, commands);
    } catch (error) {
      recordSystemError(w, system.name, error);
    }
  }
  w.undoRedo = [];
}

/** `Update` / `GameSet::GraphUpdate`. These systems read no frame time. */
export function runUpdateGraph(w: World): void {
  for (const system of UPDATE_GRAPH) {
    if (!system.runIn.includes(w.appState)) continue;
    try {
      failIfAsked(w, system.name);
      system.run(w, 0);
    } catch (error) {
      recordSystemError(w, system.name, error);
    }
  }
}

/** One app update; `beforeTick` runs before each fixed tick (a scenario feeding the world). */
export function frame(w: World, fixedTicks: number, beforeTick?: (w: World) => void): void {
  applyStateTransition(w);
  for (let i = 0; i < fixedTicks; i++) {
    beforeTick?.(w);
    runFixedTick(w);
  }
  applyCommands(w);
  runUpdateGraph(w);
}

/** `headless_sim::tick`: `n` frames of one fixed tick each. */
export function step(w: World, n: number): void {
  for (let i = 0; i < n; i++) frame(w, 1);
}
