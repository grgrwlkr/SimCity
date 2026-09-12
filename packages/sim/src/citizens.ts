// Port of crates/simcity_sim/src/game/citizens.rs: residents of open homes, their day and their trips, and the recovery
// of trips that never arrive. Where TS departs from Rust:
// - home and workplace are building ids; in Rust they were anchor tiles, so a worker kept a job at whatever new
//   building grew on the same anchor;
// - a citizen keeps a day on the game clock: to work in the morning, home after the shift, shopping at a shop near home
//   in the evening (by day without a job), nobody setting out at night. Rust decided on timers of real seconds, a
//   decision every 1–3 s and shopping at any shop in town every 9–18 s, so with a car crossing town in more than a game
//   day the whole city drove all the time;
// - citizens are typed arrays with a queue of game minutes (stage 3½b): the planner looks only at citizens whose minute
//   has come, and the counts by state, home and workplace are kept as they change, for a city of a million;
// - a citizen walks a short trip, a trip without a car, and one with nowhere to park in reach; the car of one who
//   drives is a vehicle only while it drives, and otherwise holds a parking spot (stage 3½b). Rust drove every trip.
import { isOperational, type Building } from './buildings/building';
import { MINUTES_PER_DAY, gameMinute } from './city';
import type { TilePos } from './commands';
import type { TripMode } from './events';
import {
  CAR_DRIVING,
  CAR_NONE,
  CAR_OWNERSHIP,
  CAR_PARKED,
  CAR_STATUSES,
  NO_PLACE,
  findParking,
  giveCar,
  placeTile,
  type CarStatus,
} from './parking';
import { randomBool, rangeU32 } from './rng';
import { fixedElapsedSecs } from './traffic/reservations';
import { TRIP_PURPOSES, type TripPurpose } from './traffic/vehicles';
import { footprintEntrance } from './transport/anchors';
import type { World } from './world';

const f32 = Math.fround;

/** A trip with no car on the road, none waiting for one and no walk under way is given up after this long, real seconds. */
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
const TRIP_MODES = ['Walk', 'Car'] as const satisfies readonly TripMode[];

const AT_HOME = CITIZEN_STATES.indexOf('AtHome');
const AT_WORK = CITIZEN_STATES.indexOf('AtWork');
const AT_SHOP = CITIZEN_STATES.indexOf('AtShop');
const TO_WORK = CITIZEN_STATES.indexOf('ToWork');
const TO_SHOP = CITIZEN_STATES.indexOf('ToShop');
const TO_HOME = CITIZEN_STATES.indexOf('ToHome');
const WALK = TRIP_MODES.indexOf('Walk');
const CAR = TRIP_MODES.indexOf('Car');
const NONE = -1;

/** Bits of a citizen reference that name its slot: room for two million citizens. */
export const CITIZEN_SLOT_BITS = 21;
const SLOT_COUNT = 1 << CITIZEN_SLOT_BITS;
/** Generations a slot counts through before it wraps; with them a reference still fits the `Int32Array`s of vehicles. */
const GENERATIONS = 1 << 10;
const INITIAL_CAPACITY = 1024;

/** The slot a citizen reference names, live or not. */
export function citizenSlot(ref: number): number {
  return ref & (SLOT_COUNT - 1);
}

/** A citizen as plain data: what `add` takes and, with its reference, what `view` gives. */
export interface CitizenSpec {
  /** The residential building the citizen lives in. */
  readonly home: number;
  readonly state: CitizenState;
  /** The last place other than home the citizen travelled to. */
  readonly lastPlace: TilePos;
  /** The mode of the tour in progress, home to home. */
  readonly tourMode: TripMode | null;
  /** Whether the citizen has a car, and whether it stands or drives. `add` takes no spot for it: `giveCar` does. */
  readonly carStatus: CarStatus;
  /** The spot the car holds, or is driving to (`parking.ts` addresses). */
  readonly carPlace: number;
  /** The tile the car stands on, or will. */
  readonly carParkedAt: TilePos;
  /** The building the citizen works at. */
  readonly workplace: number | null;
  /** Minute of the day the citizen leaves for work. */
  readonly workDeparture: number;
  /** Minutes the citizen stays at work. */
  readonly shiftMinutes: number;
  /** Game minute of the next move: setting out for `nextPurpose`, or thinking the day over when it is `null`. */
  readonly nextAt: number | null;
  readonly nextPurpose: TripPurpose | null;
  /** The last day the citizen decided whether to go shopping. */
  readonly shoppingDecidedDay: number;
  /** Fixed-step seconds the trip in progress departed at. */
  readonly tripDepartedAtSec: number | null;
  readonly tripPurpose: TripPurpose | null;
}

