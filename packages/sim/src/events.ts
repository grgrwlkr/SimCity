// Messages the sim clock emits (`HourAdvanced`, `DayAdvanced` in Rust). Events written inside a
// tick are visible to later systems of that tick; events written outside a tick (state transitions,
// command apply) wait in `pendingEvents` and become the next tick's events.
import type { TilePos } from './commands';
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

export type TripMode = 'Walk' | 'Car';

/** `TripRequested`: written by citizens (until that stage, by scenarios and tests), read by traffic spawn. */
export interface TripRequested {
  readonly citizen: number;
  readonly from: TilePos;
  /** For a car trip: the building tile where the citizen's car is parked. */
  readonly carParkedAt: TilePos | null;
  readonly to: TilePos;
  readonly purpose: TripFinished['purpose'];
  readonly mode: TripMode;
}

export interface TickEvents {
  readonly hourAdvanced: HourAdvanced[];
  readonly dayAdvanced: number[];
  readonly tripRequested: TripRequested[];
  readonly tripFinished: TripFinished[];
}

export function emptyEvents(): TickEvents {
  return { hourAdvanced: [], dayAdvanced: [], tripRequested: [], tripFinished: [] };
}

export function beginTickEvents(w: World): void {
  w.events = w.pendingEvents;
  w.pendingEvents = emptyEvents();
}
