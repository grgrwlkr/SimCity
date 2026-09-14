// Stage 3½c: meso traffic, the cars of citizens in the city. A car is a place in its link's queue: when it entered and
// when it may leave — its time along the link at the speed limit, never before the car ahead. The head leaves when its
// time is up, the link has flow left (1 800 cars an hour a lane), the light lets its direction go and the next link has
// room; a head held by a full link past `FORCE_PUSH_SECS` is pushed on, so a jam backs up the street but never locks.
// A tick costs the heads that come due, not the cars. Routes run over the links by the times cars measured. Micro
// traffic (stage 2) keeps the scenario cars; Rust drove every car tile by tile.
import { DEFAULT_GAME_HOUR_NS } from '../city';
import { ROAD_DIRS } from '../commands';
import type { TripRequested } from '../events';
import { isGreen, isYellow, type TrafficLight } from '../traffic/lights';
import { TRIP_PURPOSES } from '../traffic/vehicles';
import { adjacentRoadTowards } from '../transport/anchors';
import type { World } from '../world';
import { BOX_KMH, LinkHeap } from './districts';
import { NO_LINK } from './graph';

/** Cars a lane lets go a second: 1 800 an hour. */
export const SATURATION_PER_LANE_SEC = 0.5;
/** A car's length and the room it takes queued, gap included, metres. */
export const CAR_LENGTH_METERS = 5;
export const CAR_SPACE_METERS = 7.5;
/** An articulated truck, 16.5 m as the EU allows at most, and its room queued. */
export const TRUCK_LENGTH_METERS = 16.5;
export const TRUCK_SPACE_METERS = 19;
/** A truck takes the flow of two cars. */
export const TRUCK_PCE = 2;
/** `MesoTraffic.vehicle` values. */
export const VEHICLE_CAR = 0;
export const VEHICLE_TRUCK = 1;
const SPACE_METERS = [CAR_SPACE_METERS, TRUCK_SPACE_METERS] as const;
const LENGTH_METERS = [CAR_LENGTH_METERS, TRUCK_LENGTH_METERS] as const;
const PCE = [1, TRUCK_PCE] as const;
/** A head held by a full link this long, game seconds, is pushed on. */
export const FORCE_PUSH_SECS = 120;
/** A car due this long and still queued counts as stuck, game seconds. */
export const STUCK_SECS = 60;
/** A held head looks again after this long, game seconds. */
const RETRY_SECS = 1;
/** A head waiting for flow looks again no sooner than this, game seconds: a wait of a rounding error would never pass. */
const MIN_FLOW_WAIT_SECS = 0.01;
/** Flow this close to a whole car counts as one. */
const TOKEN_EPSILON = 1e-9;
/** New routes a tick searches at most (stage 3½e): a minute of a rush sends thousands of trips out at once. */
export const ROUTE_SEARCHES_PER_TICK = 400;
/** Link times move a share towards what the cars measured, once a game minute. */
const COST_UPDATE_SECS = 60;
const COST_EMA = 0.3;
/** No car is faster: the route search's estimate stays below every real time. */
const HEURISTIC_KMH = 80;
const INITIAL_CARS = 256;
const EMPTY_ROUTE = new Int32Array(0);

export interface MesoStats {
  arrived: number;
  forcedPushes: number;
  /** Trips with no link beside their ends or no route between them. */
  dropped: number;
  /** Routes searched rather than taken from the cache. */
  routeSearches: number;
}

/** Metres of queue a link holds: its lanes over its length. */
export function linkRoomMeters(w: World, link: number): number {
  const g = w.meso;
  return g.length[link]! * g.lanes[link]! * w.trafficConfig.tileMeters;
}

/** Cars a link holds: its room at `CAR_SPACE_METERS` a car, at least one. */
export function linkStorage(w: World, link: number): number {
  return Math.max(Math.floor(linkRoomMeters(w, link) / CAR_SPACE_METERS), 1);
}

/** Room on `link` for a vehicle taking `space` metres: an empty link takes any one. */
const fits = (w: World, link: number, space: number) => {
  const used = w.mesoTraffic.usedMeters[link]!;
  return used === 0 || used + space <= linkRoomMeters(w, link);
};

