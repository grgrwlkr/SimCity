// Stage 3½: the city and its region. The lanes that leave the map are its gateways. Over them commuters drive in to the
// jobs the city's own people leave open and out after the shift, visitors come to the shops, cafés and parks by day,
// through traffic crosses from one edge to another, and trucks bring goods from the works to the shops, supplies into the
// works and goods out of town. An agent of the region is no citizen: it lives in these arrays from the minute it sets out
// until it is past the edge again, and its trips drive in meso traffic under the id `-(slot + 1)`.
import { isOperational, type Building } from './buildings/building';
import { MINUTES_PER_DAY, gameMinute } from './city';
import { MinuteQueue } from './citizens';
import type { TilePos } from './commands';
import type { TripRequested } from './events';
import { fleetIdOfTrip } from './fleet';
import { inTileView, tileFToWorld, type TileView } from './map/coords';
import { NO_LINK, type MesoGraph } from './meso/graph';
import { NearestBuildings } from './nearest';
import { NO_PLACE, findParking, placeTile } from './parking';
import { randomBool, rangeU32 } from './rng';
import type { TripPurpose } from './traffic/vehicles';
import { footprintEntrance } from './transport/anchors';
import type { World } from './world';

/** How much of each flow the region sends; all nothing unless a scenario says otherwise. */
export interface RegionalConfig {
  /** Of the jobs the city's people leave open, the share filled by commuters who drive in. */
  commuterCarShare: number;
  /** Visitors who drive in to a shop, café or park by day. */
  visitorsPerDay: number;
  /** Cars that cross the map from one gateway to another. */
  throughPerDay: number;
  /** Trucks a day to every open shop, into every open works and out of it. */
  deliveriesPerShop: number;
  suppliesPerWorks: number;
  shipmentsPerWorks: number;
}

export const defaultRegionalConfig = (): RegionalConfig => ({
  commuterCarShare: 0,
  visitorsPerDay: 0,
  throughPerDay: 0,
  deliveriesPerShop: 0,
  suppliesPerWorks: 0,
  shipmentsPerWorks: 0,
});

/** A trip of the region under way this long, game minutes, with no car carrying it, is given up. */
export const REGIONAL_TRIP_TIMEOUT_MINUTES = 360;
/** A lane ending this near the edge of the map leaves it, tiles. */
const EDGE_TILES = 2;
/** An inbound and an outbound lane this far apart along the edge are one road, tiles. */
const GATEWAY_PAIR_TILES = 8;
const CROW_FLIES_KMH = 40;
const WORK_START = [6 * 60, 9 * 60] as const;
const SHIFT_MINUTES = [8 * 60, 9 * 60] as const;
/** Visitors set out between these hours. */
const VISIT_HOURS = [9, 19] as const;
const VISIT_MINUTES = [30, 120] as const;
/** Trucks arrive at shops and works in this window, and leave works with goods in the next. */
const FREIGHT_ARRIVALS = [6 * 60, 16 * 60] as const;
const SHIPMENT_DEPARTURES = [8 * 60, 18 * 60] as const;
const UNLOAD_MINUTES = [20, 40] as const;
/** A shop gets its goods from one of this many open works nearest it. */
const NEAREST_WORKS = 3;
/** Through traffic by the hour it enters, as the person trips of NHTS 2022 start over the day. */
const THROUGH_HOURS = [0.4, 0.3, 0.3, 0.3, 0.5, 1.5, 5.5, 6.5, 5.8, 5.2, 5.6, 6.0, 6.6, 7.2, 7.8, 8.8, 8.0, 7.6, 6.4, 3.6, 2.9, 2.4, 1.6, 0.9] as const;
const THROUGH_TOTAL = THROUGH_HOURS.reduce((sum, share) => sum + share, 0);

export const REGIONAL_KINDS = ['Commuter', 'Visitor', 'Through', 'Delivery', 'Supply', 'Shipment'] as const;
const COMMUTER = 0;
const VISITOR = 1;
const THROUGH = 2;
const DELIVERY = 3;
const SUPPLY = 4;
const SHIPMENT = 5;
const isTruck = (kind: number) => kind >= DELIVERY;

