// The Rust test city from the examples/dump_routes.rs fixture, loaded into a TS world the way the
// Rust dumps see it: intersections detected in Update, then one fixed tick builds every graph.
import { runFixedTick } from '../src/app';
import { detectIntersections } from '../src/intersections/index';
import { createWorld, type World } from '../src/world';
import fixture from './fixtures/road-routes.json';

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

export function loadTestCity(): World {
  const w = createWorld({ mapWidth: fixture.width, mapHeight: fixture.height });
  const layers = w.grid.layers();
  LAYER_ORDER.forEach((name, i) => layers[i]!.set(hexToBytes(fixture.rawGrid[name])));
  w.appState = 'InGame';
  w.graphVersion = fixture.graphVersion;
  w.intersections.trafficLightKeys = new Set(fixture.trafficLightKeys);
  detectIntersections(w);
  runFixedTick(w);
  return w;
}