export interface CitizenView extends CitizenSpec {
  readonly ref: number;
}

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

/** A citizen at home in `home`, with no job, no car and no plans yet. */
export function newCitizen(home: Building, day: CitizenDay = {}): CitizenSpec {
  return {
    home: home.id,
    state: 'AtHome',
    lastPlace: home.anchor,
    tourMode: null,
    carStatus: 'None',
    carPlace: NO_PLACE,
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

/** Citizens waiting for a game minute: a bucket per minute, the minutes in a binary min-heap. */
export class MinuteQueue {
  private readonly buckets = new Map<number, number[]>();
  private readonly heap: number[] = [];

  push(minute: number, ref: number): void {
    let bucket = this.buckets.get(minute);
    if (bucket === undefined) {
      bucket = [];
      this.buckets.set(minute, bucket);
      const heap = this.heap;
      heap.push(minute);
      for (let i = heap.length - 1; i > 0; ) {
        const parent = (i - 1) >> 1;
        if (heap[parent]! <= minute) break;
        heap[i] = heap[parent]!;
        heap[parent] = minute;
        i = parent;
      }
    }
    bucket.push(ref);
  }

  /** The earliest minute anyone waits for. */
  peek(): number | undefined {
    return this.heap[0];
  }

  /** Takes the bucket of the earliest minute. */
  pop(): number[] {
    const heap = this.heap;
    const minute = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const left = 2 * i + 1;
        const right = left + 1;
        let least = i;
        if (left < heap.length && heap[left]! < heap[least]!) least = left;
        if (right < heap.length && heap[right]! < heap[least]!) least = right;
        if (least === i) break;
        heap[i] = heap[least]!;
        heap[least] = last;
        i = least;
      }
    }
    const refs = this.buckets.get(minute) ?? [];
    this.buckets.delete(minute);
    return refs;
  }

  /** Every bucket by its minute, earliest first. */
  entries(): Array<readonly [minute: number, refs: readonly number[]]> {
    return [...this.buckets].sort(([a], [b]) => a - b);
  }

  clear(): void {
    this.buckets.clear();
    this.heap.length = 0;
  }
}

type Layer = Uint8Array | Int8Array | Uint16Array | Int32Array | Float64Array;

function grown<T extends Layer>(layer: T, capacity: number, fill: number): T {
  const next = new (layer.constructor as new (length: number) => T)(capacity);
  (next as Layer).set(layer as never);
  if (fill !== 0) next.fill(fill, layer.length);
  return next;
}

const countUp = (counts: Map<number, number>, key: number, by: number) => {
  const next = (counts.get(key) ?? 0) + by;
  if (next === 0) counts.delete(key);
  else counts.set(key, next);
};

/** The citizens of the city as typed arrays by slot. A citizen is referred to as `slot + generation × 2²¹`. */
export class Citizens {
  capacity = 0;
  /** Slots ever taken; the live ones below it have `alive` set. */
  highWater = 0;
  count = 0;
  /** Move-ins so far: the surplus of a home leaves the last to move in first. */
  moveIns = 0;
  /** Citizens the planner took off due minutes on its last run. */
  plannerWoken = 0;

  alive = new Uint8Array(0);
  generation = new Uint16Array(0);
  movedIn = new Float64Array(0);
  home = new Int32Array(0);
  /** A building id, -1 without a job. */
  workplace = new Int32Array(0);
  /** `CITIZEN_STATES` index. */
  state = new Uint8Array(0);
  lastPlaceX = new Int32Array(0);
  lastPlaceY = new Int32Array(0);
  /** Where the trip under way ends, on foot after the car parks. */
  destX = new Int32Array(0);
  destY = new Int32Array(0);
  /** `TRIP_MODES` index, -1 between tours. */
  tourMode = new Int8Array(0);
  /** `CAR_STATUSES` index. */
  carStatus = new Uint8Array(0);
  /** A `parking.ts` address, 0 without a car. */
  carPlace = new Int32Array(0);
  carX = new Int32Array(0);
  carY = new Int32Array(0);
  workDeparture = new Uint16Array(0);
  shiftMinutes = new Uint16Array(0);
  /** A game minute, -1 for no plan. */
  nextAt = new Int32Array(0);
  /** `TRIP_PURPOSES` index, -1 for thinking the day over. */
  nextPurpose = new Int8Array(0);
  shoppingDecidedDay = new Int32Array(0);
  /** NaN outside a trip. */
  tripDepartedAtSec = new Float64Array(0);
  tripPurpose = new Int8Array(0);

