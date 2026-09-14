// Port of crates/simcity_sim/src/game/citizens.rs: residents of open homes, their day and their trips, and the recovery
// of trips that never arrive. Where TS departs from Rust:
// - home and workplace are building ids; in Rust they were anchor tiles, so a worker kept a job at whatever new
//   building grew on the same anchor;
// - a citizen keeps a day on the game clock: an agenda of tours from home, each a chain of stops in any order — work,
//   shops, a café, a park — closed by the way back. A worker may stop at a café on the way to work and at a shop or the
//   park after it; a day off holds a tour or two. Rust decided on timers of real seconds, a decision every 1–3 s and
//   shopping at any shop in town every 9–18 s, so with a car crossing town in more than a game day the whole city
//   drove all the time;
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
import { NearestBuildings } from './nearest';
import { randomBool, rangeU32, shuffle } from './rng';
import { fixedElapsedSecs } from './traffic/reservations';
import { TRIP_PURPOSES, type TripPurpose } from './traffic/vehicles';
import { footprintEntrance } from './transport/anchors';
import { LIT_CROSSING_WAIT_SECS, walkMeasure } from './walkers';
import type { World } from './world';

const f32 = Math.fround;

/** A trip with no car on the road, none waiting for one and no walk under way is given up after this long, real seconds. */
export const CITIZEN_TRIP_TIMEOUT_SECS = 180;
/** At most this many move into one building a tick. */
const MAX_MOVING_IN_PER_TICK = 8;
const COMMUTE_EMA_ALPHA = f32(0.15);

/** Minutes of the day a citizen starts work in: 06:00 to 09:00. They leave earlier by the trip. */
export const WORK_START_WINDOW = [6 * 60, 9 * 60] as const;
/** A car trip with no district times yet is measured as the crow flies at this speed, km/h. */
const CROW_FLIES_KMH = 40;
/** A shift, minutes: eight to nine hours. */
export const SHIFT_MINUTES = [8 * 60, 9 * 60] as const;
/** Stays at the stops of a day, minutes. */
export const SHOP_VISIT_MINUTES = [20, 60] as const;
export const CAFE_VISIT_MINUTES = [20, 60] as const;
export const CAFE_BEFORE_WORK_MINUTES = [10, 25] as const;
export const PARK_VISIT_MINUTES = [30, 120] as const;
/** A shopper goes to one of this many open shops nearest where they are; a café or a park, one of the nearest three. */
export const NEAREST_SHOPS = 5;
const NEAREST_PLACES = 3;
/** When the tours of a day off and the evening outing leave home, minutes of the day. */
const FREE_MORNING_LEAVE = [9 * 60, 11 * 60 + 30] as const;
const FREE_AFTERNOON_LEAVE = [14 * 60, 17 * 60] as const;
const EVENING_OUTING_LEAVE = [19 * 60, 21 * 60] as const;
/** A citizen with nothing more to do today plans tomorrow in the small hours, 01:00 to 05:00, by their slot: a few a minute. */
const DAY_PLAN_WINDOW = [60, 5 * 60] as const;
/** A tour more than this late when its citizen gets home is dropped rather than started. */
const LATE_TOUR_MINUTES = 60;
/** Stops an agenda holds, the ways home included. */
export const AGENDA_STOPS = 8;

export const CITIZEN_STATES = ['AtHome', 'ToWork', 'AtWork', 'ToShop', 'AtShop', 'ToHome', 'ToCafe', 'AtCafe', 'ToPark', 'AtPark'] as const;
export type CitizenState = (typeof CITIZEN_STATES)[number];
const TRIP_MODES = ['Walk', 'Car'] as const satisfies readonly TripMode[];

const NONE = -1;
const AT_HOME = CITIZEN_STATES.indexOf('AtHome');
const TO_HOME = CITIZEN_STATES.indexOf('ToHome');
const TRAVEL_STATE: Readonly<Record<TripPurpose, number>> = {
  Work: CITIZEN_STATES.indexOf('ToWork'),
  Shop: CITIZEN_STATES.indexOf('ToShop'),
  ReturnHome: TO_HOME,
  Cafe: CITIZEN_STATES.indexOf('ToCafe'),
  Park: CITIZEN_STATES.indexOf('ToPark'),
  // Trips of the region, never of a citizen.
  Freight: NONE,
  Through: NONE,
};
const STAY_STATE: Readonly<Record<TripPurpose, number>> = {
  Work: CITIZEN_STATES.indexOf('AtWork'),
  Shop: CITIZEN_STATES.indexOf('AtShop'),
  ReturnHome: AT_HOME,
  Cafe: CITIZEN_STATES.indexOf('AtCafe'),
  Park: CITIZEN_STATES.indexOf('AtPark'),
  Freight: NONE,
  Through: NONE,
};
const isTravelling = (state: number) => CITIZEN_STATES[state]!.startsWith('To');
const isStaying = (state: number) => state !== AT_HOME && CITIZEN_STATES[state]!.startsWith('At');
const RETURN_HOME = TRIP_PURPOSES.indexOf('ReturnHome');
const WALK = TRIP_MODES.indexOf('Walk');
const CAR = TRIP_MODES.indexOf('Car');

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
  /** In the labour force: works or looks for work. Children, students and retirees are not. */
  readonly worker: boolean;
  /** Minute of the day the citizen starts work; they leave earlier by the trip they expect. */
  readonly workStart: number;
  /** Minutes the citizen stays at work. */
  readonly shiftMinutes: number;
  /** Game minute of the next move: setting out for `nextPurpose`, or thinking the day over when it is `null`. */
  readonly nextAt: number | null;
  readonly nextPurpose: TripPurpose | null;
  /** The day the agenda was planned for; 0 before the first. */
  readonly agendaDay: number;
  /** Fixed-step seconds the trip in progress departed at. */
  readonly tripDepartedAtSec: number | null;
  readonly tripPurpose: TripPurpose | null;
}

