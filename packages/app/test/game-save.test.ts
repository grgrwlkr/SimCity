import {describe, expect, it, vi} from 'vitest';
import {CityLife} from '../src/city/life/world';
import {createGameSave, parseGameSave} from '../src/game/save';
import {deleteGame, listGames, readGame, storeGame} from '../src/game/storage';
import type {RegionStoragePort} from '../src/region/storage';
import {serializeRegion} from '../src/region/model/save';
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

const world = new CityLife('689856', 3);

world.advance(35);
const native = () => createGameSave('native', 'Город у воды', world.save());

describe('native game save', () => {
  it('preserves the native world through its JSON envelope and source restore', () => {
    const saved = native();
    const restored = parseGameSave(JSON.stringify(saved));
    const loaded = CityLife.fromSave(restored.world);

    expect(restored).toEqual(JSON.parse(JSON.stringify(saved)));
    loaded.advance(5);
    const continued = CityLife.fromSave(world.save());

    continued.advance(5);
    expect(loaded.save()).toEqual(continued.save());
  });

  it.each([
    {id: ''},
    {name: '   '},
    {seed: ''},
    {seed: 'other-world'},
    {kind: 'simcity-region'},
    {version: 2},
  ])('rejects corrupt game identity or envelope: %j', patch => {
    expect(() => parseGameSave({...native(), ...patch})).toThrow();
  });

  it.each([
    {seed: ''},
    {version: 99},
    {tick: -1},
    {expanded: 'yes'},
    {population: {people: []}},
    {traffic: null},
    {parking: {}},
    {harbor: {}},
    {railway: {}},
    {bus: null},
  ])('rejects unsupported or structurally corrupt native world: %j', patch => {
    const saved = native();

    expect(() =>
      parseGameSave({...saved, world: {...saved.world, ...patch}}),
    ).toThrow();
  });
});

describe('unified game catalogue', () => {
  it('recognizes each supported legacy region version without migrating its record', async () => {
    const port = new MapStorage();
    const state = flatFixture();

    for (const version of [1, 2, 3]) {
      const id = `legacy-${version}`;
      const raw = JSON.stringify({
        kind: 'simcity-region',
        version,
        state: {
          ...state,
          id,
          schemaVersion: version,
          ...(version < 3 ? {life: undefined} : {}),
        },
      });

      port.records.set(id, raw);
    }

    const original = new Map(port.records);
    const games = await listGames(port);

    expect(games).toHaveLength(3);
    expect(
      games.every(game => game.kind === 'legacy-region' && !game.loadable),
    ).toBe(true);
    expect(port.records).toEqual(original);
    await deleteGame('legacy-2', port);
    expect(await readGame('legacy-2', port)).toBeNull();
    expect(await readGame('legacy-1', port)).toBe(original.get('legacy-1'));
    expect(await readGame('legacy-3', port)).toBe(original.get('legacy-3'));
  });

  it('lists mixed native, legacy and invalid records without restoring or rewriting them', async () => {
    const port = new MapStorage();
    const legacy = serializeRegion(flatFixture());
    const invalid = {kind: 'simcity-game', version: 99};

    await storeGame(native(), port);
    port.records.set('test-region', legacy);
    port.records.set('invalid', invalid);
    port.records.set('wrong-key', JSON.stringify(native()));
    const before = new Map(port.records);
    const restore = vi.spyOn(CityLife, 'fromSave');
    const games = await listGames(port);

    expect(games).toMatchObject([
      {
        id: 'native',
        name: 'Город у воды',
        seed: '689856',
        kind: 'native',
        loadable: true,
      },
      {
        id: 'test-region',
        name: 'Пустой регион',
        seed: 'fixture',
        kind: 'legacy-region',
        loadable: false,
      },
      {id: 'invalid', seed: null, kind: 'invalid', loadable: false},
      {id: 'wrong-key', seed: null, kind: 'invalid', loadable: false},
    ]);
    expect(games[1]?.label).toMatch(/импорт/i);
    expect(restore).not.toHaveBeenCalled();
    restore.mockRestore();
    expect(port.records).toEqual(before);
    expect(await readGame('test-region', port)).toBe(legacy);
    expect(await readGame('invalid', port)).toBe(invalid);
    expect(await readGame('missing', port)).toBeNull();
  });

  it('keeps same-seed games independent and deletes only the selected raw record', async () => {
    const port = new MapStorage();
    const second = createGameSave('second', 'Север', world.save());

    await storeGame(native(), port);
    await storeGame(second, port);
    port.records.set('broken', 'not JSON');
    await deleteGame('broken', port);
    expect((await listGames(port)).map(game => game.id)).toEqual([
      'native',
      'second',
    ]);
    await deleteGame('native', port);
    expect(parseGameSave(await readGame('second', port))).toEqual(
      JSON.parse(JSON.stringify(second)),
    );
    expect(await readGame('native', port)).toBeNull();
  });

  it('propagates deletion failures and preserves the selected legacy record', async () => {
    const port = new MapStorage();
    const legacy = serializeRegion(flatFixture());

    port.records.set('test-region', legacy);
    port.remove = () => Promise.reject(new Error('disk failure'));
    await expect(deleteGame('test-region', port)).rejects.toThrow(
      'disk failure',
    );
    expect(await readGame('test-region', port)).toBe(legacy);
  });

  it('validates before writing and propagates storage failures', async () => {
    const port = new MapStorage();

    await expect(
      storeGame({...native(), seed: 'wrong'}, port),
    ).rejects.toThrow();
    expect(port.records.size).toBe(0);
    port.put = () => Promise.reject(new Error('disk failure'));
    await expect(storeGame(native(), port)).rejects.toThrow('disk failure');
    expect(port.records.size).toBe(0);
  });
});