  /** Free slots, reused last-in first-out. */
  readonly freeSlots: number[] = [];
  /** Citizens at home with no plan: the planner plans them on its next run. */
  unplanned: number[] = [];
  readonly queue = new MinuteQueue();
  private readonly stateCounts = new Int32Array(CITIZEN_STATES.length);
  private readonly residents = new Map<number, number>();
  private readonly workers = new Map<number, number>();

  get full(): boolean {
    return this.freeSlots.length === 0 && this.highWater === SLOT_COUNT;
  }

  ref(slot: number): number {
    return slot + this.generation[slot]! * SLOT_COUNT;
  }

  /** The slot of a live citizen, or `undefined` when the reference is stale. */
  resolve(ref: number): number | undefined {
    const slot = citizenSlot(ref);
    return ref >= 0 && slot < this.highWater && this.alive[slot] === 1 && this.ref(slot) === ref ? slot : undefined;
  }

  add(spec: CitizenSpec): number {
    let slot = this.freeSlots.pop();
    if (slot === undefined) {
      if (this.highWater === SLOT_COUNT) throw new RangeError(`more than ${SLOT_COUNT} citizens`);
      if (this.highWater === this.capacity) this.grow();
      slot = this.highWater;
      this.highWater += 1;
    }
    this.alive[slot] = 1;
    this.moveIns += 1;
    this.movedIn[slot] = this.moveIns;
    this.home[slot] = spec.home;
    this.workplace[slot] = spec.workplace ?? NONE;
    this.state[slot] = CITIZEN_STATES.indexOf(spec.state);
    this.lastPlaceX[slot] = spec.lastPlace.x;
    this.lastPlaceY[slot] = spec.lastPlace.y;
    this.destX[slot] = spec.lastPlace.x;
    this.destY[slot] = spec.lastPlace.y;
    this.tourMode[slot] = spec.tourMode === null ? NONE : TRIP_MODES.indexOf(spec.tourMode);
    this.carStatus[slot] = CAR_STATUSES.indexOf(spec.carStatus);
    this.carPlace[slot] = spec.carPlace;
    this.carX[slot] = spec.carParkedAt.x;
    this.carY[slot] = spec.carParkedAt.y;
    this.workDeparture[slot] = spec.workDeparture;
    this.shiftMinutes[slot] = spec.shiftMinutes;
    this.nextAt[slot] = NONE;
    this.nextPurpose[slot] = NONE;
    this.shoppingDecidedDay[slot] = spec.shoppingDecidedDay;
    this.tripDepartedAtSec[slot] = spec.tripDepartedAtSec ?? NaN;
    this.tripPurpose[slot] = spec.tripPurpose === null ? NONE : TRIP_PURPOSES.indexOf(spec.tripPurpose);
    this.count += 1;
    this.stateCounts[this.state[slot]!]! += 1;
    countUp(this.residents, spec.home, 1);
    if (spec.workplace !== null) countUp(this.workers, spec.workplace, 1);
    const ref = this.ref(slot);
    if (spec.nextAt !== null) this.schedule(slot, spec.nextAt, spec.nextPurpose);
    else if (spec.state === 'AtHome') this.unplanned.push(ref);
    return ref;
  }

  /** Takes the citizen out of the arrays; `removeCitizen` also frees their parking spot. */
  remove(ref: number): void {
    const slot = this.resolve(ref);
    if (slot === undefined) return;
    this.stateCounts[this.state[slot]!]! -= 1;
    countUp(this.residents, this.home[slot]!, -1);
    if (this.workplace[slot] !== NONE) countUp(this.workers, this.workplace[slot]!, -1);
    this.alive[slot] = 0;
    this.generation[slot] = (this.generation[slot]! + 1) % GENERATIONS;
    this.freeSlots.push(slot);
    this.count -= 1;
  }

  setState(slot: number, state: number): void {
    this.stateCounts[this.state[slot]!]! -= 1;
    this.state[slot] = state;
    this.stateCounts[state]! += 1;
  }

  setWorkplace(slot: number, building: number | null): void {
    if (this.workplace[slot] !== NONE) countUp(this.workers, this.workplace[slot]!, -1);
    this.workplace[slot] = building ?? NONE;
    if (building !== null) countUp(this.workers, building, 1);
  }