/** `RegionalTrips.state`: waiting to set out, driving in to its building, at it, driving away. */
const WAITING = 0;
const INBOUND = 1;
const STAYING = 2;
const OUTBOUND = 3;
const NONE = -1;
const PURPOSES = ['Work', 'Shop', 'ReturnHome', 'Cafe', 'Park', 'Freight', 'Through'] as const satisfies readonly TripPurpose[];

export interface Gateway {
  /** A tile of the lane that enters the map. */
  readonly inbound: TilePos;
  /** A tile of the lane that leaves it. */
  readonly outbound: TilePos;
}

type Layer = Uint8Array | Uint16Array | Int16Array | Int32Array;

/** Every per-slot layer of `RegionalTrips`, in the order the fingerprint hashes them. */
export const REGIONAL_LAYER_NAMES = [
  'alive',
  'kind',
  'state',
  'purpose',
  'generation',
  'entry',
  'exit',
  'building',
  'home',
  'nextAt',
  'leaveAt',
  'place',
  'standX',
  'standY',
  'departedAt',
] as const;

/** The agents of the region, as typed arrays by slot. */
export class RegionalTrips {
  highWater = 0;
  count = 0;
  /** Agents driving, in or out. */
  drivingCount = 0;
  /** The day the trucks and commuters were planned for; 0 before the first. */
  plannedDay = 0;
  /** The fractions of a through trip and of a visitor carried from one minute to the next. */
  readonly accumulators = new Float64Array(2);
  readonly freeSlots: number[] = [];
  readonly queue = new MinuteQueue();

  alive = new Uint8Array(0);
  /** `REGIONAL_KINDS` index. */
  kind = new Uint8Array(0);
  state = new Uint8Array(0);
  /** `TRIP_PURPOSES` index of the trip in: work, or the venue a visitor goes to. */
  purpose = new Uint8Array(0);
  generation = new Uint16Array(0);
  /** The gateway it enters by and the one it leaves by; -1 for a truck of a works. */
  entry = new Int16Array(0);
  exit = new Int16Array(0);
  /** The building it goes to, and the works a delivery comes from; -1 for none. */
  building = new Int32Array(0);
  home = new Int32Array(0);
  /** Game minute of its next move, -1 while it drives. */
  nextAt = new Int32Array(0);
  /** Game minute a commuter's shift ends. */
  leaveAt = new Int32Array(0);
  /** The parking spot of a car at its building, 0 without one. */
  place = new Int32Array(0);
  /** Where it stands at its building. */
  standX = new Int32Array(0);
  standY = new Int32Array(0);
  /** Game minute the trip under way set out at, -1 while not driving. */
  departedAt = new Int32Array(0);

  /** A car driving in to the spot it holds. */
  holdsSpotWhileDriving(slot: number): boolean {
    return this.alive[slot] === 1 && this.state[slot] === INBOUND && this.place[slot] !== 0;
  }

  add(kind: number): number {
    let slot = this.freeSlots.pop();
    if (slot === undefined) {
      if (this.highWater === this.alive.length) this.grow();
      slot = this.highWater;
      this.highWater += 1;
    }
    this.alive[slot] = 1;
    this.kind[slot] = kind;
    this.state[slot] = WAITING;
    this.purpose[slot] = 0;
    this.generation[slot] = (this.generation[slot]! + 1) & 0xffff;
    this.entry[slot] = NONE;
    this.exit[slot] = NONE;
    this.building[slot] = NONE;
    this.home[slot] = NONE;
    this.nextAt[slot] = NONE;
    this.leaveAt[slot] = NONE;
    this.place[slot] = 0;
    this.departedAt[slot] = NONE;
    this.count += 1;
    return slot;
  }

  setState(slot: number, state: number): void {
    const driving = (s: number) => s === INBOUND || s === OUTBOUND;
    if (driving(this.state[slot]!)) this.drivingCount -= 1;
    this.state[slot] = state;
    if (driving(state)) this.drivingCount += 1;
  }

