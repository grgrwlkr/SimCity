// Port of crates/simcity_sim/src/game/citizens.rs: residents of open homes, their day and their trips, and the recovery
// of trips that never arrive. Where TS departs from Rust:
// - home and workplace are building ids; in Rust they were anchor tiles, so a worker kept a job at whatever new
//   building grew on the same anchor;
// - a citizen keeps a day on the game clock: to work in the morning, home after the shift, shopping at a shop near home
//   in the evening (by day without a job), nobody setting out at night. Rust decided on timers of real seconds, a
//   decision every 1–3 s and shopping at any shop in town every 9–18 s, so with a car crossing town in more than a game
//   day the whole city drove all the time;
// - every trip is by car until pedestrians arrive with stage 4.
import { isOperational, type Building } from './buildings/building';
import { MINUTES_PER_DAY, gameMinute } from './city';
import type { TilePos } from './commands';
import type { TripMode } from './events';
import { randomBool, rangeU32 } from './rng';
import { fixedElapsedSecs } from './traffic/reservations';
import { despawnVehicle, vehicleRef, type TripPurpose } from './traffic/vehicles';
import { footprintEntrance } from './transport/anchors';
import type { World } from './world';

const f32 = Math.fround;

/** A trip with no car on the road and none waiting for one is given up after this long, real seconds. */
export const CITIZEN_TRIP_TIMEOUT_SECS = 180;
/** At most this many move into one building a tick. */
const MAX_MOVING_IN_PER_TICK = 8;
const COMMUTE_EMA_ALPHA = f32(0.15);

/** Minutes of the day a citizen leaves for work in: 06:00 to 09:00. */
export const WORK_DEPARTURE_WINDOW = [6 * 60, 9 * 60] as const;
/** A shift, minutes: eight to nine hours. */
export const SHIFT_MINUTES = [8 * 60, 9 * 60] as const;
/** A worker shops between 17:00 and 20:00, a citizen without a job between 10:00 and 17:00. */
export const EVENING_SHOPPING = [17 * 60, 20 * 60] as const;
export const DAYTIME_SHOPPING = [10 * 60, 17 * 60] as const;
/** The share of those evenings, or days, a citizen goes shopping. */
export const EVENING_SHOPPING_CHANCE = 0.3;
export const DAYTIME_SHOPPING_CHANCE = 0.5;
/** A shopper sets out within this many minutes of deciding to. */
const SHOPPING_DELAY_MINUTES = [10, 40] as const;
/** A visit to a shop, minutes. */
export const SHOP_VISIT_MINUTES = [30, 90] as const;
/** A shopper goes to one of this many open shops nearest home. */
export const NEAREST_SHOPS = 5;

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
  /** Minute of the day the citizen leaves for work. */
  readonly workDeparture: number;
  /** Minutes the citizen stays at work. */
  readonly shiftMinutes: number;
  /** Game minute of the next move: setting out for `nextPurpose`, or thinking the day over when it is `null`. */
  nextAt: number | null;
  nextPurpose: TripPurpose | null;
  /** The last day the citizen decided whether to go shopping. */
  shoppingDecidedDay: number;
  /** Fixed-step seconds the trip in progress departed at. */
  tripDepartedAtSec: number | null;
  tripPurpose: TripPurpose | null;
}

export type CitizenSpec = Omit<Citizen, 'id'>;

export interface ShoppingDemandStats {
  /** Shopping trips wanted over the day so far. */
  demandEvents: number;
  /** Of them, the ones with no open shop. */
  unmetEvents: number;
  /** Unmet over wanted, of the last whole day. */
  unmetRatio: number;
}

export interface CommuteStats {
  /** An exponential mean of trip durations, s. */
  avgCommuteSecs: number;
  samples: number;
}

export const emptyShoppingStats = (): ShoppingDemandStats => ({ demandEvents: 0, unmetEvents: 0, unmetRatio: 0 });
export const emptyCommuteStats = (): CommuteStats => ({ avgCommuteSecs: 0, samples: 0 });

export interface CitizenDay {
  /** Minute of the day the citizen leaves for work; 07:00 when not given. */
  readonly workDeparture?: number;
  /** Minutes at work; eight hours when not given. */
  readonly shiftMinutes?: number;
}