  /** Sets the next move and queues the citizen for its minute; `null` clears it without queueing. */
  schedule(slot: number, minute: number | null, purpose: TripPurpose | null): void {
    this.nextAt[slot] = minute ?? NONE;
    this.nextPurpose[slot] = purpose === null ? NONE : TRIP_PURPOSES.indexOf(purpose);
    if (minute !== null) this.queue.push(minute, this.ref(slot));
  }

  stateCount(state: CitizenState): number {
    return this.stateCounts[CITIZEN_STATES.indexOf(state)]!;
  }

  residentsOf(building: number): number {
    return this.residents.get(building) ?? 0;
  }

  workersOf(building: number): number {
    return this.workers.get(building) ?? 0;
  }

  /** Homes with residents and how many, in the order they were first lived in. */
  residentCounts(): IterableIterator<[home: number, residents: number]> {
    return this.residents.entries();
  }

  /** Live references in slot order. */
  refs(): number[] {
    const refs: number[] = [];
    for (let slot = 0; slot < this.highWater; slot++) if (this.alive[slot] === 1) refs.push(this.ref(slot));
    return refs;
  }

  /** A copy of the citizen as plain data. */
  view(ref: number): CitizenView | undefined {
    const slot = this.resolve(ref);
    if (slot === undefined) return undefined;
    const mode = this.tourMode[slot]!;
    const purpose = (index: number) => (index === NONE ? null : TRIP_PURPOSES[index]!);
    return {
      ref,
      home: this.home[slot]!,
      state: CITIZEN_STATES[this.state[slot]!]!,
      lastPlace: { x: this.lastPlaceX[slot]!, y: this.lastPlaceY[slot]! },
      tourMode: mode === NONE ? null : TRIP_MODES[mode]!,
      carStatus: CAR_STATUSES[this.carStatus[slot]!]!,
      carPlace: this.carPlace[slot]!,
      carParkedAt: { x: this.carX[slot]!, y: this.carY[slot]! },
      workplace: this.workplace[slot] === NONE ? null : this.workplace[slot]!,
      workDeparture: this.workDeparture[slot]!,
      shiftMinutes: this.shiftMinutes[slot]!,
      nextAt: this.nextAt[slot] === NONE ? null : this.nextAt[slot]!,
      nextPurpose: purpose(this.nextPurpose[slot]!),
      shoppingDecidedDay: this.shoppingDecidedDay[slot]!,
      tripDepartedAtSec: Number.isNaN(this.tripDepartedAtSec[slot]) ? null : this.tripDepartedAtSec[slot]!,
      tripPurpose: purpose(this.tripPurpose[slot]!),
    };
  }

  clear(): void {
    for (const name of LAYER_NAMES) this[name] = new (this[name].constructor as new (length: number) => never)(0);
    this.capacity = 0;
    this.highWater = 0;
    this.count = 0;
    this.moveIns = 0;
    this.plannerWoken = 0;
    this.freeSlots.length = 0;
    this.unplanned = [];
    this.queue.clear();
    this.stateCounts.fill(0);
    this.residents.clear();
    this.workers.clear();
  }

  private grow(): void {
    const capacity = Math.min(Math.max(this.capacity * 2, INITIAL_CAPACITY), SLOT_COUNT);
    const fills: Partial<Record<LayerName, number>> = { workplace: NONE, tourMode: NONE, nextAt: NONE, nextPurpose: NONE, tripDepartedAtSec: NaN, tripPurpose: NONE };
    for (const name of LAYER_NAMES) this[name] = grown(this[name] as Layer, capacity, fills[name] ?? 0) as never;
    this.capacity = capacity;
  }
}

/** Every per-slot layer of `Citizens`, in the order the fingerprint hashes them. */
export const LAYER_NAMES = [
  'alive',
  'generation',
  'movedIn',
  'home',
  'workplace',
  'state',
  'lastPlaceX',
  'lastPlaceY',
  'destX',
  'destY',
  'tourMode',
  'carStatus',
  'carPlace',
  'carX',
  'carY',
  'workDeparture',
  'shiftMinutes',
  'nextAt',
  'nextPurpose',
  'shoppingDecidedDay',
  'tripDepartedAtSec',
  'tripPurpose',
] as const satisfies ReadonlyArray<keyof Citizens>;
type LayerName = (typeof LAYER_NAMES)[number];