  schedule(slot: number, minute: number): void {
    this.nextAt[slot] = minute;
    this.queue.push(minute, slot);
  }

  free(slot: number): void {
    this.setState(slot, WAITING);
    this.alive[slot] = 0;
    this.nextAt[slot] = NONE;
    this.freeSlots.push(slot);
    this.count -= 1;
  }

  clear(): void {
    for (const name of REGIONAL_LAYER_NAMES) this[name] = new (this[name].constructor as new (length: number) => never)(0);
    this.highWater = 0;
    this.count = 0;
    this.drivingCount = 0;
    this.plannedDay = 0;
    this.accumulators.fill(0);
    this.freeSlots.length = 0;
    this.queue.clear();
  }

  private grow(): void {
    const capacity = Math.max(this.alive.length * 2, 256);
    for (const name of REGIONAL_LAYER_NAMES) {
      const layer = this[name] as Layer;
      const next = new (layer.constructor as new (length: number) => Layer)(capacity);
      next.set(layer as never);
      this[name] = next as never;
    }
  }
}

const gatewayCache = new WeakMap<World, { readonly builtFor: number | null; readonly gates: readonly Gateway[] }>();

/** A tile of `link` at the cross-section whose middle is (`x`, `y`). */
function laneTile(g: MesoGraph, link: number, x: number, y: number): TilePos {
  for (const [tx, ty] of [
    [Math.round(x), Math.round(y)],
    [Math.floor(x), Math.floor(y)],
    [Math.ceil(x), Math.ceil(y)],
  ] as const) {
    if (g.linkAt({ x: tx, y: ty }) === link) return { x: tx, y: ty };
  }
  return { x: Math.round(x), y: Math.round(y) };
}

// By `ROAD_DIRS` index.
const WEST = 1;
const EAST = 2;
const NORTH = 3;
const SOUTH = 4;

/**
 * The roads that leave the map, by the tile index of their inbound lane: an inbound lane starting at an edge paired with
 * the nearest outbound lane ending at the same edge.
 */
export function findGateways(w: World): readonly Gateway[] {
  const g = w.meso;
  const cached = gatewayCache.get(w);
  if (cached !== undefined && cached.builtFor === g.builtFor) return cached.gates;
  const [width, height] = [g.width, g.height];
  type End = { readonly side: number; readonly across: number; readonly tile: TilePos };
  const ins: End[] = [];
  const outs: End[] = [];
  for (let link = 0; link < g.linkCount; link++) {
    const dir = g.dir[link]!;
    const [sx, sy, ex, ey] = [g.startX[link]!, g.startY[link]!, g.endX[link]!, g.endY[link]!];
    const start = () => laneTile(g, link, sx, sy);
    const end = () => laneTile(g, link, ex, ey);
    if (dir === EAST && sx < EDGE_TILES) ins.push({ side: WEST, across: sy, tile: start() });
    if (dir === WEST && sx >= width - EDGE_TILES) ins.push({ side: EAST, across: sy, tile: start() });
    if (dir === NORTH && sy < EDGE_TILES) ins.push({ side: SOUTH, across: sx, tile: start() });
    if (dir === SOUTH && sy >= height - EDGE_TILES) ins.push({ side: NORTH, across: sx, tile: start() });
    if (dir === WEST && ex < EDGE_TILES) outs.push({ side: WEST, across: ey, tile: end() });
    if (dir === EAST && ex >= width - EDGE_TILES) outs.push({ side: EAST, across: ey, tile: end() });
    if (dir === SOUTH && ey < EDGE_TILES) outs.push({ side: SOUTH, across: ex, tile: end() });
    if (dir === NORTH && ey >= height - EDGE_TILES) outs.push({ side: NORTH, across: ex, tile: end() });
  }
  const used = new Set<End>();
  const gates: Gateway[] = [];
  for (const inbound of ins) {
    let best: End | undefined;
    for (const out of outs) {
      if (used.has(out) || out.side !== inbound.side) continue;
      const gap = Math.abs(out.across - inbound.across);
      if (gap <= GATEWAY_PAIR_TILES && (best === undefined || gap < Math.abs(best.across - inbound.across))) best = out;
    }
    if (best === undefined) continue;
    used.add(best);
    gates.push({ inbound: inbound.tile, outbound: best.tile });
  }
  gates.sort((a, b) => a.inbound.y * width + a.inbound.x - (b.inbound.y * width + b.inbound.x));
  gatewayCache.set(w, { builtFor: g.builtFor, gates });
  return gates;
}

