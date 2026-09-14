// Port of crates/simcity_sim/src/game/public_transport.rs (phase A): buses loop the stops of their route, one bus a route,
// dwelling at each stop and skipping a stop they cannot reach. Rust drove a bus as a micro vehicle with a wedge detector of
// its own; here each leg is a trip of meso traffic, which never wedges, so a leg ends in an arrival or a dropped trip.
// Passengers are phase C, in neither.
import { gameSecond } from '../city';
import type { TilePos } from '../commands';
import { fleetIdOfTrip, fleetTripId } from '../fleet';
import type { MapGrid } from '../map/grid';
import type { World } from '../world';

/** Game seconds a bus stands at a stop. Rust stood three seconds of a clock of a second an hour. */
export const BUS_DWELL_SECS = 20;
/** Game seconds a bus with no reachable stop waits before it tries its stops again. */
export const BUS_REPLAN_BACKOFF_SECS = 5;
const DEMO_STOPS = 8;
const SQRT_HALF = 0.7071067811865476;
/** Cosine and sine of the eight directions of the demo tour, a quarter turn apart twice over: tabulated, not computed. */
const DIRECTIONS = [
  [1, 0],
  [SQRT_HALF, SQRT_HALF],
  [0, 1],
  [-SQRT_HALF, SQRT_HALF],
  [-1, 0],
  [-SQRT_HALF, -SQRT_HALF],
  [0, -1],
  [SQRT_HALF, -SQRT_HALF],
] as const;

/** An ordered stop sequence, looped: `stops[i] → stops[i + 1] → … → stops[0]`. */
export interface BusRoute {
  readonly id: number;
  readonly stops: readonly TilePos[];
}

/** `BusRouteManager`. */
export class BusRoutes {
  routes: BusRoute[] = [];
  nextRouteId = 0;
  /** Bumps on every change of the route set, so stop markers are redrawn. */
  version = 0;

  createRoute(stops: readonly TilePos[]): number {
    const id = this.nextRouteId;
    this.nextRouteId += 1;
    this.routes.push({ id, stops: stops.map((s) => ({ ...s })) });
    this.version += 1;
    return id;
  }

  route(id: number): BusRoute | undefined {
    return this.routes.find((r) => r.id === id);
  }

  /** Clears the routes and rewinds the ids, for a new map; the buses go with them (`tickBuses`). */
  reset(): void {
    this.routes = [];
    this.nextRouteId = 0;
    this.version += 1;
  }
}

export const BUS_STATES = ['Driving', 'Dwelling', 'Waiting'] as const;
export type BusState = (typeof BUS_STATES)[number];

export interface Bus {
  readonly id: number;
  readonly route: number;
  /** The stop it drives to or stands at. */
  stop: number;
  /** Driving a leg, dwelling at `stop`, or waiting to leave for the stop after `stop` without having reached it. */
  state: BusState;
  /** The game second a dwell or a wait is over. */
  until: number;
  /** Stops skipped since the last one reached. */
  skips: number;
  /** The road tile of the last stop it reached, where its next leg starts. */
  at: TilePos;
}

const isThroughRoad = (grid: MapGrid, x: number, y: number) => {
  const cell = grid.get({ x, y });
  if (cell === undefined || cell.water || cell.road.kind === 'None' || cell.road.dir === 'None') return false;
  let degree = 0;
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const n = grid.get({ x: x + dx, y: y + dy });
    if (n !== undefined && !n.water && n.road.kind !== 'None') degree += 1;
  }
  return degree >= 2;
};

/** `nearest_through_road`: the nearest lane tile with road on two sides, by square rings out from `around`. */
function nearestThroughRoad(grid: MapGrid, around: TilePos, maxR: number): TilePos | undefined {
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (isThroughRoad(grid, around.x + dx, around.y + dy)) return { x: around.x + dx, y: around.y + dy };
      }
    }
  }
  return undefined;
}

/**
 * `seed_demo_bus_route`: one circular tour, if the city has none: eight points evenly round the middle of the road network
 * at 0.35 of its extent, each snapped to the nearest through road, in the order of their angle. Rust took a box tile too; a
 * stop here is a lane, which a leg can start and end on.
 */