/** A citizen leaves the city, and the spot their car holds is freed. */
export function removeCitizen(w: World, ref: number): void {
  const c = w.citizens;
  const slot = c.resolve(ref);
  if (slot === undefined) return;
  if (c.carStatus[slot] !== CAR_NONE) w.parking.release(c.carPlace[slot]!);
  c.remove(ref);
}

/**
 * `spawn_citizens_from_residential` (SimStep::Citizens): open homes fill up to their occupancy, eight a tick. A newcomer
 * has a car by the class of the home, if the city has a spot for it.
 */
export function spawnCitizensFromResidential(w: World): void {
  const citizens = w.citizens;
  for (const b of w.buildings.all()) {
    if (b.kind !== 'Residential' || !isOperational(b)) continue;
    // No floor of one: a building at zero occupancy seats no one.
    const moving = Math.min(b.occupancyResidents - citizens.residentsOf(b.id), MAX_MOVING_IN_PER_TICK);
    for (let i = 0; i < moving; i++) {
      // A capacity never throws: a city past two million waits for someone to leave.
      if (citizens.full) return;
      const rng = w.simRng;
      const workDeparture = rangeU32(rng, WORK_DEPARTURE_WINDOW[0], WORK_DEPARTURE_WINDOW[1]);
      const shiftMinutes = rangeU32(rng, SHIFT_MINUTES[0], SHIFT_MINUTES[1] + 1);
      const ref = citizens.add(newCitizen(b, { workDeparture, shiftMinutes }));
      if (randomBool(rng, CAR_OWNERSHIP[b.profile.class])) giveCar(w, ref);
    }
  }
}

/**
 * Where a trip to or from `b` leaves and arrives: the footprint tile beside its road towards `towards`. Rust used the
 * anchor, and the vehicle spawn dropped the trips of every building whose anchor corner faced away from its road.
 */
function entrance(w: World, b: Building, towards: TilePos): TilePos {
  return footprintEntrance(w.grid, b.anchor, b.width, b.length, towards);
}

const tripMeters = (w: World, from: TilePos, to: TilePos) => (Math.abs(from.x - to.x) + Math.abs(from.y - to.y)) * w.trafficConfig.tileMeters;

/** Whole game minutes a walk from `from` to `to` takes, rounded up. */
function walkMinutes(w: World, from: TilePos, to: TilePos): number {
  return Math.ceil((tripMeters(w, from, to) * 60) / (w.citizenConfig.walkKmh * 1000));
}

function setOut(w: World, slot: number, to: TilePos, purpose: TripPurpose, nowSecs: number): void {
  const c = w.citizens;
  c.setState(slot, purpose === 'Work' ? TO_WORK : purpose === 'Shop' ? TO_SHOP : TO_HOME);
  if (purpose !== 'ReturnHome') {
    c.lastPlaceX[slot] = to.x;
    c.lastPlaceY[slot] = to.y;
  }
  c.destX[slot] = to.x;
  c.destY[slot] = to.y;
  c.tripDepartedAtSec[slot] = nowSecs;
  c.tripPurpose[slot] = TRIP_PURPOSES.indexOf(purpose);
}

/** On foot from `from` at game minute `minute`: the arrival waits in the queue. */
function departOnFoot(w: World, slot: number, from: TilePos, to: TilePos, purpose: TripPurpose, minute: number, nowSecs: number): void {
  const c = w.citizens;
  w.events.tripRequested.push({ citizen: c.ref(slot), from, carParkedAt: null, to, purpose, mode: 'Walk' });
  setOut(w, slot, to, purpose, nowSecs);
  c.schedule(slot, minute + walkMinutes(w, from, to), purpose);
}

/** By car from its spot to `spot`, which it takes now; the one it leaves is free. The walk to `to` follows the arrival. */
function departByCar(w: World, slot: number, to: TilePos, spot: number, purpose: TripPurpose, nowSecs: number): void {
  const c = w.citizens;
  const from = placeTile(w, c.carPlace[slot]!, to);
  const parkAt = placeTile(w, spot, from);
  w.parking.release(c.carPlace[slot]!);
  w.parking.take(spot);
  c.carStatus[slot] = CAR_DRIVING;
  c.carPlace[slot] = spot;
  c.carX[slot] = parkAt.x;
  c.carY[slot] = parkAt.y;
  w.events.tripRequested.push({ citizen: c.ref(slot), from, carParkedAt: from, to: parkAt, purpose, mode: 'Car', pocket: true });
  setOut(w, slot, to, purpose, nowSecs);
  c.schedule(slot, null, null);
}