export interface CitizenView extends CitizenSpec {
  readonly ref: number;
}

/** A stop of a day's agenda. `ReturnHome` closes a tour; the next stop, if any, starts another from home. */
export interface AgendaStop {
  readonly purpose: TripPurpose;
  readonly building?: number;
  /** For the first stop of a tour: the minute of the day it leaves home. */
  readonly leaveAt?: number;
  /** For a stop the tour is timed by (work): the minute of the day to arrive by. */
  readonly arriveBy?: number;
  /** Minutes at the stop. */
  readonly stay?: number;
}

export interface ShoppingDemandStats {
  /** Shopping stops planned over the day so far. */
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
  /** Minute of the day the citizen starts work; 07:00 when not given. */
  readonly workStart?: number;
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
    worker: true,
    workStart: day.workStart ?? 7 * 60,
    shiftMinutes: day.shiftMinutes ?? 8 * 60,
    nextAt: null,
    nextPurpose: null,
    agendaDay: 0,
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

type Layer = Uint8Array | Int8Array | Uint16Array | Int16Array | Int32Array | Float32Array | Float64Array;

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
  /** Citizens on foot. */
  onFootCount = 0;
  readonly mapWidth: number;
  readonly mapHeight: number;

  alive = new Uint8Array(0);
  generation = new Uint16Array(0);
  movedIn = new Float64Array(0);
  home = new Int32Array(0);
  /** A building id, -1 without a job. */
  workplace = new Int32Array(0);
  /** 1 in the labour force. */
  worker = new Uint8Array(0);
  /** `CITIZEN_STATES` index. */
  state = new Uint8Array(0);
  lastPlaceX = new Int32Array(0);
  lastPlaceY = new Int32Array(0);
  /** Where the trip under way ends, on foot after the car parks. */
  destX = new Int32Array(0);
  destY = new Int32Array(0);
  /** `TRIP_MODES` index, -1 between tours. */
  tourMode = new Int8Array(0);
  /** The leg under way is walked, so its arrival counts as a walk. */
  walking = new Uint8Array(0);
  /** 1 while on foot: a walked leg, or the way from where the car stands to the door. `walkers.ts` draws them. */
  onFoot = new Uint8Array(0);
  /** Where the walk under way started, and how far along its path the walker is, tiles. */
  walkFromX = new Int32Array(0);
  walkFromY = new Int32Array(0);
  walkProgress = new Float32Array(0);
  /** `CAR_STATUSES` index. */
  carStatus = new Uint8Array(0);
  /** A `parking.ts` address, 0 without a car. */
  carPlace = new Int32Array(0);
  carX = new Int32Array(0);
  carY = new Int32Array(0);
  workStart = new Uint16Array(0);
  shiftMinutes = new Uint16Array(0);
  /** A game minute, -1 for no plan. */
  nextAt = new Int32Array(0);
  /** `TRIP_PURPOSES` index, -1 for thinking the day over. */
  nextPurpose = new Int8Array(0);
  agendaDay = new Int32Array(0);
  agendaLength = new Uint8Array(0);
  /** The stop being travelled to or stayed at, or the next tour's first stop at home. */
  agendaCursor = new Uint8Array(0);
  /** NaN outside a trip. */
  tripDepartedAtSec = new Float64Array(0);
  tripPurpose = new Int8Array(0);

  // The stops of each agenda, `AGENDA_STOPS` a citizen.
  /** `TRIP_PURPOSES` index. */
  agendaPurpose = new Int8Array(0);
  agendaBuilding = new Int32Array(0);
  agendaStay = new Uint16Array(0);
  /** Minute of the day the tour leaves home, -1 when it does not start here or is timed by an arrival. */
  agendaLeave = new Int16Array(0);
  /** Minute of the day to arrive by, -1 for none. */
  agendaArrive = new Int16Array(0);

  /** Derived, not state: the slots on foot in no particular order, and where each is in that list (-1 when not on foot). */
  private readonly walkerList: number[] = [];
  private walkerIndex = new Int32Array(0);
  /**
   * Derived, not state: how far a walker's progress may go by a plain add, the end of the path segment it walks; -1 when
   * its next step has to look at the path (a crossing to wait at, the end, a walk just begun).
   */
  walkLimit = new Float32Array(0);
  /** Derived, not state: the cars standing on each tile of the map. */
  private parked: Uint16Array;

  /** Free slots, reused last-in first-out. */
  readonly freeSlots: number[] = [];
  /** Citizens at home with no plan: the planner plans them on its next run. */
  unplanned: number[] = [];
  /** Citizens without a job, oldest first: `assignJobs` works through them. */
  jobSeekers: number[] = [];
  readonly queue = new MinuteQueue();
  private readonly stateCounts = new Int32Array(CITIZEN_STATES.length);
  private readonly residents = new Map<number, number>();
  private readonly workers = new Map<number, number>();