/** The room queued, the length and the flow of a vehicle kind. */
export const vehicleSpaceMeters = (vehicle: number): number => SPACE_METERS[vehicle]!;
export const vehicleLengthMeters = (vehicle: number): number => LENGTH_METERS[vehicle]!;

const secondsPerTile = (w: World, link: number) => w.trafficConfig.tileMeters / (Math.max(w.meso.speedKmh[link]!, 1) / 3.6);
const boxSeconds = (w: World) => w.trafficConfig.tileMeters / (BOX_KMH / 3.6);

export class MesoTraffic {
  /** Game seconds since traffic started. */
  nowSec = 0;
  /** Trips waiting for room on their first link, oldest first. */
  pending: TripRequested[] = [];
  readonly stats: MesoStats = { arrived: 0, forcedPushes: 0, dropped: 0, routeSearches: 0 };
  /** New routes a tick may search; the trips past it wait a tick to leave. */
  routeSearchesPerTick = ROUTE_SEARCHES_PER_TICK;
  /** Routes searched in the tick under way. */
  searchesThisTick = 0;

  highWater = 0;
  count = 0;
  /** Trucks among the vehicles on the links. */
  trucks = 0;
  readonly freeSlots: number[] = [];
  /** The citizen of the trip; `-(agent + 1)` for a trip of the region. */
  citizen = new Int32Array(0);
  /** `VEHICLE_CAR` or `VEHICLE_TRUCK`. */
  vehicle = new Uint8Array(0);
  purpose = new Uint8Array(0);
  /** The link the car is queued on; -1 for a free slot. */
  link = new Int32Array(0);
  enterSec = new Float64Array(0);
  readySec = new Float64Array(0);
  goalLink = new Int32Array(0);
  /** The tile along the goal link the trip ends at. */
  goalOffset = new Uint16Array(0);
  /** The car behind in the queue, -1 at the tail. */
  next = new Int32Array(0);
  /** When a full link first held the car at the head; NaN while not held. */
  heldSince = new Float64Array(0);
  /** A red light held the car at the head at its last look. */
  atRed = new Uint8Array(0);
  /** The tile along its link the car entered at: its start for the first link, 0 after. */
  fromOffset = new Uint16Array(0);
  /** The link the car left for the one it is on; -1 on its first link. The renderer draws it across the box between. */
  prevLink = new Int32Array(0);
  /** Bumps every time the slot takes a new car, so a drawn car is not mistaken for the one before it. */
  generation = new Uint32Array(0);
  /** The route as successor indices of the meso graph, and how far along it the car is. */
  routes: Int32Array[] = [];
  routeCursor = new Uint16Array(0);

  /** The graph version the link arrays are sized for. */
  linksFor: number | null = null;
  head = new Int32Array(0);
  tail = new Int32Array(0);
  onLink = new Int32Array(0);
  /** Metres of queue taken on each link. */
  usedMeters = new Float64Array(0);
  tokens = new Float64Array(0);
  tokensAt = new Float64Array(0);
  /** Cars that left each link, ever. */
  exits = new Uint32Array(0);
  /** Seconds a link takes end to end, moved towards what cars measured. */
  linkSeconds = new Float64Array(0);
  measuredSum = new Float64Array(0);
  measuredCount = new Uint32Array(0);
  nextCostUpdate = COST_UPDATE_SECS;
  /** Links by the second their head may try to leave. */
  readonly due = new LinkHeap();
  /** Routes between links for the current link times; derived, cleared with them. */
  readonly routeCache = new Map<number, Int32Array | null>();

  carCount(): number {
    return this.count;
  }

  carsOn(link: number): number {
    return this.onLink[link] ?? 0;
  }

  /** Cars queued behind a head a red light holds. */
  waitingAtLights(): number {
    let waiting = 0;
    for (let link = 0; link < this.head.length; link++) {
      const car = this.head[link]!;
      if (car >= 0 && this.atRed[car] === 1) waiting += this.onLink[link]!;
    }
    return waiting;
  }

  /** Cars queued more than `STUCK_SECS` past their time. */
  stuckOverMinute(): number {
    let stuck = 0;
    for (let car = 0; car < this.highWater; car++) if (this.link[car] !== NO_LINK && this.nowSec - this.readySec[car]! > STUCK_SECS) stuck += 1;
    return stuck;
  }
}