/**
 * The spot a tour from `from` to `to` drives to, or `NO_PLACE` to walk it: no car, a car beyond walking reach, a trip
 * short enough to walk, or no spot within walking reach of `to` on a trip too short to drive to a spot farther away.
 */
function tourSpot(w: World, slot: number, from: TilePos, to: TilePos, destination: number): number {
  const c = w.citizens;
  const cfg = w.citizenConfig;
  if (c.carStatus[slot] !== CAR_PARKED) return NO_PLACE;
  const meters = tripMeters(w, from, to);
  if (meters <= cfg.walkMaxMeters) return NO_PLACE;
  if (tripMeters(w, from, { x: c.carX[slot]!, y: c.carY[slot]! }) > cfg.parkingWalkMeters) return NO_PLACE;
  return findParking(w, to, destination, meters > cfg.farParkingTripMeters ? Infinity : cfg.parkingWalkMeters);
}

/**
 * The next move of a citizen at home: to work at their hour, shopping (decided once a day, when the shopping hours
 * have come), or thinking again when those hours open. A citizen planning at the very minute they leave for work
 * leaves now; every other time is after `now`. A re-plan never lands on `now`, so a plan that cannot be carried out
 * waits a minute.
 */
function planDay(w: World, slot: number, now: number, replan: boolean): void {
  const c = w.citizens;
  const minute = now % MINUTES_PER_DAY;
  const dayStart = now - minute;
  const employed = c.workplace[slot] !== NONE;
  const [open, close] = employed ? EVENING_SHOPPING : DAYTIME_SHOPPING;
  const decidedToday = c.shoppingDecidedDay[slot] === w.city.day;
  const departure = c.workDeparture[slot]!;

  let shopAt: number | undefined;
  let thinkAt = dayStart + MINUTES_PER_DAY + open;
  if (!decidedToday && minute >= open && minute < close) {
    c.shoppingDecidedDay[slot] = w.city.day;
    if (randomBool(w.simRng, employed ? EVENING_SHOPPING_CHANCE : DAYTIME_SHOPPING_CHANCE)) {
      shopAt = Math.min(now + rangeU32(w.simRng, SHOPPING_DELAY_MINUTES[0], SHOPPING_DELAY_MINUTES[1] + 1), dayStart + close);
    }
  } else if (!decidedToday && minute < open) {
    thinkAt = dayStart + open;
  }
  const workAt = employed ? (minute <= departure ? dayStart : dayStart + MINUTES_PER_DAY) + departure : undefined;

  const earliest = replan ? now + 1 : now;
  if (shopAt !== undefined && (workAt === undefined || shopAt <= workAt)) {
    c.schedule(slot, Math.max(shopAt, earliest), 'Shop');
  } else if (workAt !== undefined && workAt <= thinkAt) {
    c.schedule(slot, Math.max(workAt, earliest), 'Work');
  } else {
    c.schedule(slot, Math.max(thinkAt, earliest), null);
  }
}

/** One of the `NEAREST_SHOPS` open shops nearest `home`. */
function shopNear(w: World, home: Building, shops: readonly Building[]): Building | undefined {
  if (shops.length === 0) return undefined;
  const distance = (b: Building) => Math.abs(b.anchor.x - home.anchor.x) + Math.abs(b.anchor.y - home.anchor.y);
  const nearest = [...shops].sort((a, b) => distance(a) - distance(b) || a.id - b.id).slice(0, NEAREST_SHOPS);
  return nearest[rangeU32(w.simRng, 0, nearest.length)];
}

/** The trip ends at game minute `minute`: at work or a shop until the stay is over, or at home with a day to plan. */
function arrive(w: World, slot: number, purpose: TripPurpose, minute: number, nowSecs: number): void {
  const c = w.citizens;
  const commute = w.commuteStats;
  const departedAt = c.tripDepartedAtSec[slot]!;
  if (!Number.isNaN(departedAt)) {
    const secs = f32(Math.max(nowSecs - departedAt, 0));
    commute.avgCommuteSecs =
      commute.samples === 0 ? secs : f32(f32(commute.avgCommuteSecs * f32(1 - COMMUTE_EMA_ALPHA)) + f32(secs * COMMUTE_EMA_ALPHA));
    commute.samples += 1;
  }
  c.tripDepartedAtSec[slot] = NaN;
  c.tripPurpose[slot] = NONE;
  if (purpose === 'ReturnHome') {
    c.setState(slot, AT_HOME);
    c.tourMode[slot] = NONE;
    c.schedule(slot, null, null);
    c.unplanned.push(c.ref(slot));
  } else {
    c.setState(slot, purpose === 'Work' ? AT_WORK : AT_SHOP);
    const stay = purpose === 'Work' ? c.shiftMinutes[slot]! : rangeU32(w.simRng, SHOP_VISIT_MINUTES[0], SHOP_VISIT_MINUTES[1] + 1);
    c.schedule(slot, minute + stay, 'ReturnHome');
  }
}

