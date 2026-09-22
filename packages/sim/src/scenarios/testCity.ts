// The test city of rust-final crates/simcity_data/src/game/test_city.rs, frozen as the 128×128 grid its
// examples/dump_routes.rs dumped (`road-routes.json`, which also carries the route pins of the tests) instead of
// regenerated. `LoadTestCity` writes it into the running world; `loadTestCity` builds a fresh world with it the
// way the Rust dumps saw it: intersections detected in Update, then one fixed tick builds every graph.
import { runFixedTick } from '../app';
import { detectIntersections } from '../intersections/index';
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

export function loadTestCity(options: TestCityOptions = {}): World {
  const w = createWorld({ mapWidth: fixture.width, mapHeight: fixture.height });
  const layers = w.grid.layers();
  LAYER_ORDER.forEach((name, i) => layers[i]!.set(hexToBytes(fixture.rawGrid[name])));
  if (options.zones === false) layers[LAYER_ORDER.indexOf('zone')]!.fill(0);
  w.appState = 'InGame';
  w.graphVersion = fixture.graphVersion;
  w.intersections.trafficLightKeys = new Set(fixture.trafficLightKeys);
  detectIntersections(w);
  runFixedTick(w);
  return w;
}
