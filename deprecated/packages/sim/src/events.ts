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
  readonly purpose: 'Work' | 'Shop' | 'ReturnHome' | 'Cafe' | 'Park' | 'Freight' | 'Through' | 'Service' | 'Transit';
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
  /** The car lives in its citizen's pocket: a vehicle only until it arrives (stage 3½b); scenario cars stay parked vehicles. */
  readonly pocket?: true;
  /** A truck of the region's freight (stage 3½), a bus or a service vehicle of the city (stage 4); a car when absent. */
  readonly vehicle?: 'Truck' | 'Bus' | 'Fire' | 'Police' | 'Ambulance';
}

export interface TickEvents {
  readonly hourAdvanced: HourAdvanced[];
  readonly dayAdvanced: number[];
  readonly tripRequested: TripRequested[];
  readonly tripFinished: TripFinished[];
  /** Citizens whose walk ended this tick: a car trip ends with `tripFinished`, a walk with this. */
  readonly walksFinished: number[];
  /** The ids of the car trips meso traffic dropped this tick: no lane beside an end, or no route between them. */
  readonly tripDropped: number[];
}

export function emptyEvents(): TickEvents {
  return { hourAdvanced: [], dayAdvanced: [], tripRequested: [], tripFinished: [], walksFinished: [], tripDropped: [] };
}

export function beginTickEvents(w: World): void {
  w.events = w.pendingEvents;
  w.pendingEvents = emptyEvents();
}