/**
 * `citizen_trip_planner` (SimStep::Citizens), once a game minute: citizens with no plan make one, then those whose
 * minute has come, minute by minute, act on it. A walk under way arrives; a citizen at work or at a shop goes home when
 * the stay is over; one at home sets out, or thinks again when the job is lost or no shop is open.
 */
export function citizenTripPlanner(w: World): void {
  const shopping = w.shoppingStats;
  if (w.events.dayAdvanced.length > 0) {
    shopping.unmetRatio = shopping.demandEvents > 0 ? f32(shopping.unmetEvents / shopping.demandEvents) : 0;
    shopping.demandEvents = 0;
    shopping.unmetEvents = 0;
  }
  const c = w.citizens;
  const now = gameMinute(w);
  const nowSecs = fixedElapsedSecs(w);
  let shops: Building[] | undefined;

  const unplanned = c.unplanned;
  c.unplanned = [];
  for (const ref of unplanned) {
    const slot = c.resolve(ref);
    if (slot !== undefined && c.state[slot] === AT_HOME && c.nextAt[slot] === NONE) planDay(w, slot, now, false);
  }

  let woken = 0;
  for (let minute = c.queue.peek(); minute !== undefined && minute <= now; minute = c.queue.peek()) {
    for (const ref of c.queue.pop()) {
      const slot = c.resolve(ref);
      // A citizen re-planned or on the road since is no longer waiting for this minute.
      if (slot === undefined || c.nextAt[slot] !== minute) continue;
      woken += 1;
      const purpose = c.nextPurpose[slot] === NONE ? null : TRIP_PURPOSES[c.nextPurpose[slot]!]!;
      const state = c.state[slot];
      if (state === TO_WORK || state === TO_SHOP || state === TO_HOME) {
        arrive(w, slot, purpose ?? 'ReturnHome', minute, nowSecs);
        continue;
      }
      const home = w.buildings.get(c.home[slot]!);
      if (home === undefined) continue;
      const lastPlace = { x: c.lastPlaceX[slot]!, y: c.lastPlaceY[slot]! };

      if (state === AT_WORK || state === AT_SHOP) {
        const doorstep = entrance(w, home, lastPlace);
        // Home the way the tour went; a car with nowhere to stand in the whole city stays put, and its citizen walks.
        const spot = c.tourMode[slot] === CAR && c.carStatus[slot] === CAR_PARKED ? findParking(w, doorstep, home.id, Infinity) : NO_PLACE;
        if (spot === NO_PLACE) departOnFoot(w, slot, lastPlace, doorstep, 'ReturnHome', minute, nowSecs);
        else departByCar(w, slot, doorstep, spot, 'ReturnHome', nowSecs);
        continue;
      }
      if (state !== AT_HOME) continue;

      let destination: Building | undefined;
      if (purpose === 'Work' && c.workplace[slot] !== NONE) {
        destination = w.buildings.get(c.workplace[slot]!);
      } else if (purpose === 'Shop') {
        shopping.demandEvents += 1;
        shops ??= w.buildings.all().filter((b) => b.kind === 'Commercial' && isOperational(b));
        destination = shopNear(w, home, shops);
        if (destination === undefined) shopping.unmetEvents += 1;
      }
      if (destination === undefined || purpose === null) {
        planDay(w, slot, now, true);
        continue;
      }
      // Tours start at home, from the side of it on the road towards where they go.
      const from = entrance(w, home, destination.anchor);
      const to = entrance(w, destination, home.anchor);
      const spot = tourSpot(w, slot, from, to, destination.id);
      c.tourMode[slot] = spot === NO_PLACE ? WALK : CAR;
      if (spot === NO_PLACE) departOnFoot(w, slot, from, to, purpose, minute, nowSecs);
      else departByCar(w, slot, to, spot, purpose, nowSecs);
    }
  }
  c.plannerWoken = woken;
}

