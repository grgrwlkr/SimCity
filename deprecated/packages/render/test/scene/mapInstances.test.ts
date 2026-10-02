// An edit applied chunk by chunk must leave the same instances as building the edited map from scratch: every batch,
// every owner tile, every matrix. A matrix not moved into a freed slot, or a prop left stale in the chunk next to the
// edit, shows as a difference.
import { describe, expect, it } from 'vitest';
import type { MapLayersReply } from '@simcity/bridge';
import * as THREE from 'three/webgpu';
import { changedChunks, chunkGrid } from '../../src/mapChunks';
import { RenderPrimitives, type CompositeMesh } from '../../src/renderPrimitives';
import { SceneMaterials, createAtlasTexture } from '../../src/scene/atlasNode';
import { MapInstances } from '../../src/scene/mapInstances';

const SIZE = 64;

/** Roads every 8th row and column, buildings of five kinds on every other tile. */
function city(): MapLayersReply {
  const layer = () => new Uint8Array(SIZE * SIZE);
  const layers = { water: layer(), roadKind: layer(), roadDir: layer(), zone: layer(), building: layer() };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      if (x % 8 === 0 || y % 8 === 0) {
        layers.roadKind[i] = 1;
        layers.roadDir[i] = 1;
      } else {
        layers.zone[i] = 1 + ((x + y) % 3);
        layers.building[i] = [1, 2, 3, 4, 6][(x * 7 + y * 3) % 5]!;
      }
    }
  }
  return { width: SIZE, height: SIZE, tileSize: 16, mapEditVersion: 1, graphVersion: 1, mapSeed: '0', layers };
}

function copy(map: MapLayersReply): MapLayersReply {
  const l = map.layers;
  return { ...map, mapEditVersion: map.mapEditVersion + 1, layers: { water: l.water.slice(), roadKind: l.roadKind.slice(), roadDir: l.roadDir.slice(), zone: l.zone.slice(), building: l.building.slice() } };
}

function instances(): MapInstances {
  const prims = new RenderPrimitives();
  const materials = new SceneMaterials(createAtlasTexture());
  const geometries = new Map<CompositeMesh, THREE.BufferGeometry>();
  const geometryOf = (mesh: CompositeMesh) => {
    let g = geometries.get(mesh);
    if (g === undefined) geometries.set(mesh, (g = new THREE.BufferGeometry()));
    return g;
  };
  return new MapInstances(prims, materials, geometryOf);
}

const all = (map: MapLayersReply) => Array.from({ length: chunkGrid(map.width, map.height).cols * chunkGrid(map.width, map.height).rows }, (_, i) => i);

describe('map instances', () => {
  it('an edit applied chunk by chunk equals a fresh build of the edited map', () => {
    const before = city();
    const after = copy(before);
    const l = after.layers;
    // The road on the chunk border x = 16 goes for a stretch: the kerbs of the buildings at x = 15, in the chunk to the
    // west, change with it.
    for (let y = 1; y < 15; y++) {
      l.roadKind[y * SIZE + 16] = 0;
      l.roadDir[y * SIZE + 16] = 0;
    }
    // Buildings go (holes in the middle of their batches), change kind, and one stands where the road was.
    for (let y = 33; y < 48; y += 2) for (let x = 33; x < 48; x += 3) l.building[y * SIZE + x] = 0;
    for (let x = 1; x < 8; x++) l.building[50 * SIZE + x] = 2;
    l.building[5 * SIZE + 16] = 3;

    const edited = instances();
    edited.apply(before, all(before), true);
    const changed = changedChunks(before, after);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThan(all(after).length);
    edited.apply(after, changed, false);
    edited.fillWindows();

    const fresh = instances();
    fresh.apply(after, all(after), true);
    fresh.fillWindows();
    expect(fresh.buildings).toBeGreaterThan(1000);
    expect(fresh.props).toBeGreaterThan(100);
    expect(edited.buildings).toBe(fresh.buildings);
    expect(edited.props).toBe(fresh.props);
    // Multisets, not sets: an instance drawn twice is a difference too.
    expect(edited.batchCounts(), 'instances per batch').toEqual(fresh.batchCounts());
    const tally = (entries: string[]) => entries.reduce((m, e) => m.set(e, (m.get(e) ?? 0) + 1), new Map<string, number>());
    const a = tally(edited.digest());
    const b = tally(fresh.digest());
    const surplus = (x: Map<string, number>, y: Map<string, number>) => [...x].filter(([e, n]) => n > (y.get(e) ?? 0)).map(([e, n]) => `${n - (y.get(e) ?? 0)}× ${e}`);
    expect(surplus(a, b), 'instances only the edited build has').toEqual([]);
    expect(surplus(b, a), 'instances only the fresh build has').toEqual([]);
  });

  it('batches are named by what they hold, so emptying the first shape seen still matches a fresh build', () => {
    const before = city();
    const after = copy(before);
    // Every building of the kind the scan meets first goes: its batches empty, and a fresh build never makes them.
    const first = before.layers.building.find((b) => b !== 0)!;
    after.layers.building.forEach((b, i) => {
      if (b === first) after.layers.building[i] = 0;
    });
    const edited = instances();
    edited.apply(before, all(before), true);
    edited.fillWindows();
    edited.apply(after, changedChunks(before, after), false);
    edited.fillWindows();
    const fresh = instances();
    fresh.apply(after, all(after), true);
    fresh.fillWindows();
    expect(edited.batchCounts()).toEqual(fresh.batchCounts());
    expect([...edited.digest()].sort()).toEqual([...fresh.digest()].sort());
  });

  it('windows wait for fillWindows: setMap places the bodies, the windows follow in slices', () => {
    const map = city();
    const built = instances();
    built.apply(map, all(map), true);
    const windows = () => built.windowBatches().reduce((n, b) => n + b.count, 0);
    expect(built.buildings).toBeGreaterThan(1000);
    expect(windows(), 'no window placed by apply').toBe(0);
    expect(built.windowsPending).toBe(built.buildings);
    // A spent budget still places a slice, and the rest waits for the next frame.
    const left = built.fillWindows(0);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(built.buildings);
    expect(windows() + left).toBe(built.buildings);
    expect(built.fillWindows()).toBe(0);
    expect(built.windowsPending).toBe(0);
    expect(windows(), 'one window set per building').toBe(built.buildings);
  });

  it('only the building bodies cast shadows; everything the map places receives them', () => {
    const map = city();
    const built = instances();
    built.apply(map, all(map), true);
    built.fillWindows();
    const meshes = [...built.buildingGroup.children, ...built.propGroup.children].filter((o) => (o as THREE.InstancedMesh).count > 0);
    expect(meshes.some((o) => o.name.startsWith('windows'))).toBe(true);
    expect(meshes.some((o) => o.name.startsWith('props-'))).toBe(true);
    const casters = meshes.filter((o) => o.castShadow).map((o) => o.name);
    expect(casters.length).toBeGreaterThan(0);
    expect(casters.filter((n) => !n.startsWith('buildings ')), 'windows, glyphs and props cast none').toEqual([]);
    expect(built.buildingBatches().every((b) => b.drawn.castShadow), 'every body casts').toBe(true);
    expect(meshes.filter((o) => !o.receiveShadow).map((o) => o.name), 'everything receives').toEqual([]);
  });
});