  constructor(mapWidth = 0, mapHeight = 0) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.parked = new Uint16Array(mapWidth * mapHeight);
  }

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
    this.worker[slot] = spec.worker ? 1 : 0;
    this.state[slot] = CITIZEN_STATES.indexOf(spec.state);
    this.lastPlaceX[slot] = spec.lastPlace.x;
    this.lastPlaceY[slot] = spec.lastPlace.y;
    this.destX[slot] = spec.lastPlace.x;
    this.destY[slot] = spec.lastPlace.y;
    this.tourMode[slot] = spec.tourMode === null ? NONE : TRIP_MODES.indexOf(spec.tourMode);
    this.walking[slot] = 0;
    this.onFoot[slot] = 0;
    this.carStatus[slot] = CAR_NONE;
    this.setCar(slot, CAR_STATUSES.indexOf(spec.carStatus), spec.carPlace, spec.carParkedAt.x, spec.carParkedAt.y);
    this.workStart[slot] = spec.workStart;
    this.shiftMinutes[slot] = spec.shiftMinutes;
    this.nextAt[slot] = NONE;
    this.nextPurpose[slot] = NONE;
    this.agendaDay[slot] = spec.agendaDay;
    this.agendaLength[slot] = 0;
    this.agendaCursor[slot] = 0;
    this.tripDepartedAtSec[slot] = spec.tripDepartedAtSec ?? NaN;
    this.tripPurpose[slot] = spec.tripPurpose === null ? NONE : TRIP_PURPOSES.indexOf(spec.tripPurpose);
    this.count += 1;
    this.stateCounts[this.state[slot]!]! += 1;
    countUp(this.residents, spec.home, 1);
    if (spec.workplace !== null) countUp(this.workers, spec.workplace, 1);
    const ref = this.ref(slot);
    if (spec.workplace === null && spec.worker) this.jobSeekers.push(ref);
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
    this.setOnFoot(slot, null);
    this.setCar(slot, CAR_NONE, this.carPlace[slot]!, this.carX[slot]!, this.carY[slot]!);
    this.alive[slot] = 0;
    this.generation[slot] = (this.generation[slot]! + 1) % GENERATIONS;
    this.freeSlots.push(slot);
    this.count -= 1;
  }

  /** Starts a walk from `from`, or with `null` ends the one under way. */
  setOnFoot(slot: number, from: TilePos | null): void {
    const was = this.onFoot[slot] === 1;
    if (from === null) {
      if (was) {
        this.onFootCount -= 1;
        const at = this.walkerIndex[slot]!;
        const last = this.walkerList.pop()!;
        if (last !== slot) {
          this.walkerList[at] = last;
          this.walkerIndex[last] = at;
        }
        this.walkerIndex[slot] = NONE;
      }
      this.onFoot[slot] = 0;
      return;
    }
    if (!was) {
      this.onFootCount += 1;
      this.walkerIndex[slot] = this.walkerList.length;
      this.walkerList.push(slot);
    }
    this.walkLimit[slot] = -1;
    this.onFoot[slot] = 1;
    this.walkFromX[slot] = from.x;
    this.walkFromY[slot] = from.y;
    this.walkProgress[slot] = 0;
  }

  /** The slots of the citizens on foot, in no particular order. */
  walkers(): readonly number[] {
    return this.walkerList;
  }

  /** Sets the car of `slot`: its status, the spot it holds and the tile it stands on, or drives to. */
  setCar(slot: number, status: number, place: number, x: number, y: number): void {
    if (this.carStatus[slot] === CAR_PARKED) this.countParked(this.carX[slot]!, this.carY[slot]!, -1);
    this.carStatus[slot] = status;
    this.carPlace[slot] = place;
    this.carX[slot] = x;
    this.carY[slot] = y;
    if (status === CAR_PARKED) this.countParked(x, y, 1);
  }

  /** Cars standing on each tile, row by row. */
  parkedCounts(): Uint16Array {
    return this.parked;
  }

  private countParked(x: number, y: number, by: number): void {
    if (x < 0 || y < 0 || x >= this.mapWidth || y >= this.mapHeight) return;
    const tile = y * this.mapWidth + x;
    this.parked[tile] = this.parked[tile]! + by;
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
    else if (this.worker[slot] === 1) this.jobSeekers.push(this.ref(slot));
  }

  /** Sets the next move and queues the citizen for its minute; `null` clears it without queueing. */
  schedule(slot: number, minute: number | null, purpose: TripPurpose | null): void {
    this.nextAt[slot] = minute ?? NONE;
    this.nextPurpose[slot] = purpose === null ? NONE : TRIP_PURPOSES.indexOf(purpose);
    if (minute !== null) this.queue.push(minute, this.ref(slot));
  }

  /** Replaces the agenda of `day` from its first stop; a citizen at home plans their next move by it. */
  setAgenda(ref: number, day: number, stops: readonly AgendaStop[]): void {
    const slot = this.resolve(ref);
    if (slot === undefined) return;
    this.writeAgenda(slot, day, stops);
    if (this.state[slot] === AT_HOME) {
      this.schedule(slot, null, null);
      this.unplanned.push(ref);
    }
  }

  /** @internal The planner's write: `stops` beyond `AGENDA_STOPS` are dropped. */
  writeAgenda(slot: number, day: number, stops: readonly AgendaStop[]): void {
    const base = slot * AGENDA_STOPS;
    const length = Math.min(stops.length, AGENDA_STOPS);
    for (let k = 0; k < length; k++) {
      const stop = stops[k]!;
      this.agendaPurpose[base + k] = TRIP_PURPOSES.indexOf(stop.purpose);
      this.agendaBuilding[base + k] = stop.building ?? NONE;
      this.agendaStay[base + k] = stop.stay ?? 0;
      this.agendaLeave[base + k] = stop.leaveAt ?? NONE;
      this.agendaArrive[base + k] = stop.arriveBy ?? NONE;
    }
    this.agendaDay[slot] = day;
    this.agendaLength[slot] = length;
    this.agendaCursor[slot] = 0;
  }

  /** The stops of the citizen's current agenda, from its first. */
  agenda(ref: number): AgendaStop[] {
    const slot = this.resolve(ref);
    if (slot === undefined) return [];
    const base = slot * AGENDA_STOPS;
    return Array.from({ length: this.agendaLength[slot]! }, (_, k) => {
      const purpose = TRIP_PURPOSES[this.agendaPurpose[base + k]!]!;
      const [building, leaveAt, arriveBy] = [this.agendaBuilding[base + k]!, this.agendaLeave[base + k]!, this.agendaArrive[base + k]!];
      return {
        purpose,
        ...(building === NONE ? {} : { building }),
        ...(leaveAt === NONE ? {} : { leaveAt }),
        ...(arriveBy === NONE ? {} : { arriveBy }),
        ...(purpose === 'ReturnHome' ? {} : { stay: this.agendaStay[base + k]! }),
      };
    });
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
      worker: this.worker[slot] === 1,
      workStart: this.workStart[slot]!,
      shiftMinutes: this.shiftMinutes[slot]!,
      nextAt: this.nextAt[slot] === NONE ? null : this.nextAt[slot]!,
      nextPurpose: purpose(this.nextPurpose[slot]!),
      agendaDay: this.agendaDay[slot]!,
      tripDepartedAtSec: Number.isNaN(this.tripDepartedAtSec[slot]) ? null : this.tripDepartedAtSec[slot]!,
      tripPurpose: purpose(this.tripPurpose[slot]!),
    };
  }

  clear(): void {
    for (const name of [...LAYER_NAMES, ...STOP_LAYER_NAMES]) this[name] = new (this[name].constructor as new (length: number) => never)(0);
    this.capacity = 0;
    this.highWater = 0;
    this.count = 0;
    this.moveIns = 0;
    this.plannerWoken = 0;
    this.onFootCount = 0;
    this.walkerList.length = 0;
    this.walkerIndex = new Int32Array(0);
    this.walkLimit = new Float32Array(0);
    this.parked.fill(0);
    this.freeSlots.length = 0;
    this.unplanned = [];
    this.jobSeekers = [];
    this.queue.clear();
    this.stateCounts.fill(0);
    this.residents.clear();
    this.workers.clear();
  }

  private grow(): void {
    const capacity = Math.min(Math.max(this.capacity * 2, INITIAL_CAPACITY), SLOT_COUNT);
    const fills: Partial<Record<LayerName | StopLayerName, number>> = {
      workplace: NONE,
      tourMode: NONE,
      nextAt: NONE,
      nextPurpose: NONE,
      tripDepartedAtSec: NaN,
      tripPurpose: NONE,
      agendaBuilding: NONE,
      agendaLeave: NONE,
      agendaArrive: NONE,
    };
    for (const name of LAYER_NAMES) this[name] = grown(this[name] as Layer, capacity, fills[name] ?? 0) as never;
    for (const name of STOP_LAYER_NAMES) this[name] = grown(this[name] as Layer, capacity * AGENDA_STOPS, fills[name] ?? 0) as never;
    this.walkerIndex = grown(this.walkerIndex, capacity, NONE);
    this.walkLimit = grown(this.walkLimit, capacity, NONE);
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
  'worker',
  'state',
  'lastPlaceX',
  'lastPlaceY',
  'destX',
  'destY',
  'tourMode',
  'walking',
  'onFoot',
  'walkFromX',
  'walkFromY',
  'walkProgress',
  'carStatus',
  'carPlace',
  'carX',
  'carY',
  'workStart',
  'shiftMinutes',
  'nextAt',
  'nextPurpose',
  'agendaDay',
  'agendaLength',
  'agendaCursor',
  'tripDepartedAtSec',
  'tripPurpose',
] as const satisfies ReadonlyArray<keyof Citizens>;
type LayerName = (typeof LAYER_NAMES)[number];