const openCache = new WeakMap<World, { readonly key: string; readonly lists: ReadonlyMap<string, Building[]> }>();

/** The open buildings of each kind, rebuilt when the buildings change or a minute passes. */
function openBuildings(w: World, kind: string): readonly Building[] {
  const key = `${w.buildings.version}|${gameMinute(w)}`;
  let cached = openCache.get(w);
  if (cached?.key !== key) {
    const lists = new Map<string, Building[]>();
    for (const b of w.buildings.all()) {
      if (!isOperational(b)) continue;
      const list = lists.get(b.kind) ?? [];
      list.push(b);
      lists.set(b.kind, list);
    }
    cached = { key, lists };
    openCache.set(w, cached);
  }
  return cached.lists.get(kind) ?? [];
}

const tileOf = (w: World, slot: number): TilePos => ({ x: w.regional.standX[slot]!, y: w.regional.standY[slot]! });

function expectedMinutes(w: World, from: TilePos, to: TilePos): number {
  const meters = (Math.abs(from.x - to.x) + Math.abs(from.y - to.y)) * w.trafficConfig.tileMeters;
  return Math.ceil(Math.max(w.districtTimes.between(from, to) ?? 0, meters / (CROW_FLIES_KMH / 3.6)) / 60);
}

/** A whole number of `rate`, the fraction drawn. */
function drawCount(w: World, rate: number): number {
  const whole = Math.floor(rate);
  const fraction = rate - whole;
  return fraction > 0 && randomBool(w.simRng, fraction) ? whole + 1 : whole;
}

const between = (w: World, range: readonly [number, number]) => rangeU32(w.simRng, range[0], range[1] + 1);
const anyGate = (w: World, gates: readonly Gateway[]) => rangeU32(w.simRng, 0, gates.length);

/** A new agent leaving at `minute`, no earlier than now. */
function waiting(w: World, kind: number, minute: number, now: number): number {
  const slot = w.regional.add(kind);
  w.regional.schedule(slot, Math.max(minute, now));
  return slot;
}

