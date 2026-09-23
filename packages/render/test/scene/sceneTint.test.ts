// The scene's building tint under a data map (review F11, F12): a SceneRenderer on a stub GPU renderer is given a map and
// a data map the way main.tsx gives them, and the instance colours are read back. Rooftops carry the tile's map colour in
// linear light; an edit re-tints only the edited chunks' buildings, a refresh only the tiles whose numbers moved, and the
// plain map rewrites no colour at all.
import type { MapLayersReply } from '@simcity/bridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_TILES } from '../../src/mapChunks';
import { landValueColor, paintOver } from '../../src/dataMap';
import { InstanceBatch } from '../../src/scene/instanceBatch';
import type { MapInstances } from '../../src/scene/mapInstances';
import { SceneRenderer } from '../../src/scene/sceneRenderer';

const SIZE = 2 * CHUNK_TILES;
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Roads on every 4th row and column, a building of one of five kinds on every other tile. */
function city(): MapLayersReply {
  const layer = () => new Uint8Array(SIZE * SIZE);
  const layers = { water: layer(), roadKind: layer(), roadDir: layer(), zone: layer(), building: layer() };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      if (x % 4 === 0 || y % 4 === 0) layers.roadKind[i] = layers.roadDir[i] = 1;
      else [layers.zone[i], layers.building[i]] = [1 + ((x + y) % 3), [1, 2, 3, 4, 6][(x * 7 + y * 3) % 5]!];
    }
  }
  return { width: SIZE, height: SIZE, tileSize: 16, mapEditVersion: 1, graphVersion: 1, mapSeed: '0', layers };
}

/** Land value with fractional channels (0.1..0.4 is red to orange): a missing sRGB→linear step shows. */
const values = (seed = 0) => Float32Array.from({ length: SIZE * SIZE }, (_, i) => 0.1 + ((i + seed) % 4) * 0.1);

function scene(): SceneRenderer {
  const make = SceneRenderer as unknown as new (renderer: unknown, canvas: unknown) => SceneRenderer;
  return new make({}, { clientWidth: 64, clientHeight: 64 });
}
const instancesOf = (s: SceneRenderer) => (s as unknown as { instances: MapInstances }).instances;
const built = (map: MapLayersReply) => [...map.layers.building.keys()].filter((i) => map.layers.building[i] !== 0);
const batchOf = (s: SceneRenderer, tile: number) => instancesOf(s).buildingBatches().find((b) => b.tintOf(tile) !== null)!;

function expectTint(s: SceneRenderer, tile: number, landValue: Float32Array): void {
  const want = paintOver(landValueColor(landValue[tile]!), [1, 1, 1]).map(linear);
  const got = batchOf(s, tile).tintOf(tile)!;
  got.forEach((c, k) => expect(c, `tile ${tile} channel ${k}: ${got} vs ${want}`).toBeCloseTo(want[k]!, 5));
}

describe('scene building tint', () => {
  beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('aDataMapTintsEveryRooftopWithItsTilesColourInLinearLight', () => {
    const s = scene();
    const map = city();
    s.setMap(map);
    const landValue = values();
    s.setDataMap('LandValue', { landValue, version: '1' });
    for (const tile of built(map)) expectTint(s, tile, landValue);

    s.setDataMap('None', null);
    for (const tile of built(map)) expect(batchOf(s, tile).tintOf(tile)).toEqual([1, 1, 1]);
  });

  it('anEditUnderAnOpenMapTintsTheEditedChunksBuildingsAndNoOthers', () => {
    const s = scene();
    const map = city();
    s.setMap(map);
    const landValue = values();
    s.setDataMap('LandValue', { landValue, version: '1' });
    // Tile (1, 1) changes kind: its building moves to another batch and starts plain there.
    const edited = { ...map, mapEditVersion: 2, layers: { ...map.layers, building: map.layers.building.slice() } };
    const tile = SIZE + 1;
    edited.layers.building[tile] = map.layers.building[tile] === 6 ? 1 : 6;
    const whole = vi.spyOn(InstanceBatch.prototype, 'tint');
    const owners = vi.spyOn(InstanceBatch.prototype, 'tintOwner');
    s.setMap(edited);
    expect(whole, 'no pass over every instance').not.toHaveBeenCalled();
    const touched = owners.mock.calls.map(([owner]) => owner);
    expect(touched).toContain(tile);
    expect(touched.every((t) => t % SIZE < CHUNK_TILES && Math.floor(t / SIZE) < CHUNK_TILES), 'only chunk 0, the edited one').toBe(true);
    for (const t of built(edited)) expectTint(s, t, landValue);
  });

  it('thePlainMapRewritesNoColourOnAnEdit', () => {
    const s = scene();
    const map = city();
    s.setMap(map);
    const edited = { ...map, mapEditVersion: 2, layers: { ...map.layers, building: map.layers.building.slice() } };
    edited.layers.building[SIZE + 1] = 0;
    const whole = vi.spyOn(InstanceBatch.prototype, 'tint');
    const owners = vi.spyOn(InstanceBatch.prototype, 'tintOwner');
    s.setMap(edited);
    expect(whole).not.toHaveBeenCalled();
    expect(owners).not.toHaveBeenCalled();
  });

  it('aRefreshReTintsOnlyTheTilesWhoseNumbersMovedAndUploadsNothingWhenNoneDid', () => {
    const s = scene();
    const map = city();
    s.setMap(map);
    const landValue = values();
    s.setDataMap('LandValue', { landValue, version: '1' });
    const tile = SIZE + 1;
    const moved = landValue.slice();
    moved[tile] = 0.45;
    const whole = vi.spyOn(InstanceBatch.prototype, 'tint');
    const owners = vi.spyOn(InstanceBatch.prototype, 'tintOwner');
    s.setDataMap('LandValue', { landValue: moved, version: '2' });
    expect(whole).not.toHaveBeenCalled();
    expect(owners.mock.calls.map(([owner]) => owner)).toEqual([tile]);
    expectTint(s, tile, moved);

    // New version, same numbers: nothing to tint, so no colour buffer goes to the GPU.
    owners.mockClear();
    const versions = instancesOf(s).buildingBatches().map((b) => b.drawn.instanceColor!.version);
    s.setDataMap('LandValue', { landValue: moved.slice(), version: '3' });
    expect(owners).not.toHaveBeenCalled();
    expect(instancesOf(s).buildingBatches().map((b) => b.drawn.instanceColor!.version)).toEqual(versions);
  });
});