/** The agenda layers, `AGENDA_STOPS` entries a slot. */
export const STOP_LAYER_NAMES = ['agendaPurpose', 'agendaBuilding', 'agendaStay', 'agendaLeave', 'agendaArrive'] as const satisfies ReadonlyArray<
  keyof Citizens
>;
type StopLayerName = (typeof STOP_LAYER_NAMES)[number];

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
      const workStart = rangeU32(rng, WORK_START_WINDOW[0], WORK_START_WINDOW[1]);
      const shiftMinutes = rangeU32(rng, SHIFT_MINUTES[0], SHIFT_MINUTES[1] + 1);
      const labourShare = w.citizenConfig.labourShare;
      const worker = labourShare >= 1 || randomBool(rng, labourShare);
      const ref = citizens.add({ ...newCitizen(b, { workStart, shiftMinutes }), worker });
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

/** Whole game minutes a walk from `from` to `to` takes along its path, rounded up, with a wait at every crossing with a light. */
function walkMinutes(w: World, from: TilePos, to: TilePos): number {
  const { meters, litCrossings } = walkMeasure(w, from, to);
  return Math.ceil((meters * 60) / (w.citizenConfig.walkKmh * 1000) + (litCrossings * LIT_CROSSING_WAIT_SECS) / 60);
}

function setOut(w: World, slot: number, to: TilePos, purpose: TripPurpose, nowSecs: number): void {
  const c = w.citizens;
  c.setState(slot, TRAVEL_STATE[purpose]);
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
  c.walking[slot] = 1;
  c.setOnFoot(slot, from);
  c.schedule(slot, minute + walkMinutes(w, from, to), purpose);
}