/** At the turn of the day: the commuters for the jobs left open and the trucks of every shop and works. */
function planDay(w: World, gates: readonly Gateway[], dayStart: number, now: number): void {
  const cfg = w.regionalConfig;
  const r = w.regional;
  if (cfg.commuterCarShare > 0) {
    // A job is held by a commuter still in town from the day before: nobody else is sent for it.
    const inTown = new Map<number, number>();
    for (let slot = 0; slot < r.highWater; slot++) {
      if (r.alive[slot] === 1 && r.kind[slot] === COMMUTER) inTown.set(r.building[slot]!, (inTown.get(r.building[slot]!) ?? 0) + 1);
    }
    for (const b of w.buildings.all()) {
      if ((b.kind !== 'Commercial' && b.kind !== 'Industrial') || !isOperational(b)) continue;
      const open = Math.max(b.capacityJobs - w.citizens.workersOf(b.id) - (inTown.get(b.id) ?? 0), 0);
      for (let i = drawCount(w, open * cfg.commuterCarShare); i > 0; i--) {
        const start = between(w, WORK_START);
        const gate = anyGate(w, gates);
        const trip = expectedMinutes(w, gates[gate]!.inbound, b.anchor);
        const slot = waiting(w, COMMUTER, dayStart + start - trip, now);
        r.entry[slot] = gate;
        r.exit[slot] = gate;
        r.building[slot] = b.id;
        r.purpose[slot] = PURPOSES.indexOf('Work');
        r.leaveAt[slot] = dayStart + start + between(w, SHIFT_MINUTES);
      }
    }
  }
  const works = openBuildings(w, 'Industrial');
  if (cfg.deliveriesPerShop > 0) {
    const worksIndex = new NearestBuildings(works, w.grid.width, w.grid.height);
    for (const shop of openBuildings(w, 'Commercial')) {
      for (let i = drawCount(w, cfg.deliveriesPerShop); i > 0; i--) {
        const nearest = worksIndex.nearest(shop.anchor, NEAREST_WORKS, () => true);
        const origin = nearest.length > 0 ? nearest[rangeU32(w.simRng, 0, nearest.length)] : undefined;
        const gate = anyGate(w, gates);
        const from = origin?.anchor ?? gates[gate]!.inbound;
        const slot = waiting(w, DELIVERY, dayStart + between(w, FREIGHT_ARRIVALS) - expectedMinutes(w, from, shop.anchor), now);
        r.building[slot] = shop.id;
        r.home[slot] = origin?.id ?? NONE;
        r.entry[slot] = gate;
        r.exit[slot] = gate;
      }
    }
  }
  for (const factory of works) {
    for (let i = drawCount(w, cfg.suppliesPerWorks); i > 0; i--) {
      const gate = anyGate(w, gates);
      const slot = waiting(w, SUPPLY, dayStart + between(w, FREIGHT_ARRIVALS) - expectedMinutes(w, gates[gate]!.inbound, factory.anchor), now);
      r.building[slot] = factory.id;
      r.entry[slot] = gate;
      r.exit[slot] = anyGate(w, gates);
    }
    for (let i = drawCount(w, cfg.shipmentsPerWorks); i > 0; i--) {
      const slot = waiting(w, SHIPMENT, dayStart + between(w, SHIPMENT_DEPARTURES), now);
      r.home[slot] = factory.id;
      r.exit[slot] = anyGate(w, gates);
    }
  }
}

/** The agent in `slot` drives from `from` to `to`. */
function drive(w: World, slot: number, from: TilePos, to: TilePos, purpose: TripPurpose, state: number, now: number): void {
  const r = w.regional;
  const trip: TripRequested = { citizen: -(slot + 1), from, carParkedAt: from, to, purpose, mode: 'Car', pocket: true };
  w.events.tripRequested.push(isTruck(r.kind[slot]!) ? { ...trip, vehicle: 'Truck' } : trip);
  r.setState(slot, state);
  r.nextAt[slot] = NONE;
  r.departedAt[slot] = now;
}

/** A car of the region takes a spot at `b`, or `false` when the city has none. */
function park(w: World, slot: number, b: Building, from: TilePos): boolean {
  const r = w.regional;
  const door = footprintEntrance(w.grid, b.anchor, b.width, b.length, from);
  const spot = findParking(w, door, b.id, Infinity);
  if (spot === NO_PLACE) return false;
  w.parking.take(spot);
  r.place[slot] = spot;
  const stand = placeTile(w, spot, from);
  r.standX[slot] = stand.x;
  r.standY[slot] = stand.y;
  return true;
}

function setOut(w: World, slot: number, gates: readonly Gateway[], now: number): void {
  const r = w.regional;
  const kind = r.kind[slot]!;
  const building = r.building[slot] === NONE ? undefined : w.buildings.get(r.building[slot]!);
  const home = r.home[slot] === NONE ? undefined : w.buildings.get(r.home[slot]!);
  const gate = (index: number) => gates[index] ?? gates[0]!;
  if (kind === THROUGH) {
    drive(w, slot, gate(r.entry[slot]!).inbound, gate(r.exit[slot]!).outbound, 'Through', OUTBOUND, now);
    return;
  }
  if (kind === SHIPMENT) {
    if (home === undefined || !isOperational(home)) return r.free(slot);
    const out = gate(r.exit[slot]!).outbound;
    drive(w, slot, footprintEntrance(w.grid, home.anchor, home.width, home.length, out), out, 'Freight', OUTBOUND, now);
    return;
  }
  if (building === undefined || !isOperational(building)) return r.free(slot);
  const from = kind === DELIVERY && home !== undefined ? footprintEntrance(w.grid, home.anchor, home.width, home.length, building.anchor) : gate(r.entry[slot]!).inbound;
  if (kind === COMMUTER || kind === VISITOR) {
    if (!park(w, slot, building, from)) return r.free(slot);
    drive(w, slot, from, tileOf(w, slot), PURPOSES[r.purpose[slot]!]!, INBOUND, now);
    return;
  }
  const door = footprintEntrance(w.grid, building.anchor, building.width, building.length, from);
  r.standX[slot] = door.x;
  r.standY[slot] = door.y;
  drive(w, slot, from, door, 'Freight', INBOUND, now);
}

