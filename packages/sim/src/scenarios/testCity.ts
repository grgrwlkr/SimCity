// The test city of rust-final crates/simcity_data/src/game/test_city.rs, frozen as the 128×128 grid its
// examples/dump_routes.rs dumped (`road-routes.json`, which also carries the route pins of the tests) instead of
// regenerated. `LoadTestCity` writes it into the running world; `loadTestCity` builds a fresh world with it the
// way the Rust dumps saw it: intersections detected in Update, then one fixed tick builds every graph.
import { runFixedTick } from '../app';
import { DEFAULT_PROFILE } from '../buildings/building';
import { spawnBuilding } from '../buildings/spawn';
import { detectIntersections } from '../intersections/index';
import { MANUAL_BUILDING_FOOTPRINT } from '../map/apply';
import { tileKey } from '../map/grid';
import { createWorld, type World } from '../world';
import fixture from './road-routes.json';

const LAYER_ORDER = [
  'height',
  'water',
  'terrain',
  'roadKind',
  'roadDir',
  'roadLane',
  'roadFlow',
  'laneType',
  'zone',
  'density',
  'building',
] as const;

export function hexToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface TestCityOptions {
  /**
   * `false` drops the zones: nothing grows and no citizen moves in, so a traffic harness measures only the trips it
   * requests itself (its commuter indices would otherwise collide with the ids of real citizens).
   */
  readonly zones?: boolean;
}

/** `generate_test_city` starts the city over with this treasury. */
export const TEST_CITY_MONEY = 50_000;

/**
 * Writes the test city's grid into `w` and marks its lit crossings by key. A world whose map is not the dump's
 * size is left untouched and gets `false`.
 */
export function writeTestCity(w: World, options: TestCityOptions = {}): boolean {
  if (w.grid.width !== fixture.width || w.grid.height !== fixture.height) return false;
  const layers = w.grid.layers();
  LAYER_ORDER.forEach((name, i) => layers[i]!.set(hexToBytes(fixture.rawGrid[name])));
  if (options.zones === false) layers[LAYER_ORDER.indexOf('zone')]!.fill(0);
  w.intersections.trafficLightKeys = new Set(fixture.trafficLightKeys);
  w.intersections.trafficLights = new Set();
  return true;
}

/**
 * Records for the services the dump shows on its building layer, operational like Rust's prebuilt ones so the city
 * has them from the first tick. Every one of them is a manual 3×3 footprint, so the first tile met row by row is
 * its anchor; an anchor that already has a record is skipped.
 */
export function spawnTestCityServices(w: World): void {
  const [width, length] = MANUAL_BUILDING_FOOTPRINT;
  const taken = new Set(w.buildings.all().map((b) => tileKey(b.anchor)));
  const covered = new Uint8Array(w.grid.len());
  for (let y = 0; y < w.grid.height; y++) {
    for (let x = 0; x < w.grid.width; x++) {
      const idx = y * w.grid.width + x;
      const kind = w.grid.cellAt(idx).building;
      if (kind === null || covered[idx] === 1) continue;
      for (let dy = 0; dy < length; dy++) for (let dx = 0; dx < width; dx++) covered[idx + dy * w.grid.width + dx] = 1;
      if (!taken.has(tileKey({ x, y }))) spawnBuilding(w, { x, y }, width, length, kind, true, DEFAULT_PROFILE);
    }
  }
}

export function loadTestCity(options: TestCityOptions = {}): World {
  const w = createWorld({ mapWidth: fixture.width, mapHeight: fixture.height });
  writeTestCity(w, options);
  w.appState = 'InGame';
  w.graphVersion = fixture.graphVersion;
  detectIntersections(w);
  runFixedTick(w);
  return w;
}