/** By car from its spot to `spot`, which it takes now; the one it leaves is free. The walk to `to` follows the arrival. */
function departByCar(w: World, slot: number, to: TilePos, spot: number, purpose: TripPurpose, nowSecs: number): void {
  const c = w.citizens;
  const from = placeTile(w, c.carPlace[slot]!, to);
  const parkAt = placeTile(w, spot, from);
  w.parking.release(c.carPlace[slot]!);
  w.parking.take(spot);
  c.setCar(slot, CAR_DRIVING, spot, parkAt.x, parkAt.y);
  w.events.tripRequested.push({ citizen: c.ref(slot), from, carParkedAt: from, to: parkAt, purpose, mode: 'Car', pocket: true });
  setOut(w, slot, to, purpose, nowSecs);
  c.walking[slot] = 0;
  c.setOnFoot(slot, null);
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

/** Whole minutes a trip from `from` to `to` is expected to take: by the district times for a driver, on foot otherwise. */
function expectedTripMinutes(w: World, slot: number, from: TilePos, to: TilePos): number {
  const meters = tripMeters(w, from, to);
  if (w.citizens.carStatus[slot] === CAR_NONE || meters <= w.citizenConfig.walkMaxMeters) return walkMinutes(w, from, to);
  const seconds = Math.max(w.districtTimes.between(from, to) ?? 0, meters / (CROW_FLIES_KMH / 3.6));
  return Math.ceil(seconds / 60);
}

type Venue = 'Shop' | 'Cafe' | 'Park';

/** The open places of each kind, rebuilt when the buildings change or a game minute passes. */
const venueCache = new WeakMap<World, { readonly key: string; readonly index: Readonly<Record<Venue, NearestBuildings>> }>();

function venues(w: World): Readonly<Record<Venue, NearestBuildings>> {
  const key = `${w.buildings.version}|${gameMinute(w)}`;
  const cached = venueCache.get(w);
  if (cached?.key === key) return cached.index;
  const lists: Record<Venue, Building[]> = { Shop: [], Cafe: [], Park: [] };
  for (const b of w.buildings.all()) {
    if (!isOperational(b)) continue;
    if (b.kind === 'Commercial') lists.Shop.push(b);
    else if (b.kind === 'Cafe') lists.Cafe.push(b);
    else if (b.kind === 'Park') lists.Park.push(b);
  }
  const [width, height] = [w.grid.width, w.grid.height];
  const index = { Shop: new NearestBuildings(lists.Shop, width, height), Cafe: new NearestBuildings(lists.Cafe, width, height), Park: new NearestBuildings(lists.Park, width, height) };
  venueCache.set(w, { key, index });
  return index;
}

/** One of the open places of `venue` nearest `near`: of the nearest five shops, or three cafés or parks. */
function pickVenue(w: World, venue: Venue, near: TilePos): Building | undefined {
  const nearest = venues(w)[venue].nearest(near, venue === 'Shop' ? NEAREST_SHOPS : NEAREST_PLACES, () => true);
  if (nearest.length === 0) return undefined;
  return nearest[rangeU32(w.simRng, 0, nearest.length)];
}

const VISIT_MINUTES: Readonly<Record<Venue, readonly [number, number]>> = { Shop: SHOP_VISIT_MINUTES, Cafe: CAFE_VISIT_MINUTES, Park: PARK_VISIT_MINUTES };

/** Adds a stop at a `venue` near `near` to `stops`; the place it went to, or `undefined` when there is none open. */
function addVisit(w: World, stops: AgendaStop[], venue: Venue, near: TilePos, extra: Partial<AgendaStop> = {}): Building | undefined {
  const shopping = w.shoppingStats;
  if (venue === 'Shop') shopping.demandEvents += 1;
  const place = pickVenue(w, venue, near);
  if (place === undefined) {
    if (venue === 'Shop') shopping.unmetEvents += 1;
    return undefined;
  }
  const [min, max] = VISIT_MINUTES[venue];
  stops.push({ purpose: venue, building: place.id, stay: rangeU32(w.simRng, min, max + 1), ...extra });
  return place;
}

/** A tour of a day off, leaving home in `window`: one or two stops, then home. */
function addFreeTour(w: World, stops: AgendaStop[], home: Building, window: readonly [number, number]): void {
  const rng = w.simRng;
  const leaveAt = rangeU32(rng, window[0], window[1] + 1);
  const count = randomBool(rng, 0.35) ? 2 : 1;
  const before = stops.length;
  let near = home.anchor;
  for (let i = 0; i < count; i++) {
    const draw = rangeU32(rng, 0, 10);
    const venue: Venue = draw < 5 ? 'Shop' : draw < 8 ? 'Park' : 'Cafe';
    const place = addVisit(w, stops, venue, near, stops.length === before ? { leaveAt } : {});
    if (place !== undefined) near = place.anchor;
  }
  if (stops.length > before) stops.push({ purpose: 'ReturnHome' });
}

/**
 * Plans today's agenda of the citizen in `slot` by the chances of the city's config. A worker's day is work, a café on
 * the way at times, a shop, the park or a café after it in any order, and now and then an evening out; a day off is a
 * tour in the morning, one in the afternoon, both or none. Stops go to the open places nearest the stop before.
 */
export function planAgenda(w: World, slot: number): void {
  const c = w.citizens;
  const chances = w.citizenConfig.agenda;
  const rng = w.simRng;
  const stops: AgendaStop[] = [];
  const home = w.buildings.get(c.home[slot]!);
  const work = c.workplace[slot] === NONE ? undefined : w.buildings.get(c.workplace[slot]!);
  if (home !== undefined && work !== undefined) {
    if (randomBool(rng, chances.cafeBeforeWork)) {
      const cafe = pickVenue(w, 'Cafe', home.anchor);
      if (cafe !== undefined) stops.push({ purpose: 'Cafe', building: cafe.id, stay: rangeU32(rng, CAFE_BEFORE_WORK_MINUTES[0], CAFE_BEFORE_WORK_MINUTES[1] + 1) });
    }
    stops.push({ purpose: 'Work', building: work.id, arriveBy: c.workStart[slot]!, stay: c.shiftMinutes[slot]! });
    const after: Venue[] = [];
    if (randomBool(rng, chances.shopAfterWork)) after.push('Shop');
    if (randomBool(rng, chances.parkAfterWork)) after.push('Park');
    if (randomBool(rng, chances.cafeAfterWork)) after.push('Cafe');
    shuffle(rng, after);
    let near = work.anchor;
    for (const venue of after) near = addVisit(w, stops, venue, near)?.anchor ?? near;
    stops.push({ purpose: 'ReturnHome' });
    if (randomBool(rng, chances.eveningOuting)) {
      const leaveAt = rangeU32(rng, EVENING_OUTING_LEAVE[0], EVENING_OUTING_LEAVE[1] + 1);
      if (addVisit(w, stops, randomBool(rng, 0.5) ? 'Park' : 'Cafe', home.anchor, { leaveAt }) !== undefined) stops.push({ purpose: 'ReturnHome' });
    }
  } else if (home !== undefined) {
    if (randomBool(rng, chances.freeMorningTour)) addFreeTour(w, stops, home, FREE_MORNING_LEAVE);
    if (randomBool(rng, chances.freeAfternoonTour)) addFreeTour(w, stops, home, FREE_AFTERNOON_LEAVE);
  }
  c.writeAgenda(slot, w.city.day, stops);
}

/** The building of the stop at `cursor`, open; the current workplace for work. */
function stopBuilding(w: World, slot: number, cursor: number): Building | undefined {
  const c = w.citizens;
  const base = slot * AGENDA_STOPS;
  const purpose = TRIP_PURPOSES[c.agendaPurpose[base + cursor]!];
  const id = purpose === 'Work' ? c.workplace[slot]! : c.agendaBuilding[base + cursor]!;
  const b = id === NONE ? undefined : w.buildings.get(id);
  return b !== undefined && isOperational(b) ? b : undefined;
}

/**
 * The minute of the day the tour whose first stop is `cursor` leaves home: its own time, or back from the arrival a stop
 * of it is timed by, by the trips and the stays before that stop; -1 to leave at once.
 */
function tourLeaveMinute(w: World, slot: number, cursor: number): number {
  const c = w.citizens;
  const base = slot * AGENDA_STOPS;
  if (c.agendaLeave[base + cursor]! >= 0) return c.agendaLeave[base + cursor]!;
  let timed = -1;
  for (let k = cursor; k < c.agendaLength[slot]! && c.agendaPurpose[base + k] !== RETURN_HOME; k++) {
    if (c.agendaArrive[base + k]! >= 0) {
      timed = k;
      break;
    }
  }
  if (timed < 0) return NONE;
  const home = w.buildings.get(c.home[slot]!);
  let minute = c.agendaArrive[base + timed]!;
  for (let k = timed; k >= cursor; k--) {
    const to = stopBuilding(w, slot, k);
    const from = k === cursor ? home : stopBuilding(w, slot, k - 1);
    if (to !== undefined && from !== undefined) minute -= expectedTripMinutes(w, slot, entrance(w, from, to.anchor), entrance(w, to, from.anchor));
    if (k > cursor) minute -= c.agendaStay[base + k - 1]!;
  }
  return Math.max(minute, 0);
}

/** Moves the cursor past the way home that closes the tour at the cursor. */
function skipTour(w: World, slot: number): void {
  const c = w.citizens;
  const base = slot * AGENDA_STOPS;
  let k = c.agendaCursor[slot]!;
  while (k < c.agendaLength[slot]! && c.agendaPurpose[base + k] !== RETURN_HOME) k++;
  c.agendaCursor[slot] = Math.min(k + 1, AGENDA_STOPS);
}

/**
 * The next move of a citizen at home: today's agenda is planned when it is not yet, then the next tour of it leaves at
 * its minute — at once if it is late by less than `LATE_TOUR_MINUTES`, dropped if later. With no tour left the citizen
 * plans tomorrow in the small hours, at a minute of their own. A re-plan never lands on `now`.
 */
function planNext(w: World, slot: number, now: number, replan: boolean): void {
  const c = w.citizens;
  const minute = now % MINUTES_PER_DAY;
  const dayStart = now - minute;
  if (c.agendaDay[slot] !== w.city.day) planAgenda(w, slot);
  const base = slot * AGENDA_STOPS;
  const earliest = replan ? now + 1 : now;
  for (let guard = 0; guard <= AGENDA_STOPS; guard++) {
    const cursor: number = c.agendaCursor[slot]!;
    if (cursor >= c.agendaLength[slot]!) break;
    if (c.agendaPurpose[base + cursor] === RETURN_HOME) {
      c.agendaCursor[slot] = cursor + 1;
      continue;
    }
    const leave = tourLeaveMinute(w, slot, cursor);
    if (leave >= 0 && leave + LATE_TOUR_MINUTES < minute) {
      skipTour(w, slot);
      continue;
    }
    c.schedule(slot, Math.max(leave < 0 ? now : dayStart + leave, earliest), TRIP_PURPOSES[c.agendaPurpose[base + cursor]!]!);
    return;
  }
  const planMinute = DAY_PLAN_WINDOW[0] + (slot % (DAY_PLAN_WINDOW[1] - DAY_PLAN_WINDOW[0]));
  c.schedule(slot, Math.max(dayStart + MINUTES_PER_DAY + planMinute, earliest), null);
}

/** The trip ends at game minute `minute`: at a stop until its stay is over, or at home with the rest of the day to plan. */
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
  if (c.walking[slot] === 1) w.events.walksFinished.push(c.ref(slot));
  c.walking[slot] = 0;
  c.setOnFoot(slot, null);
  c.tripDepartedAtSec[slot] = NaN;
  c.tripPurpose[slot] = NONE;
  const base = slot * AGENDA_STOPS;
  const cursor = c.agendaCursor[slot]!;
  if (purpose === 'ReturnHome') {
    c.setState(slot, AT_HOME);
    c.tourMode[slot] = NONE;
    if (cursor < c.agendaLength[slot]! && c.agendaPurpose[base + cursor] === RETURN_HOME) c.agendaCursor[slot] = cursor + 1;
    else skipTour(w, slot);
    c.schedule(slot, null, null);
    c.unplanned.push(c.ref(slot));
    return;
  }
  c.setState(slot, STAY_STATE[purpose]);
  const planned = cursor < c.agendaLength[slot]! && TRIP_PURPOSES[c.agendaPurpose[base + cursor]!] === purpose;
  let stay = planned ? c.agendaStay[base + cursor]! : 0;
  if (stay === 0) stay = purpose === 'Work' ? c.shiftMinutes[slot]! : rangeU32(w.simRng, SHOP_VISIT_MINUTES[0], SHOP_VISIT_MINUTES[1] + 1);
  const next = planned && cursor + 1 < c.agendaLength[slot]! ? TRIP_PURPOSES[c.agendaPurpose[base + cursor + 1]!]! : 'ReturnHome';
  c.schedule(slot, minute + stay, next);
}