function growCars(m: MesoTraffic): void {
  const capacity = Math.max(m.citizen.length * 2, INITIAL_CARS);
  const grown = <T extends Int32Array | Uint8Array | Uint16Array | Uint32Array | Float64Array>(layer: T, fill: number): T => {
    const next = new (layer.constructor as new (length: number) => T)(capacity);
    (next as Int32Array).set(layer as never);
    if (fill !== 0) next.fill(fill, layer.length);
    return next;
  };
  m.citizen = grown(m.citizen, 0);
  m.purpose = grown(m.purpose, 0);
  m.vehicle = grown(m.vehicle, 0);
  m.link = grown(m.link, NO_LINK);
  m.enterSec = grown(m.enterSec, 0);
  m.readySec = grown(m.readySec, 0);
  m.goalLink = grown(m.goalLink, NO_LINK);
  m.goalOffset = grown(m.goalOffset, 0);
  m.next = grown(m.next, -1);
  m.heldSince = grown(m.heldSince, NaN);
  m.atRed = grown(m.atRed, 0);
  m.routeCursor = grown(m.routeCursor, 0);
  m.fromOffset = grown(m.fromOffset, 0);
  m.prevLink = grown(m.prevLink, -1);
  m.generation = grown(m.generation, 0);
}

/** The car's trip is over: its citizen hears of it and the slot is free. */
function finish(w: World, car: number): void {
  const m = w.mesoTraffic;
  w.events.tripFinished.push({ citizen: m.citizen[car]!, purpose: TRIP_PURPOSES[m.purpose[car]!]! });
  m.link[car] = NO_LINK;
  m.routes[car] = EMPTY_ROUTE;
  m.count -= 1;
  if (m.vehicle[car] === VEHICLE_TRUCK) m.trucks -= 1;
  m.freeSlots.push(car);
}

/** Sizes the link arrays for a new graph. A road edit takes the cars on the old roads to where they were going. */
function resetLinks(w: World): void {
  const m = w.mesoTraffic;
  const g = w.meso;
  const n = g.linkCount;
  for (let car = 0; car < m.highWater; car++) if (m.link[car] !== NO_LINK) finish(w, car);
  m.linksFor = g.builtFor;
  m.head = new Int32Array(n).fill(-1);
  m.tail = new Int32Array(n).fill(-1);
  m.onLink = new Int32Array(n);
  m.usedMeters = new Float64Array(n);
  m.tokens = Float64Array.from(g.lanes);
  m.tokensAt = new Float64Array(n).fill(m.nowSec);
  m.exits = new Uint32Array(n);
  m.linkSeconds = Float64Array.from(g.length, (length, link) => length * secondsPerTile(w, link));
  m.measuredSum = new Float64Array(n);
  m.measuredCount = new Uint32Array(n);
  m.due.clear();
  m.routeCache.clear();
}

function enqueue(m: MesoTraffic, car: number, link: number, enterSec: number, readySec: number): void {
  const tail = m.tail[link]!;
  m.link[car] = link;
  m.enterSec[car] = enterSec;
  m.readySec[car] = tail >= 0 ? Math.max(readySec, m.readySec[tail]!) : readySec;
  m.next[car] = -1;
  if (tail >= 0) {
    m.next[tail] = car;
  } else {
    m.head[link] = car;
    m.due.push(m.readySec[car]!, link);
  }
  m.tail[link] = car;
  m.onLink[link]! += 1;
  m.usedMeters[link]! += SPACE_METERS[m.vehicle[car]!]!;
}

function dequeue(m: MesoTraffic, link: number): number {
  const car = m.head[link]!;
  m.head[link] = m.next[car]!;
  if (m.head[link]! < 0) m.tail[link] = -1;
  m.next[car] = -1;
  m.onLink[link]! -= 1;
  m.usedMeters[link] = Math.max(m.usedMeters[link]! - SPACE_METERS[m.vehicle[car]!]!, 0);
  return car;
}

