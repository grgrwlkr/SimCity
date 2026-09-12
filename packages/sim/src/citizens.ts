// Port of crates/simcity_sim/src/game/citizens.rs: residents of open homes, their tours to work and to shops, and the
// recovery of trips that never arrive. A citizen's home and workplace are building ids; in Rust they were anchor
// tiles, so a worker kept a job at whatever new building grew on the same anchor. Every trip is by car until
// pedestrians arrive with stage 4.
import { isOperational, type Building } from './buildings/building';
import type { TilePos } from './commands';
import type { TripMode } from './events';
import { chooseIndex, rangeF32 } from './rng';
import { SECOND_NS, Timer, type TimerMode } from './timer';
import { fixedElapsedSecs } from './traffic/reservations';
import { despawnVehicle, vehicleRef, type TripPurpose } from './traffic/vehicles';
import { footprintEntrance } from './transport/anchors';
import type { World } from './world';

const f32 = Math.fround;

/** A citizen in transit this long without an arrival goes back home, game seconds: well above a completed trip. */
export const CITIZEN_TRIP_TIMEOUT_SECS = 180;
/** At most this many move into one building a tick. */
const MAX_MOVING_IN_PER_TICK = 8;
const COMMUTE_EMA_ALPHA = f32(0.15);

export const CITIZEN_STATES = ['AtHome', 'ToWork', 'AtWork', 'ToShop', 'AtShop', 'ToHome'] as const;
export type CitizenState = (typeof CITIZEN_STATES)[number];

export interface Citizen {
  readonly id: number;
  /** The residential building the citizen lives in. */
  readonly home: number;
  state: CitizenState;
  /** The last place other than home the citizen travelled to. */
  lastPlace: TilePos;
  /** The mode of the tour in progress, home to home. */
  tourMode: TripMode | null;
  /** The building tile the citizen's car is parked at. */
  carParkedAt: TilePos;
  /** The building the citizen works at. */
  workplace: number | null;
  /** When to decide next while at home, at work or at a shop. */
  readonly decisionTimer: Timer;
  readonly shoppingNeed: Timer;
  readonly workStay: Timer;
  readonly shopStay: Timer;
  /** Fixed-step seconds the trip in progress departed at. */
  tripDepartedAtSec: number | null;
  tripPurpose: TripPurpose | null;
}

export type CitizenSpec = Omit<Citizen, 'id'>;

export interface ShoppingDemandStats {
  /** Times citizens wanted to shop this tick. */
  demandEvents: number;
  /** Of them, the times there was no shop. */
  unmetEvents: number;
  unmetRatio: number;
}

export interface CommuteStats {
  /** An exponential mean of trip durations, s. */
  avgCommuteSecs: number;
  samples: number;
}

export const emptyShoppingStats = (): ShoppingDemandStats => ({ demandEvents: 0, unmetEvents: 0, unmetRatio: 0 });
export const emptyCommuteStats = (): CommuteStats => ({ avgCommuteSecs: 0, samples: 0 });

const timerSecs = (secs: number, mode: TimerMode) => new Timer(Math.round(secs * SECOND_NS), mode);

/**
 * A citizen at home in `home` with no job: decides every `decision` seconds, wants to shop every `shopping`, stays
 * `work` at work and `shop` at a shop.
 */
export function newCitizen(home: Building, [decision, shopping, work, shop]: readonly number[] = [2, 10, 5, 3]): CitizenSpec {
  return {
    home: home.id,
    state: 'AtHome',
    lastPlace: home.anchor,
    tourMode: null,
    carParkedAt: home.anchor,
    workplace: null,
    decisionTimer: timerSecs(decision!, 'Repeating'),
    shoppingNeed: timerSecs(shopping!, 'Repeating'),
    workStay: timerSecs(work!, 'Once'),
    shopStay: timerSecs(shop!, 'Once'),
    tripDepartedAtSec: null,
    tripPurpose: null,
  };
}

/** The citizens of the city, in id order. */
export class Citizens {
  private nextId = 1;
  private list: Citizen[] = [];
  private readonly byId = new Map<number, Citizen>();
  /** Citizens gone whose car may still stand somewhere. */
  readonly departed = new Set<number>();

  add(spec: CitizenSpec): Citizen {
    const citizen: Citizen = { ...spec, id: this.nextId };
    this.nextId += 1;
    this.list.push(citizen);
    this.byId.set(citizen.id, citizen);
    return citizen;
  }

  get(id: number): Citizen | undefined {
    return this.byId.get(id);
  }

  all(): readonly Citizen[] {
    return this.list;
  }