/** Home from `lastPlace` the way the tour went; a car with nowhere to stand in the whole city stays put, and its citizen walks. */
function goHome(w: World, slot: number, home: Building, lastPlace: TilePos, minute: number, nowSecs: number): void {
  const c = w.citizens;
  const doorstep = entrance(w, home, lastPlace);
  const spot = c.tourMode[slot] === CAR && c.carStatus[slot] === CAR_PARKED ? findParking(w, doorstep, home.id, Infinity) : NO_PLACE;
  if (spot === NO_PLACE) departOnFoot(w, slot, lastPlace, doorstep, 'ReturnHome', minute, nowSecs);
  else departByCar(w, slot, doorstep, spot, 'ReturnHome', nowSecs);
}

/** A citizen at home sets out on the tour at the cursor, past any stop whose place is gone; with none left, plans again. */
function startTour(w: World, slot: number, home: Building, now: number, minute: number, nowSecs: number): void {
  const c = w.citizens;
  const base = slot * AGENDA_STOPS;
  for (let guard = 0; guard <= AGENDA_STOPS; guard++) {
    const cursor: number = c.agendaCursor[slot]!;
    if (cursor >= c.agendaLength[slot]! || c.agendaPurpose[base + cursor] === RETURN_HOME) break;
    const destination = stopBuilding(w, slot, cursor);
    if (destination === undefined) {
      c.agendaCursor[slot] = cursor + 1;
      continue;
    }
    // Tours start at home, from the side of it on the road towards where they go.
    const purpose = TRIP_PURPOSES[c.agendaPurpose[base + cursor]!]!;
    const from = entrance(w, home, destination.anchor);
    const to = entrance(w, destination, home.anchor);
    const spot = tourSpot(w, slot, from, to, destination.id);
    c.tourMode[slot] = spot === NO_PLACE ? WALK : CAR;
    if (spot === NO_PLACE) departOnFoot(w, slot, from, to, purpose, minute, nowSecs);
    else departByCar(w, slot, to, spot, purpose, nowSecs);
    return;
  }
  // Nothing left of the tour to go to.
  skipTour(w, slot);
  planNext(w, slot, now, true);
}