/** A citizen at home in `home`, with no job and no plans yet. */
export function newCitizen(home: Building, day: CitizenDay = {}): CitizenSpec {
  return {
    home: home.id,
    state: 'AtHome',
    lastPlace: home.anchor,
    tourMode: null,
    carParkedAt: home.anchor,
    workplace: null,
    workDeparture: day.workDeparture ?? 7 * 60,
    shiftMinutes: day.shiftMinutes ?? 8 * 60,
    nextAt: null,
    nextPurpose: null,
    shoppingDecidedDay: 0,
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

/** `spawn_citizens_from_residential` (SimStep::Citizens): open homes fill up to their occupancy, eight a tick. */
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
      const workDeparture = rangeU32(rng, WORK_DEPARTURE_WINDOW[0], WORK_DEPARTURE_WINDOW[1]);
      const shiftMinutes = rangeU32(rng, SHIFT_MINUTES[0], SHIFT_MINUTES[1] + 1);
      w.citizens.add(newCitizen(b, { workDeparture, shiftMinutes }));
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

function depart(w: World, c: Citizen, from: TilePos, to: TilePos, purpose: TripPurpose, nowSecs: number): void {
  c.tourMode ??= 'Car';
  const mode = c.tourMode;
  w.events.tripRequested.push({ citizen: c.id, from, carParkedAt: mode === 'Car' ? c.carParkedAt : null, to, purpose, mode });
  c.state = purpose === 'Work' ? 'ToWork' : purpose === 'Shop' ? 'ToShop' : 'ToHome';
  if (purpose !== 'ReturnHome') c.lastPlace = to;
  c.nextAt = null;
  c.nextPurpose = null;
  c.tripDepartedAtSec = nowSecs;
  c.tripPurpose = purpose;
}

/**
 * The next move of a citizen at home: to work at their hour, shopping (decided once a day, when the shopping hours
 * have come), or thinking again when those hours open. A citizen planning at the very minute they leave for work
 * leaves now; every other time is after `now`.
 */
function planDay(w: World, c: Citizen, now: number): void {
  const minute = now % MINUTES_PER_DAY;
  const dayStart = now - minute;
  const employed = c.workplace !== null;
  const [open, close] = employed ? EVENING_SHOPPING : DAYTIME_SHOPPING;
  const decidedToday = c.shoppingDecidedDay === w.city.day;

  let shopAt: number | undefined;
  let thinkAt = dayStart + MINUTES_PER_DAY + open;
  if (!decidedToday && minute >= open && minute < close) {
    c.shoppingDecidedDay = w.city.day;
    if (randomBool(w.simRng, employed ? EVENING_SHOPPING_CHANCE : DAYTIME_SHOPPING_CHANCE)) {
      shopAt = Math.min(now + rangeU32(w.simRng, SHOPPING_DELAY_MINUTES[0], SHOPPING_DELAY_MINUTES[1] + 1), dayStart + close);
    }
  } else if (!decidedToday && minute < open) {
    thinkAt = dayStart + open;
  }
  const workAt = employed ? (minute <= c.workDeparture ? dayStart : dayStart + MINUTES_PER_DAY) + c.workDeparture : undefined;

  if (shopAt !== undefined && (workAt === undefined || shopAt <= workAt)) {
    c.nextAt = shopAt;
    c.nextPurpose = 'Shop';
  } else if (workAt !== undefined && workAt <= thinkAt) {
    c.nextAt = workAt;
    c.nextPurpose = 'Work';
  } else {
    c.nextAt = thinkAt;
    c.nextPurpose = null;
  }
}

/** One of the `NEAREST_SHOPS` open shops nearest `home`. */
function shopNear(w: World, home: Building, shops: readonly Building[]): Building | undefined {
  if (shops.length === 0) return undefined;
  const distance = (b: Building) => Math.abs(b.anchor.x - home.anchor.x) + Math.abs(b.anchor.y - home.anchor.y);
  const nearest = [...shops].sort((a, b) => distance(a) - distance(b) || a.id - b.id).slice(0, NEAREST_SHOPS);
  return nearest[rangeU32(w.simRng, 0, nearest.length)];
}

/**
 * `citizen_trip_planner` (SimStep::Citizens): a citizen at work or at a shop goes home when the stay is over; one at
 * home plans the day and sets out when the time comes. A job lost or no open shop makes them think again.
 */
export function citizenTripPlanner(w: World): void {
  const shopping = w.shoppingStats;
  if (w.events.dayAdvanced.length > 0) {
    shopping.unmetRatio = shopping.demandEvents > 0 ? f32(shopping.unmetEvents / shopping.demandEvents) : 0;
    shopping.demandEvents = 0;
    shopping.unmetEvents = 0;
  }
  const now = gameMinute(w);
  const nowSecs = fixedElapsedSecs(w);
  let shops: Building[] | undefined;

  for (const c of w.citizens.all()) {
    const home = w.buildings.get(c.home);
    if (home === undefined) continue;

    if (c.state === 'AtWork' || c.state === 'AtShop') {
      if (c.nextAt !== null && now >= c.nextAt) depart(w, c, c.lastPlace, entrance(w, home, c.lastPlace), 'ReturnHome', nowSecs);
      continue;
    }
    if (c.state !== 'AtHome') continue;

    if (c.nextAt === null) planDay(w, c, now);
    if (c.nextAt === null || now < c.nextAt) continue;

    let destination: Building | undefined;
    if (c.nextPurpose === 'Work' && c.workplace !== null) {
      destination = w.buildings.get(c.workplace);
    } else if (c.nextPurpose === 'Shop') {
      shopping.demandEvents += 1;
      shops ??= w.buildings.all().filter((b) => b.kind === 'Commercial' && isOperational(b));
      destination = shopNear(w, home, shops);
      if (destination === undefined) shopping.unmetEvents += 1;
    }
    if (destination === undefined) {
      planDay(w, c, now);
      continue;
    }
    // Tours start at home, from the side of it on the road towards where they go.
    const purpose = c.nextPurpose!;
    c.tourMode = null;
    c.carParkedAt = entrance(w, home, destination.anchor);
    depart(w, c, c.carParkedAt, entrance(w, destination, home.anchor), purpose, nowSecs);
  }
}

/**
 * `handle_trip_finished`: arrivals of this tick, right after traffic wrote them. Only a citizen still on that leg
 * moves: one recovery sent home, or already on another leg, is not teleported by a late arrival.
 */
export function handleTripFinished(w: World): void {
  const arrivals = w.events.tripFinished;
  if (arrivals.length === 0) return;
  const nowSecs = fixedElapsedSecs(w);
  const now = gameMinute(w);
  const commute = w.commuteStats;
  for (const arrival of arrivals) {
    const c = w.citizens.get(arrival.citizen);
    if (c === undefined) continue;
    const expected = arrival.purpose === 'Work' ? 'ToWork' : arrival.purpose === 'Shop' ? 'ToShop' : 'ToHome';
    if (c.state !== expected) continue;

    if (c.tripDepartedAtSec !== null) {
      const secs = f32(Math.max(nowSecs - c.tripDepartedAtSec, 0));
      commute.avgCommuteSecs =
        commute.samples === 0 ? secs : f32(f32(commute.avgCommuteSecs * f32(1 - COMMUTE_EMA_ALPHA)) + f32(secs * COMMUTE_EMA_ALPHA));
      commute.samples += 1;
    }
    c.tripDepartedAtSec = null;
    c.tripPurpose = null;

    if (arrival.purpose === 'ReturnHome') {
      c.state = 'AtHome';
      c.tourMode = null;
      c.nextAt = null;
      c.nextPurpose = null;
      const home = w.buildings.get(c.home);
      // Where the trip home parked: the side of home towards the place it came from.
      if (home !== undefined) c.carParkedAt = entrance(w, home, c.lastPlace);
    } else {
      c.state = arrival.purpose === 'Work' ? 'AtWork' : 'AtShop';
      c.nextAt = now + (arrival.purpose === 'Work' ? c.shiftMinutes : rangeU32(w.simRng, SHOP_VISIT_MINUTES[0], SHOP_VISIT_MINUTES[1] + 1));
      c.nextPurpose = 'ReturnHome';
      if (c.tourMode === 'Car') c.carParkedAt = c.lastPlace;
    }
  }
}

/**
 * `recover_stuck_trips` (SimStep::Citizens): a trip whose car never spawned yields no arrival, and a citizen in transit
 * makes no plans, so past the timeout such a citizen goes back home. A trip with its car on the road or waiting in the
 * backlog is not orphaned however long it takes; Rust sent those drivers home too.
 */
export function recoverStuckTrips(w: World): void {
  const now = fixedElapsedSecs(w);
  const v = w.vehicles;
  let riding: Set<number> | undefined;
  for (const c of w.citizens.all()) {
    if (c.state !== 'ToWork' && c.state !== 'ToShop' && c.state !== 'ToHome') continue;
    if (c.tripDepartedAtSec === null || now - c.tripDepartedAtSec <= CITIZEN_TRIP_TIMEOUT_SECS) continue;
    if (riding === undefined) {
      riding = new Set<number>();
      for (const slot of v.order) if (v.parked[slot] !== 1 && v.passengerCitizen[slot] !== -1) riding.add(v.passengerCitizen[slot]!);
      for (const trip of w.tripBacklog) riding.add(trip.citizen);
    }
    if (riding.has(c.id)) continue;
    c.state = 'AtHome';
    const home = w.buildings.get(c.home);
    if (home !== undefined) c.carParkedAt = entrance(w, home, home.anchor);
    c.tourMode = null;
    c.nextAt = null;
    c.nextPurpose = null;
    c.tripDepartedAtSec = null;
    c.tripPurpose = null;
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