/** The new head of `link`, if any, comes due at its time or now. */
function scheduleHead(m: MesoTraffic, link: number, now: number): void {
  const car = m.head[link]!;
  if (car >= 0) m.due.push(Math.max(m.readySec[car]!, now), link);
}

// Scratch of the route search, reused between searches; never state.
let best = new Float64Array(0);
let parent = new Int32Array(0);
let via = new Int32Array(0);
let reached = new Uint32Array(0);
let settled = new Uint32Array(0);
let search = 0;
// A binary min-heap of links by cost, as `LinkHeap` orders it, on typed arrays that live between searches.
let heapKeys = new Float64Array(1024);
let heapLinks = new Int32Array(1024);
let heapSize = 0;

function heapPush(key: number, link: number): void {
  if (heapSize === heapKeys.length) {
    const [keys, links] = [new Float64Array(heapSize * 2), new Int32Array(heapSize * 2)];
    keys.set(heapKeys);
    links.set(heapLinks);
    [heapKeys, heapLinks] = [keys, links];
  }
  let i = heapSize;
  heapSize += 1;
  while (i > 0) {
    const up = (i - 1) >> 1;
    if (heapKeys[up]! <= key) break;
    heapKeys[i] = heapKeys[up]!;
    heapLinks[i] = heapLinks[up]!;
    i = up;
  }
  heapKeys[i] = key;
  heapLinks[i] = link;
}

/** Takes the link of the least cost. */
function heapPop(): number {
  const top = heapLinks[0]!;
  heapSize -= 1;
  const key = heapKeys[heapSize]!;
  const link = heapLinks[heapSize]!;
  if (heapSize > 0) {
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= heapSize) break;
      const child = left + 1 < heapSize && heapKeys[left + 1]! < heapKeys[left]! ? left + 1 : left;
      if (heapKeys[child]! >= key) break;
      heapKeys[i] = heapKeys[child]!;
      heapLinks[i] = heapLinks[child]!;
      i = child;
    }
    heapKeys[i] = key;
    heapLinks[i] = link;
  }
  return top;
}

/** A* over the links from the end of `from` to the start of `to` by the current link times: successor indices, or `null`. */
function findRoute(w: World, from: number, to: number): Int32Array | null {
  const m = w.mesoTraffic;
  const g = w.meso;
  const n = g.linkCount;
  const key = from * n + to;
  const cached = m.routeCache.get(key);
  if (cached !== undefined) return cached;
  m.stats.routeSearches += 1;
  m.searchesThisTick += 1;
  if (reached.length < n) {
    [best, parent, via, reached, settled] = [new Float64Array(n), new Int32Array(n), new Int32Array(n), new Uint32Array(n), new Uint32Array(n)];
    search = 0;
  }
  search += 1;
  const box = boxSeconds(w);
  const fast = w.trafficConfig.tileMeters / (HEURISTIC_KMH / 3.6);
  const [toX, toY] = [g.startX[to]!, g.startY[to]!];
  const { succStart, succLink, succBoxTiles, startX, startY } = g;
  const linkSeconds = m.linkSeconds;
  heapSize = 0;
  for (let link = from, base = 0, origin = -1; ; ) {
    for (let k = succStart[link]!; k < succStart[link + 1]!; k++) {
      const next = succLink[k]!;
      const cost = base + succBoxTiles[k]! * box;
      if (reached[next] === search && cost >= best[next]!) continue;
      reached[next] = search;
      best[next] = cost;
      parent[next] = origin;
      via[next] = k;
      heapPush(cost + (Math.abs(toX - startX[next]!) + Math.abs(toY - startY[next]!)) * fast, next);
    }
    let found = -1;
    while (heapSize > 0) {
      const candidate = heapPop();
      if (settled[candidate] === search) continue;
      settled[candidate] = search;
      found = candidate;
      break;
    }
    if (found < 0) break;
    if (found === to) {
      const steps: number[] = [];
      for (let at = to, guard = 0; guard <= n; guard++) {
        steps.push(via[at]!);
        if (parent[at]! < 0) break;
        at = parent[at]!;
      }
      const route = Int32Array.from(steps.reverse());
      m.routeCache.set(key, route);
      return route;
    }
    link = found;
    base = best[found]! + linkSeconds[found]!;
    origin = found;
  }
  m.routeCache.set(key, null);
  return null;
}

