// Messages the sim clock emits (`HourAdvanced`, `DayAdvanced` in Rust). Events written inside a
// tick are visible to later systems of that tick; events written outside a tick (state transitions,
// command apply) wait in `pendingEvents` and become the next tick's events.
import type { World } from './world';

export interface HourAdvanced {
  readonly hour: number;
  readonly day: number;
}

export interface TickEvents {
  readonly hourAdvanced: HourAdvanced[];
  readonly dayAdvanced: number[];
}

export function emptyEvents(): TickEvents {
  return { hourAdvanced: [], dayAdvanced: [] };
}

export function beginTickEvents(w: World): void {
  w.events = w.pendingEvents;
  w.pendingEvents = emptyEvents();
}
