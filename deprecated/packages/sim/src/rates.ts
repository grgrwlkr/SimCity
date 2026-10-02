// The fixed step and the rates systems run at in game time. Apart from the schedule so that a system can know how often it
// runs without importing the schedule that lists it.
import { DEFAULT_GAME_HOUR_NS } from './city';
import { SECOND_NS } from './timer';
import type { World } from './world';

export const TICK_HZ = 10;
export const TICK_DT_NS = SECOND_NS / TICK_HZ;

/** Ticks between two runs of a system that runs once per `everyGameNs` of game time; every tick when a tick carries more. */
export function periodTicks(w: World, everyGameNs: number): number {
  // A tick is a tenth of a game second on the real-time clock, more on a test world's faster one.
  const gameNsPerTick = (TICK_DT_NS * DEFAULT_GAME_HOUR_NS) / w.gameHourNs;
  return Math.max(1, Math.round(everyGameNs / gameNsPerTick));
}