/** The stay is over: on to the next stop of the tour, past any whose place is gone, or home. A car tour keeps its car. */
function leaveStop(w: World, slot: number, home: Building, lastPlace: TilePos, minute: number, nowSecs: number): void {
  const c = w.citizens;
  const base = slot * AGENDA_STOPS;
  c.agendaCursor[slot] = c.agendaCursor[slot]! + 1;
  for (let guard = 0; guard <= AGENDA_STOPS; guard++) {
    const cursor: number = c.agendaCursor[slot]!;
    if (cursor >= c.agendaLength[slot]! || c.agendaPurpose[base + cursor] === RETURN_HOME) break;
    const destination = stopBuilding(w, slot, cursor);
    if (destination === undefined) {
      c.agendaCursor[slot] = cursor + 1;
      continue;
    }
    const purpose = TRIP_PURPOSES[c.agendaPurpose[base + cursor]!]!;
    const to = entrance(w, destination, lastPlace);
    const spot = c.tourMode[slot] === CAR && c.carStatus[slot] === CAR_PARKED ? findParking(w, to, destination.id, Infinity) : NO_PLACE;
    if (spot === NO_PLACE) departOnFoot(w, slot, lastPlace, to, purpose, minute, nowSecs);
    else departByCar(w, slot, to, spot, purpose, nowSecs);
    return;
  }
  goHome(w, slot, home, lastPlace, minute, nowSecs);
}

