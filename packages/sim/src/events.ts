// Messages the sim clock emits (`HourAdvanced`, `DayAdvanced` in Rust). Events written inside a
// tick are visible to later systems of that tick; events written outside a tick (state transitions,
// command apply) wait in `pendingEvents` and become the next tick's events.
import type { World } from './world';

export interface HourAdvanced {
  readonly hour: number;
  readonly day: number;
}

/** `TripFinished`: written by traffic when a trip vehicle arrives, read by citizens. */
export interface TripFinished {
  readonly citizen: number;
  readonly purpose: 'Work' | 'Shop' | 'ReturnHome';
}

export interface TickEvents {
  readonly hourAdvanced: HourAdvanced[];
  readonly dayAdvanced: number[];
  readonly tripFinished: TripFinished[];
}

export function emptyEvents(): TickEvents {
  return { hourAdvanced: [], dayAdvanced: [], tripFinished: [] };
}

export function beginTickEvents(w: World): void {
  w.events = w.pendingEvents;
  w.pendingEvents = emptyEvents();
}