/** A trip joins its first link, waits for room on it, or is dropped without a link beside its ends or a route. */
function spawn(w: World, trip: TripRequested): 'spawned' | 'wait' | 'dropped' {
  const m = w.mesoTraffic;
  const g = w.meso;
  const start = adjacentRoadTowards(w.grid, trip.carParkedAt ?? trip.from, trip.to);
  // The goal lane runs the way the trip goes: towards a point past the goal, not back to the start as micro spawn has it.
  const origin = start ?? trip.from;
  const goal = adjacentRoadTowards(w.grid, trip.to, { x: 2 * trip.to.x - origin.x, y: 2 * trip.to.y - origin.y });
  const startLink = start === undefined ? NO_LINK : g.linkAt(start);
  const goalLink = goal === undefined ? NO_LINK : g.linkAt(goal);
  if (startLink === NO_LINK || goalLink === NO_LINK) {
    m.stats.dropped += 1;
    return 'dropped';
  }
  const startOffset = g.offsetAt(start!);
  const goalOffset = g.offsetAt(goal!);
  const straight = startLink === goalLink && goalOffset >= startOffset;
  if (!straight && m.searchesThisTick >= m.routeSearchesPerTick && !m.routeCache.has(startLink * g.linkCount + goalLink)) return 'wait';
  const route = straight ? EMPTY_ROUTE : findRoute(w, startLink, goalLink);
  if (route === null) {
    m.stats.dropped += 1;
    return 'dropped';
  }
  const vehicle = trip.vehicle === 'Truck' ? VEHICLE_TRUCK : VEHICLE_CAR;
  if (!fits(w, startLink, SPACE_METERS[vehicle])) return 'wait';

  let car = m.freeSlots.pop();
  if (car === undefined) {
    if (m.highWater === m.citizen.length) growCars(m);
    car = m.highWater;
    m.highWater += 1;
  }
  m.count += 1;
  if (vehicle === VEHICLE_TRUCK) m.trucks += 1;
  m.vehicle[car] = vehicle;
  m.citizen[car] = trip.citizen;
  m.purpose[car] = TRIP_PURPOSES.indexOf(trip.purpose);
  m.goalLink[car] = goalLink;
  m.goalOffset[car] = goalOffset;
  m.routes[car] = route;
  m.routeCursor[car] = 0;
  m.heldSince[car] = NaN;
  m.atRed[car] = 0;
  m.fromOffset[car] = startOffset;
  m.prevLink[car] = -1;
  m.generation[car]! += 1;
  const tiles = straight ? goalOffset - startOffset : g.length[startLink]! - startOffset;
  enqueue(m, car, startLink, m.nowSec, m.nowSec + tiles * secondsPerTile(w, startLink));
  return 'spawned';
}