/** A queue of citizens without a plan longer than this is worked through a few thousand a tick. */
export const PLAN_BACKLOG_THRESHOLD = 1000;
export const PLAN_BACKLOG_PER_TICK = 2000;

/**
 * Stage 3½e: a city opening lived in has every citizen without a plan, a million plans in one tick of the planner. A queue
 * longer than `PLAN_BACKLOG_THRESHOLD` is planned `PLAN_BACKLOG_PER_TICK` a tick, oldest first; a short one waits for the
 * planner's minute, as it always did.
 */
export function planCitizenBacklog(w: World): void {
  const c = w.citizens;
  if (c.unplanned.length <= PLAN_BACKLOG_THRESHOLD) return;
  const now = gameMinute(w);
  const batch = c.unplanned.slice(0, PLAN_BACKLOG_PER_TICK);
  c.unplanned = c.unplanned.slice(PLAN_BACKLOG_PER_TICK);
  for (const ref of batch) {
    const slot = c.resolve(ref);
    if (slot !== undefined && c.state[slot] === AT_HOME && c.nextAt[slot] === NONE) planNext(w, slot, now, false);
  }
}

/**
 * `citizen_trip_planner` (SimStep::Citizens), once a game minute: citizens with no plan make one, then those whose
 * minute has come, minute by minute, act on it. A walk under way arrives; a stay that is over goes on to the next stop
 * or home; a citizen at home sets out on the next tour of the day, or plans the day when there is none.
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

  const unplanned = c.unplanned;
  c.unplanned = [];
  for (const ref of unplanned) {
    const slot = c.resolve(ref);
    if (slot !== undefined && c.state[slot] === AT_HOME && c.nextAt[slot] === NONE) planNext(w, slot, now, false);
  }

  let woken = 0;
  for (let minute = c.queue.peek(); minute !== undefined && minute <= now; minute = c.queue.peek()) {
    for (const ref of c.queue.pop()) {
      const slot = c.resolve(ref);
      // A citizen re-planned or on the road since is no longer waiting for this minute.
      if (slot === undefined || c.nextAt[slot] !== minute) continue;
      woken += 1;
      const purpose = c.nextPurpose[slot] === NONE ? null : TRIP_PURPOSES[c.nextPurpose[slot]!]!;
      const state = c.state[slot]!;
      if (isTravelling(state)) {
        arrive(w, slot, purpose ?? 'ReturnHome', minute, nowSecs);
        continue;
      }
      const home = w.buildings.get(c.home[slot]!);
      if (home === undefined) continue;
      if (isStaying(state)) {
        leaveStop(w, slot, home, { x: c.lastPlaceX[slot]!, y: c.lastPlaceY[slot]! }, minute, nowSecs);
        continue;
      }
      if (state !== AT_HOME) continue;
      if (purpose === null) planNext(w, slot, now, false);
      else startTour(w, slot, home, now, minute, nowSecs);
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
    if (slot === undefined || c.state[slot] !== TRAVEL_STATE[arrival.purpose]) continue;
    if (c.carStatus[slot] === CAR_DRIVING) {
      c.setCar(slot, CAR_PARKED, c.carPlace[slot]!, c.carX[slot]!, c.carY[slot]!);
      const walk = walkMinutes(w, { x: c.carX[slot]!, y: c.carY[slot]! }, { x: c.destX[slot]!, y: c.destY[slot]! });
      if (walk > 0) {
        c.setOnFoot(slot, { x: c.carX[slot]!, y: c.carY[slot]! });
        c.schedule(slot, now + walk, arrival.purpose);
        continue;
      }
    }
    arrive(w, slot, arrival.purpose, now, nowSecs);
  }
}

/**
 * `recover_stuck_trips` (SimStep::Citizens): a trip whose car never spawned yields no arrival, and a citizen in transit
 * makes no plans, so past the timeout such a citizen goes back home and drops the rest of the tour, the car standing at
 * the spot it was going to. A trip with its car on the road or waiting in the backlog, or a walk, is not orphaned
 * however long it takes; Rust sent those drivers home too.
 */
export function recoverStuckTrips(w: World): void {
  const now = fixedElapsedSecs(w);
  const c = w.citizens;
  const v = w.vehicles;
  let riding: Set<number> | undefined;
  for (let slot = 0; slot < c.highWater; slot++) {
    if (c.alive[slot] !== 1 || c.nextAt[slot] !== NONE || !isTravelling(c.state[slot]!)) continue;
    const departedAt = c.tripDepartedAtSec[slot]!;
    if (Number.isNaN(departedAt) || now - departedAt <= CITIZEN_TRIP_TIMEOUT_SECS) continue;
    if (riding === undefined) {
      riding = new Set<number>();
      for (const vehicle of v.order) if (v.parked[vehicle] !== 1 && v.passengerCitizen[vehicle] !== -1) riding.add(v.passengerCitizen[vehicle]!);
      for (const trip of w.tripBacklog) riding.add(trip.citizen);
      const meso = w.mesoTraffic;
      for (let car = 0; car < meso.highWater; car++) if (meso.link[car] !== -1) riding.add(meso.citizen[car]!);
      for (const trip of meso.pending) riding.add(trip.citizen);
    }
    const ref = c.ref(slot);
    if (riding.has(ref)) continue;
    c.setState(slot, AT_HOME);
    if (c.carStatus[slot] === CAR_DRIVING) c.setCar(slot, CAR_PARKED, c.carPlace[slot]!, c.carX[slot]!, c.carY[slot]!);
    c.tourMode[slot] = NONE;
    c.walking[slot] = 0;
    c.setOnFoot(slot, null);
    skipTour(w, slot);
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