  /** Removes the citizens in `ids`; their cars are left to `despawnOrphanedOwnedCars`. */
  remove(ids: ReadonlySet<number>): void {
    if (ids.size === 0) return;
    this.list = this.list.filter((c) => !ids.has(c.id));
    for (const id of ids) {
      this.byId.delete(id);
      this.departed.add(id);
    }
  }

  clear(): void {
    this.list = [];
    this.byId.clear();
    this.departed.clear();
  }

  fingerprintState(): unknown {
    return [this.nextId, this.list, [...this.departed]];
  }
}

/**
 * `spawn_citizens_from_residential` (SimStep::Citizens): open homes fill up to their occupancy, eight a tick. Each
 * citizen draws timers of their own; Rust drew one set per building a tick, so neighbours who moved in together
 * decided in lockstep.
 */
export function spawnCitizensFromResidential(w: World): void {
  const housed = new Map<number, number>();
  for (const c of w.citizens.all()) housed.set(c.home, (housed.get(c.home) ?? 0) + 1);
  for (const b of w.buildings.all()) {
    if (b.kind !== 'Residential' || !isOperational(b)) continue;
    const current = housed.get(b.id) ?? 0;
    // No floor of one: a building at zero occupancy seats no one.
    const moving = Math.min(b.occupancyResidents - current, MAX_MOVING_IN_PER_TICK);
    if (moving <= 0) continue;
    for (let i = 0; i < moving; i++) {
      const rng = w.simRng;
      w.citizens.add(newCitizen(b, [rangeF32(rng, 1, 3), rangeF32(rng, 9, 18), rangeF32(rng, 5, 9), rangeF32(rng, 2, 5)]));
    }
    housed.set(b.id, current + moving);
  }
}

/**
 * Where a trip to or from `b` leaves and parks: the footprint tile beside its road towards `towards`. Rust used the
 * anchor, and the vehicle spawn dropped the trips of every building whose anchor corner faced away from its road.
 */
function entrance(w: World, b: Building, towards: TilePos): TilePos {
  return footprintEntrance(w.grid, b.anchor, b.width, b.length, towards);
}

function depart(w: World, c: Citizen, from: TilePos, to: TilePos, purpose: TripPurpose, now: number): void {
  c.tourMode ??= 'Car';
  const mode = c.tourMode;
  w.events.tripRequested.push({ citizen: c.id, from, carParkedAt: mode === 'Car' ? c.carParkedAt : null, to, purpose, mode });
  c.state = purpose === 'Work' ? 'ToWork' : purpose === 'Shop' ? 'ToShop' : 'ToHome';
  if (purpose !== 'ReturnHome') c.lastPlace = to;
  c.tripDepartedAtSec = now;
  c.tripPurpose = purpose;
}

/**
 * `citizen_trip_planner` (SimStep::Citizens): on a decision, a citizen at home goes shopping when the need came and
 * a shop is open, otherwise to work; one at work or at a shop goes home once the stay is over.
 */
export function citizenTripPlanner(w: World, dtNs: number): void {
  const shops = w.buildings.all().filter((b) => b.kind === 'Commercial' && isOperational(b));
  const shopping = w.shoppingStats;
  shopping.demandEvents = 0;
  shopping.unmetEvents = 0;
  const now = fixedElapsedSecs(w);

  for (const c of w.citizens.all()) {
    c.shoppingNeed.tick(dtNs);
    c.decisionTimer.tick(dtNs);
    c.workStay.tick(dtNs);
    c.shopStay.tick(dtNs);
    if (c.decisionTimer.timesFinishedThisTick === 0) continue;
    const home = w.buildings.get(c.home);
    if (home === undefined) continue;

    if (c.state === 'AtHome') {
      // Tours start at home, from the side of it on the road towards where they go.
      c.tourMode = null;
      let destination: Building | undefined;
      let purpose: TripPurpose = 'Work';
      if (c.shoppingNeed.timesFinishedThisTick > 0) {
        shopping.demandEvents += 1;
        const pick = chooseIndex(w.simRng, shops.length);
        if (pick === undefined) {
          shopping.unmetEvents += 1;
        } else {
          destination = shops[pick]!;
          purpose = 'Shop';
        }
      }
      if (destination === undefined && c.workplace !== null) destination = w.buildings.get(c.workplace);
      c.carParkedAt = entrance(w, home, (destination ?? home).anchor);
      if (destination !== undefined) depart(w, c, c.carParkedAt, entrance(w, destination, home.anchor), purpose, now);
    } else if (c.state === 'AtWork' || c.state === 'AtShop') {
      if ((c.state === 'AtWork' ? c.workStay : c.shopStay).finished) depart(w, c, c.lastPlace, entrance(w, home, c.lastPlace), 'ReturnHome', now);
    }
  }

  shopping.unmetRatio = shopping.demandEvents > 0 ? f32(shopping.unmetEvents / shopping.demandEvents) : 0;
}