/**
 * `handle_trip_finished`: cars of this tick's trips arrived, right after traffic wrote them. Only a citizen still on
 * that leg moves: one recovery sent home, or already on another leg, is not teleported by a late arrival. The car
 * stands at its spot; its citizen walks the rest.
 */
export function handleTripFinished(w: World): void {
  const arrivals = w.events.tripFinished;
  if (arrivals.length === 0) return;
  const c = w.citizens;
  const nowSecs = fixedElapsedSecs(w);
  const now = gameMinute(w);
  for (const arrival of arrivals) {
    const slot = c.resolve(arrival.citizen);
    if (slot === undefined) continue;
    const expected = arrival.purpose === 'Work' ? TO_WORK : arrival.purpose === 'Shop' ? TO_SHOP : TO_HOME;
    if (c.state[slot] !== expected) continue;
    if (c.carStatus[slot] === CAR_DRIVING) {
      c.carStatus[slot] = CAR_PARKED;
      const walk = walkMinutes(w, { x: c.carX[slot]!, y: c.carY[slot]! }, { x: c.destX[slot]!, y: c.destY[slot]! });
      if (walk > 0) {
        c.schedule(slot, now + walk, arrival.purpose);
        continue;
      }
    }
    arrive(w, slot, arrival.purpose, now, nowSecs);
  }
}

/**
 * `recover_stuck_trips` (SimStep::Citizens): a trip whose car never spawned yields no arrival, and a citizen in transit
 * makes no plans, so past the timeout such a citizen goes back home, the car standing at the spot it was going to. A
 * trip with its car on the road or waiting in the backlog, or a walk, is not orphaned however long it takes; Rust sent
 * those drivers home too.
 */
export function recoverStuckTrips(w: World): void {
  const now = fixedElapsedSecs(w);
  const c = w.citizens;
  const v = w.vehicles;
  let riding: Set<number> | undefined;
  for (let slot = 0; slot < c.highWater; slot++) {
    if (c.alive[slot] !== 1 || c.nextAt[slot] !== NONE) continue;
    const state = c.state[slot];
    if (state !== TO_WORK && state !== TO_SHOP && state !== TO_HOME) continue;
    const departedAt = c.tripDepartedAtSec[slot]!;
    if (Number.isNaN(departedAt) || now - departedAt <= CITIZEN_TRIP_TIMEOUT_SECS) continue;
    if (riding === undefined) {
      riding = new Set<number>();
      for (const vehicle of v.order) if (v.parked[vehicle] !== 1 && v.passengerCitizen[vehicle] !== -1) riding.add(v.passengerCitizen[vehicle]!);
      for (const trip of w.tripBacklog) riding.add(trip.citizen);
    }
    const ref = c.ref(slot);
    if (riding.has(ref)) continue;
    c.setState(slot, AT_HOME);
    if (c.carStatus[slot] === CAR_DRIVING) c.carStatus[slot] = CAR_PARKED;
    c.tourMode[slot] = NONE;
    c.schedule(slot, null, null);
    c.unplanned.push(ref);
    c.tripDepartedAtSec[slot] = NaN;
    c.tripPurpose[slot] = NONE;
  }
}

/**
 * `cleanup_homeless_citizens` (PostSimStep::Citizens): a home that is gone, not open or holds fewer than live there
 * loses the surplus, the last to move in first. Only the residents of such homes are looked at.
 */
export function cleanupHomelessCitizens(w: World): void {
  const c = w.citizens;
  const limits = new Map<number, number>();
  for (const [homeId, residents] of c.residentCounts()) {
    const home = w.buildings.get(homeId);
    const limit = home !== undefined && home.kind === 'Residential' && isOperational(home) ? home.occupancyResidents : 0;
    if (residents > limit) limits.set(homeId, limit);
  }
  if (limits.size === 0) return;

  const byHome = new Map<number, number[]>();
  for (const homeId of limits.keys()) byHome.set(homeId, []);
  for (let slot = 0; slot < c.highWater; slot++) if (c.alive[slot] === 1) byHome.get(c.home[slot]!)?.push(slot);
  for (const [homeId, slots] of byHome) {
    slots.sort((a, b) => c.movedIn[a]! - c.movedIn[b]!);
    const refs = slots.slice(limits.get(homeId)!).map((slot) => c.ref(slot));
    for (const ref of refs) removeCitizen(w, ref);
  }
}