/** The head of `link` is due: it arrives, or leaves for the next link of its route, or is held and looks again later. */
function leave(w: World, link: number, now: number, lights: ReadonlyMap<number, TrafficLight>): void {
  const m = w.mesoTraffic;
  const g = w.meso;
  const car = m.head[link]!;
  const route = m.routes[car]!;
  const cursor = m.routeCursor[car]!;
  if (cursor >= route.length) {
    dequeue(m, link);
    finish(w, car);
    m.stats.arrived += 1;
    scheduleHead(m, link, now);
    return;
  }

  const k = route[cursor]!;
  const next = g.succLink[k]!;
  const cluster = g.succCluster[k]!;
  const light = cluster >= 0 ? lights.get(cluster) : undefined;
  const dir = ROAD_DIRS[g.dir[link]!]!;
  if (light !== undefined && !isGreen(light, dir) && !isYellow(light, dir)) {
    m.atRed[car] = 1;
    m.due.push(now + RETRY_SECS, link);
    return;
  }
  m.atRed[car] = 0;

  const lanes = g.lanes[link]!;
  // Heads of one link come due in the order of their times, so the flow only ever refills forward.
  const tokens = Math.min(lanes, m.tokens[link]! + Math.max(now - m.tokensAt[link]!, 0) * lanes * SATURATION_PER_LANE_SEC);
  m.tokens[link] = tokens;
  m.tokensAt[link] = Math.max(now, m.tokensAt[link]!);
  if (tokens < 1 - TOKEN_EPSILON) {
    m.due.push(now + Math.max((1 - tokens) / (lanes * SATURATION_PER_LANE_SEC), MIN_FLOW_WAIT_SECS), link);
    return;
  }
  if (!fits(w, next, SPACE_METERS[m.vehicle[car]!]!)) {
    if (Number.isNaN(m.heldSince[car]!)) m.heldSince[car] = now;
    if (now - m.heldSince[car]! < FORCE_PUSH_SECS) {
      m.due.push(now + RETRY_SECS, link);
      return;
    }
    m.stats.forcedPushes += 1;
  }

  // A truck may leave on one token and takes two: the vehicles after it wait the longer.
  m.tokens[link] = tokens - PCE[m.vehicle[car]!]!;
  dequeue(m, link);
  m.exits[link]! += 1;
  m.measuredSum[link]! += now - m.enterSec[car]!;
  m.measuredCount[link]! += 1;
  m.heldSince[car] = NaN;
  m.routeCursor[car] = cursor + 1;
  m.fromOffset[car] = 0;
  m.prevLink[car] = link;
  const entered = now + g.succBoxTiles[k]! * boxSeconds(w);
  const tiles = cursor + 1 >= route.length ? m.goalOffset[car]! : g.length[next]!;
  enqueue(m, car, next, entered, entered + tiles * secondsPerTile(w, next));
  scheduleHead(m, link, now);
}

/** Once a game minute: every link time moves towards what cars took on it, and the routes are searched afresh. */
function updateLinkTimes(w: World): void {
  const m = w.mesoTraffic;
  const g = w.meso;
  for (let link = 0; link < g.linkCount; link++) {
    const free = g.length[link]! * secondsPerTile(w, link);
    const measured = m.measuredCount[link]! > 0 ? Math.max(m.measuredSum[link]! / m.measuredCount[link]!, free) : free;
    m.linkSeconds[link]! += (measured - m.linkSeconds[link]!) * COST_EMA;
  }
  m.measuredSum.fill(0);
  m.measuredCount.fill(0);
  m.routeCache.clear();
  m.nextCostUpdate = m.nowSec + COST_UPDATE_SECS;
}

/** One tick of meso traffic: game time on, waiting trips join, due heads leave or arrive. */
export function stepMesoTraffic(w: World, dtNs: number): void {
  const m = w.mesoTraffic;
  const g = w.meso;
  if (g.builtFor === null) return;
  if (m.linksFor !== g.builtFor) resetLinks(w);
  m.nowSec += (dtNs / 1e9) * (DEFAULT_GAME_HOUR_NS / w.gameHourNs);
  m.searchesThisTick = 0;
  const now = m.nowSec;

  if (m.pending.length > 0) {
    const waiting = m.pending;
    m.pending = [];
    for (const trip of waiting) if (spawn(w, trip) === 'wait') m.pending.push(trip);
  }

  let lights: Map<number, TrafficLight> | undefined;
  while (m.due.size > 0 && m.due.peekKey() <= now) {
    const [at, link] = m.due.pop();
    const car = m.head[link]!;
    // A head not yet due keeps its own entry at its time.
    if (car < 0 || m.readySec[car]! > now) continue;
    lights ??= new Map(w.trafficLights.map((light) => [light.intersectionId, light]));
    // At the second it came due, not at the end of the tick: a tick of several game seconds lets as many through as its
    // seconds in tenths. The lights stand as they are at the end of the tick.
    leave(w, link, Math.max(at, m.readySec[car]!), lights);
  }

  if (now >= m.nextCostUpdate) updateLinkTimes(w);
}

/**
 * `TrafficStep::Flow`, after `spawnTripVehicles`: this tick's car trips of citizens join meso traffic and it moves on.
 * Its arrivals are read by `handleTripFinished` later in the tick.
 */
export function runMesoTraffic(w: World, dtNs: number): void {
  for (const trip of w.events.tripRequested) if (trip.mode === 'Car' && trip.pocket === true) w.mesoTraffic.pending.push(trip);
  stepMesoTraffic(w, dtNs);
}