export function seedDemoBusRoute(grid: MapGrid, routes: BusRoutes): void {
  if (routes.routes.length > 0) return;
  let [sx, sy, count] = [0, 0, 0];
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0, i = y * grid.width; x < grid.width; x++, i++) {
      if (grid.water[i] !== 0 || grid.roadKind[i] === 0) continue;
      sx += x;
      sy += y;
      count += 1;
      [minX, minY, maxX, maxY] = [Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x), Math.max(maxY, y)];
    }
  }
  if (count < DEMO_STOPS) return;
  const [cx, cy] = [Math.trunc(sx / count), Math.trunc(sy / count)];
  const [rx, ry] = [Math.max((maxX - minX) * 0.35, 4), Math.max((maxY - minY) * 0.35, 4)];
  const maxR = Math.max(grid.width, grid.height);
  const stops: TilePos[] = [];
  for (const [cos, sin] of DIRECTIONS) {
    const stop = nearestThroughRoad(grid, { x: Math.round(cx + rx * cos), y: Math.round(cy + ry * sin) }, maxR);
    if (stop !== undefined && !stops.some((s) => s.x === stop.x && s.y === stop.y)) stops.push(stop);
  }
  if (stops.length >= 3) routes.createRoute(stops);
}

function drive(w: World, bus: Bus, to: TilePos): void {
  w.mesoTraffic.pending.push({ citizen: fleetTripId(bus.id), from: bus.at, carParkedAt: bus.at, to, purpose: 'Transit', mode: 'Car', pocket: true, vehicle: 'Bus' });
  bus.state = 'Driving';
}

/**
 * `spawn_buses` and `tick_buses` (SimStep::PublicTransport): a route without a bus gets one at its first stop, bound for the
 * second; a bus whose dwell or wait is over leaves for its next stop; a bus whose route is gone goes. The legs join meso
 * traffic later in this tick.
 */
export function tickBuses(w: World): void {
  const routes = w.busRoutes;
  const fleet = w.fleet;
  if (routes.routes.length === 0 && fleet.buses.length === 0) return;
  if (fleet.buses.some((bus) => routes.route(bus.route) === undefined)) fleet.buses = fleet.buses.filter((bus) => routes.route(bus.route) !== undefined);
  for (const route of routes.routes) {
    if (route.stops.length < 2 || fleet.buses.some((bus) => bus.route === route.id)) continue;
    const bus: Bus = { id: fleet.takeId(), route: route.id, stop: 1, state: 'Driving', until: 0, skips: 0, at: { ...route.stops[0]! } };
    fleet.buses.push(bus);
    drive(w, bus, route.stops[1]!);
  }
  const now = gameSecond(w);
  for (const bus of fleet.buses) {
    if (bus.state === 'Driving' || now < bus.until) continue;
    const stops = routes.route(bus.route)!.stops;
    bus.stop = (bus.stop + 1) % stops.length;
    drive(w, bus, stops[bus.stop]!);
  }
}

/** After traffic: a bus that reached its stop dwells there; one that found no way waits to try the stop after it. */
export function handleBusArrivals(w: World): void {
  const events = w.events;
  const buses = w.fleet.buses;
  if (buses.length === 0 || (events.tripFinished.length === 0 && events.tripDropped.length === 0)) return;
  const now = gameSecond(w);
  const busOf = (trip: number) => {
    const id = fleetIdOfTrip(trip);
    return id < 0 ? undefined : buses.find((bus) => bus.id === id && bus.state === 'Driving');
  };
  for (const arrival of events.tripFinished) {
    const bus = busOf(arrival.citizen);
    if (bus === undefined) continue;
    bus.state = 'Dwelling';
    bus.until = now + BUS_DWELL_SECS;
    bus.skips = 0;
    bus.at = { ...w.busRoutes.route(bus.route)!.stops[bus.stop]! };
  }
  for (const trip of events.tripDropped) {
    const bus = busOf(trip);
    if (bus === undefined) continue;
    const stops = w.busRoutes.route(bus.route)!.stops.length;
    bus.skips += 1;
    bus.state = 'Waiting';
    bus.until = bus.skips >= stops ? now + BUS_REPLAN_BACKOFF_SECS : now;
    if (bus.skips >= stops) bus.skips = 0;
  }
}