/**
 * `handle_trip_finished`: arrivals of this tick, right after traffic wrote them. Only a citizen still on that leg
 * moves: one recovery sent home, or already on another leg, is not teleported by a late arrival.
 */
export function handleTripFinished(w: World): void {
  const arrivals = w.events.tripFinished;
  if (arrivals.length === 0) return;
  const now = fixedElapsedSecs(w);
  const commute = w.commuteStats;
  for (const arrival of arrivals) {
    const c = w.citizens.get(arrival.citizen);
    if (c === undefined) continue;
    const expected = arrival.purpose === 'Work' ? 'ToWork' : arrival.purpose === 'Shop' ? 'ToShop' : 'ToHome';
    if (c.state !== expected) continue;

    if (c.tripDepartedAtSec !== null) {
      const secs = f32(Math.max(now - c.tripDepartedAtSec, 0));
      commute.avgCommuteSecs =
        commute.samples === 0 ? secs : f32(f32(commute.avgCommuteSecs * f32(1 - COMMUTE_EMA_ALPHA)) + f32(secs * COMMUTE_EMA_ALPHA));
      commute.samples += 1;
    }
    c.tripDepartedAtSec = null;
    c.tripPurpose = null;

    if (arrival.purpose === 'ReturnHome') {
      c.state = 'AtHome';
      c.tourMode = null;
      const home = w.buildings.get(c.home);
      // Where the trip home parked: the side of home towards the place it came from.
      if (home !== undefined) c.carParkedAt = entrance(w, home, c.lastPlace);
    } else {
      c.state = arrival.purpose === 'Work' ? 'AtWork' : 'AtShop';
      (arrival.purpose === 'Work' ? c.workStay : c.shopStay).reset();
      if (c.tourMode === 'Car') c.carParkedAt = c.lastPlace;
    }
    c.decisionTimer.reset();
  }
}

/**
 * `recover_stuck_trips` (SimStep::Citizens): a trip whose car never spawned or was removed stuck yields no arrival,
 * and the planner does nothing in transit, so such a citizen goes back home after the timeout and decides again.
 */
export function recoverStuckTrips(w: World): void {
  const now = fixedElapsedSecs(w);
  for (const c of w.citizens.all()) {
    if (c.state !== 'ToWork' && c.state !== 'ToShop' && c.state !== 'ToHome') continue;
    if (c.tripDepartedAtSec === null || now - c.tripDepartedAtSec <= CITIZEN_TRIP_TIMEOUT_SECS) continue;
    c.state = 'AtHome';
    const home = w.buildings.get(c.home);
    if (home !== undefined) c.carParkedAt = entrance(w, home, home.anchor);
    c.tourMode = null;
    c.tripDepartedAtSec = null;
    c.tripPurpose = null;
    // After the normal delay, not all on the tick a backlog times out together.
    c.decisionTimer.reset();
  }
}

/**
 * `cleanup_homeless_citizens` (PostSimStep::Citizens): a home that is gone, not open or holds fewer than live there
 * loses the surplus, the last to move in first.
 */
export function cleanupHomelessCitizens(w: World): void {
  const byHome = new Map<number, Citizen[]>();
  for (const c of w.citizens.all()) {
    const residents = byHome.get(c.home);
    if (residents === undefined) byHome.set(c.home, [c]);
    else residents.push(c);
  }
  const leaving = new Set<number>();
  for (const [homeId, residents] of byHome) {
    const home = w.buildings.get(homeId);
    const limit = home !== undefined && home.kind === 'Residential' && isOperational(home) ? home.occupancyResidents : 0;
    // Residents are in id order: the surplus is the tail.
    for (let i = limit; i < residents.length; i++) leaving.add(residents[i]!.id);
  }
  w.citizens.remove(leaving);
}

/**
 * `despawn_orphaned_owned_cars` (PostSimStep::Citizens): the parked car of a citizen who left goes; one still on the
 * road finishes its leg and goes once it parks. Only cars of departed citizens are looked at, so the scenario cars
 * of the traffic gates, whose owners were never citizens, stay.
 */
export function despawnOrphanedOwnedCars(w: World): void {
  const departed = w.citizens.departed;
  if (departed.size === 0) return;
  const v = w.vehicles;
  const driving = new Set<number>();
  for (const slot of [...v.order]) {
    const owner = v.carOwner[slot]!;
    if (!departed.has(owner)) continue;
    if (v.parked[slot] === 1) despawnVehicle(w, vehicleRef(v, slot));
    else driving.add(owner);
  }
  for (const id of [...departed]) if (!driving.has(id)) departed.delete(id);
}
