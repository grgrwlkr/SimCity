// Harness for the traffic tests: the Rust tests build a bare App with a hand-picked system chain;
// here a world with its grid, intersections and lights set up the same way, and the systems are
// called in the chain's order.
import type { RoadDir, RoadKind, TilePos } from '../../src/commands';
import { detectIntersections } from '../../src/intersections/index';
import type { LightPhase } from '../../src/traffic/lights';
import { spawnVehicle, type VehicleSpec } from '../../src/traffic/vehicles';
import { createWorld, type World } from '../../src/world';
import { setRoad } from '../transport/helpers';

/** One 10 Hz fixed step, in the `dtNs` the systems take. */
export const DT = 100_000_000;

export const t = (x: number, y: number): TilePos => ({ x, y });

export function trafficWorld(width: number, height: number, roads: ReadonlyArray<readonly [TilePos, RoadDir, RoadKind?, number?]>): World {
  const w = createWorld({ mapWidth: width, mapHeight: height });
  w.appState = 'InGame';
  for (const [pos, dir, kind, lane] of roads) setRoad(w.grid, pos, { dir, kind: kind ?? 'TwoLane', lane: lane ?? 0 });
  return w;
}

/** Clusters the grid's box tiles, as the Rust tests' hand-built `IntersectionIndex` does. */
export function detect(w: World): void {
  w.graphVersion += 1;
  detectIntersections(w);
}

/** A light on the cluster at `tile`, as the Rust tests spawn a `TrafficLight` entity. */
export function placeLight(w: World, tile: TilePos, phase: LightPhase, phaseTimer: number, allRed = 1): number {
  const id = w.intersections.intersectionIdAt(tile)!;
  w.intersections.trafficLights.add(id);
  w.trafficLights.push({
    intersectionId: id,
    intersectionKey: w.intersections.clusterKeyAt(tile)!,
    pos: tile,
    phase,
    phaseTimer,
    greenDuration: 10,
    yellowDuration: 3,
    allRedDuration: allRed,
  });
  return id;
}

/** `create_vehicle_with_route(route, cursor, progress, speed, max_speed, max_accel, speed_factor)`. */
export function vehicle(
  w: World,
  route: readonly TilePos[],
  cursor: number,
  progress: number,
  speed: number,
  maxSpeed: number,
  maxAccel: number,
  speedFactor: number,
  extra: Partial<VehicleSpec> = {},
): number {
  return spawnVehicle(w, { route, cursor, progress, speed, maxSpeed, maxAccel, speedFactor, ...extra });
}