function leave(w: World, slot: number, gates: readonly Gateway[], now: number): void {
  const r = w.regional;
  const stand = tileOf(w, slot);
  const out = (gates[r.exit[slot]!] ?? gates[0]!).outbound;
  if (r.place[slot] !== 0) {
    w.parking.release(r.place[slot]!);
    r.place[slot] = 0;
  }
  const kind = r.kind[slot]!;
  const home = r.home[slot] === NONE ? undefined : w.buildings.get(r.home[slot]!);
  if (kind === DELIVERY && home !== undefined) {
    drive(w, slot, stand, footprintEntrance(w.grid, home.anchor, home.width, home.length, stand), 'Freight', OUTBOUND, now);
    return;
  }
  drive(w, slot, stand, out, isTruck(kind) ? 'Freight' : 'ReturnHome', OUTBOUND, now);
}

/** A visitor from out of town to a shop, café or park, if the city has one open. */
function startVisitor(w: World, gates: readonly Gateway[], now: number): void {
  const draw = rangeU32(w.simRng, 0, 10);
  const wanted = draw < 6 ? 'Commercial' : draw < 8 ? 'Cafe' : 'Park';
  const kinds = [wanted, 'Commercial', 'Cafe', 'Park'].filter((kind) => openBuildings(w, kind).length > 0);
  if (kinds.length === 0) return;
  const kind = kinds[0]!;
  const venues = openBuildings(w, kind);
  const r = w.regional;
  const slot = r.add(VISITOR);
  const gate = anyGate(w, gates);
  r.entry[slot] = gate;
  r.exit[slot] = gate;
  r.building[slot] = venues[rangeU32(w.simRng, 0, venues.length)]!.id;
  r.purpose[slot] = PURPOSES.indexOf(kind === 'Commercial' ? 'Shop' : kind === 'Cafe' ? 'Cafe' : 'Park');
  setOut(w, slot, gates, now);
}

function startThrough(w: World, gates: readonly Gateway[], now: number): void {
  const r = w.regional;
  const slot = r.add(THROUGH);
  const entry = anyGate(w, gates);
  r.entry[slot] = entry;
  r.exit[slot] = (entry + 1 + rangeU32(w.simRng, 0, gates.length - 1)) % gates.length;
  setOut(w, slot, gates, now);
}

/** Trips no car carries past the timeout are given up: a spot a car of the region held is freed. */
function giveUpLostTrips(w: World, now: number): void {
  const r = w.regional;
  let riding: Set<number> | undefined;
  for (let slot = 0; slot < r.highWater; slot++) {
    if (r.alive[slot] !== 1 || r.departedAt[slot]! < 0 || (r.state[slot] !== INBOUND && r.state[slot] !== OUTBOUND)) continue;
    if (now - r.departedAt[slot]! <= REGIONAL_TRIP_TIMEOUT_MINUTES) continue;
    if (riding === undefined) {
      riding = new Set<number>();
      const m = w.mesoTraffic;
      for (let car = 0; car < m.highWater; car++) if (m.link[car] !== NO_LINK) riding.add(m.citizen[car]!);
      for (const trip of m.pending) riding.add(trip.citizen);
    }
    if (riding.has(-(slot + 1))) continue;
    if (r.place[slot] !== 0) w.parking.release(r.place[slot]!);
    r.place[slot] = 0;
    r.free(slot);
  }
}

