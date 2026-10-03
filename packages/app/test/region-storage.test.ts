import {describe, expect, it} from 'vitest';
import {
  listRegions,
  readRegion,
  storeRegion,
  deleteRegion,
} from '../src/region/storage';
import type {RegionStoragePort} from '../src/region/storage';
import {parseRegion, serializeRegion} from '../src/region/model/save';
import {flatFixture} from './helpers/regionFixture';

class MapStorage implements RegionStoragePort {
  readonly records = new Map<string, unknown>();

  put(id: string, value: string): Promise<void> {
    this.records.set(id, value);

    return Promise.resolve();
  }

  remove(id: string): Promise<void> {
    this.records.delete(id);

    return Promise.resolve();
  }

  get(id: string): Promise<unknown> {
    return Promise.resolve(this.records.get(id) ?? null);
  }

  list(): Promise<
    ReadonlyArray<{readonly id: string; readonly value: unknown}>
  > {
    return Promise.resolve(
      [...this.records].map(([id, value]) => ({id, value})),
    );
  }
}

describe('region storage', () => {
  it('deletes only the selected key, including malformed saves', async () => {
    const port = new MapStorage();
    const state = flatFixture();

    await storeRegion(state.id, serializeRegion(state), port);
    port.records.set('broken', 'not JSON');
    await deleteRegion('broken', port);
    expect(await readRegion('broken', port)).toBeNull();
    expect(parseRegion(await readRegion(state.id, port))).toEqual(state);
    await deleteRegion(state.id, port);
    expect(await listRegions(port)).toEqual([]);
  });
  it('propagates deletion failures and keeps the save available', async () => {
    const port = new MapStorage();

    port.records.set('broken', 'not JSON');
    port.remove = () => Promise.reject(new Error('disk failure'));
    await expect(deleteRegion('broken', port)).rejects.toThrow('disk failure');
    expect(await readRegion('broken', port)).toBe('not JSON');
  });
  it('same_seed_different_region_ids_have_separate_keys', async () => {
    const port = new MapStorage();
    const first = {...flatFixture(), id: 'first', cash: 1000};
    const second = {...flatFixture(), id: 'second', cash: 2000};

    await storeRegion(first.id, serializeRegion(first), port);
    await storeRegion(second.id, serializeRegion(second), port);
    expect(parseRegion(await readRegion('first', port))).toEqual(first);
    expect(parseRegion(await readRegion('second', port))).toEqual(second);
    expect(await readRegion('missing', port)).toBeNull();
  });
  it('saved_regions_are_selectable_after_new_game', async () => {
    const port = new MapStorage();
    const state = {
      ...flatFixture(),
      id: 'original',
      settlements: [{id: 'settlement-1', name: 'Север', center: {x: 0, z: 0}}],
      nextId: 2,
    };

    await storeRegion('original', serializeRegion(state), port);
    await storeRegion(
      'new-game',
      serializeRegion({...flatFixture(), id: 'new-game'}),
      port,
    );
    const options = await listRegions(port);

    expect(options.map(s => s.id)).toEqual(['original', 'new-game']);
    expect(options[0]?.label).toContain('Север');
    expect(options[0]).toMatchObject({name: 'Север', seed: state.seed});
    expect(options[1]).toMatchObject({name: 'Пустой регион', seed: state.seed});
    expect(parseRegion(await readRegion(options[0]!.id, port))).toEqual(state);
  });
  it('lists incompatible records while preserving their raw data', async () => {
    const port = new MapStorage();
    const incompatible = {
      kind: 'simcity-region',
      version: 99,
      state: flatFixture(),
    };

    port.records.set('future', incompatible);
    port.records.set('broken', 'not JSON');
    port.records.set('wrong-key', serializeRegion(flatFixture()));
    const options = await listRegions(port);

    expect(options.map(s => s.id)).toEqual(['future', 'broken', 'wrong-key']);
    expect(options.every(s => /несовместим|поврежд/i.test(s.label))).toBe(true);
    expect(options.every(s => s.seed === null)).toBe(true);
    expect(await readRegion('future', port)).toBe(incompatible);
    await expect(
      storeRegion('wrong-id', serializeRegion(flatFixture()), port),
    ).rejects.toThrow();
    expect(await readRegion('wrong-id', port)).toBeNull();
  });
  it('propagates write failures without claiming a saved region', async () => {
    const port = new MapStorage();

    port.put = () => Promise.reject(new Error('disk failure'));
    await expect(
      storeRegion('test-region', serializeRegion(flatFixture()), port),
    ).rejects.toThrow('disk failure');
    expect(await listRegions(port)).toEqual([]);
  });
});