/**
 * `SimStep::Citizens`, once a game minute after the citizens' planner: the day's commuters and trucks are planned at the
 * turn of the day, through traffic and visitors set out at their rate of the hour, and the agents whose minute has come
 * set out or leave.
 */
export function planRegionalTrips(w: World): void {
  const cfg = w.regionalConfig;
  const r = w.regional;
  const gates = findGateways(w);
  const now = gameMinute(w);
  const minute = now % MINUTES_PER_DAY;
  if (r.plannedDay !== w.city.day) {
    r.plannedDay = w.city.day;
    if (gates.length > 0) planDay(w, gates, now - minute, now);
  }
  if (gates.length > 1 && cfg.throughPerDay > 0) {
    r.accumulators[0]! += (cfg.throughPerDay * THROUGH_HOURS[Math.floor(minute / 60)]!) / THROUGH_TOTAL / 60;
    for (; r.accumulators[0]! >= 1; r.accumulators[0]! -= 1) startThrough(w, gates, now);
  }
  const hour = Math.floor(minute / 60);
  if (gates.length > 0 && cfg.visitorsPerDay > 0 && hour >= VISIT_HOURS[0] && hour < VISIT_HOURS[1]) {
    r.accumulators[1]! += cfg.visitorsPerDay / ((VISIT_HOURS[1] - VISIT_HOURS[0]) * 60);
    for (; r.accumulators[1]! >= 1; r.accumulators[1]! -= 1) startVisitor(w, gates, now);
  }
  for (let due = r.queue.peek(); due !== undefined && due <= now; due = r.queue.peek()) {
    for (const slot of r.queue.pop()) {
      if (r.alive[slot] !== 1 || r.nextAt[slot] !== due) continue;
      if (gates.length === 0) r.free(slot);
      else if (r.state[slot] === WAITING) setOut(w, slot, gates, now);
      else if (r.state[slot] === STAYING) leave(w, slot, gates, now);
    }
  }
  if (r.drivingCount > 0) giveUpLostTrips(w, now);
}

/** After traffic, beside `handleTripFinished`: a trip of the region that arrived stays at its building or is gone. */
export function handleRegionalArrivals(w: World): void {
  const r = w.regional;
  const now = gameMinute(w);
  for (const arrival of w.events.tripFinished) {
    if (arrival.citizen >= 0 || fleetIdOfTrip(arrival.citizen) >= 0) continue;
    const slot = -arrival.citizen - 1;
    if (r.alive[slot] !== 1) continue;
    if (r.state[slot] === OUTBOUND) {
      r.free(slot);
      continue;
    }
    if (r.state[slot] !== INBOUND) continue;
    r.setState(slot, STAYING);
    r.departedAt[slot] = NONE;
    const kind = r.kind[slot]!;
    const stay = kind === COMMUTER ? r.leaveAt[slot]! - now : kind === VISITOR ? between(w, VISIT_MINUTES) : between(w, UNLOAD_MINUTES);
    r.schedule(slot, now + Math.max(stay, 1));
  }
}

/** `id` is a regional agent slot; world coordinates. */
export type RegionalStandingVisitor = (slot: number, generation: number, x: number, y: number, heading: number, truck: boolean) => void;

/** The cars of the region parked at their buildings and the trucks standing at the doors they unload at; with a `view`, those in it. */
export function forEachRegionalStanding(w: World, visit: RegionalStandingVisitor, view?: TileView): void {
  const r = w.regional;
  for (let slot = 0; slot < r.highWater; slot++) {
    if (r.alive[slot] !== 1 || r.state[slot] !== STAYING) continue;
    const truck = isTruck(r.kind[slot]!);
    if (!truck && r.place[slot] === 0) continue;
    if (!inTileView(view, r.standX[slot]!, r.standY[slot]!)) continue;
    const at = tileFToWorld(w.mapConfig, r.standX[slot]!, r.standY[slot]!);
    visit(slot, r.generation[slot]!, at.x, at.y, 0, truck);
  }
}
