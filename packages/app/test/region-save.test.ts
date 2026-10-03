import {describe, expect, it} from 'vitest';
import {parseRegion, serializeRegion} from '../src/region/model/save';
import {applyAction} from '../src/region/model/commands';
import {flatFixture, accepted} from './helpers/regionFixture';

describe('region saves', () => {
  it('rejects unsupported bounds before a terrain renderer can loop without progress', () => {
    const state = flatFixture();

    expect(() =>
      parseRegion({
        kind: 'simcity-region',
        version: 3,
        state: {
          ...state,
          terrain: {
            ...state.terrain,
            bounds: {minX: -1e30, maxX: 1e30, minZ: -1e30, maxZ: 1e30},
          },
        },
      }),
    ).toThrow();
  });
  it('rejects overlapping roads with distinct IDs', () => {
    const state = accepted(
      applyAction(
        flatFixture(),
        {
          type: 'road',
          points: [
            {x: -200, z: 0},
            {x: 100, z: 0},
          ],
        },
        0,
      ),
    );

    expect(() =>
      parseRegion({
        kind: 'simcity-region',
        version: 3,
        state: {
          ...state,
          roads: [...state.roads, {...state.roads[0]!, id: 'road-2'}],
          nextId: 3,
        },
      }),
    ).toThrow();
  });
  it('rejects a warehouse claiming access to a distant road', () => {
    let state = accepted(
      applyAction(
        flatFixture(),
        {type: 'found', name: 'A', center: {x: -100, z: -100}},
        0,
      ),
    );

    state = accepted(
      applyAction(
        state,
        {
          type: 'road',
          points: [
            {x: -200, z: 0},
            {x: 100, z: 0},
          ],
        },
        state.revision,
      ),
    );
    state = accepted(
      applyAction(
        state,
        {
          type: 'warehouse',
          settlementId: state.settlements[0]!.id,
          center: {x: -100, z: 20},
        },
        state.revision,
      ),
    );
    expect(() =>
      parseRegion({
        kind: 'simcity-region',
        version: 3,
        state: {
          ...state,
          warehouses: [{...state.warehouses[0]!, center: {x: -800, z: 800}}],
        },
      }),
    ).toThrow();
  });
  it('restores identity, custom rules and next command IDs', () => {
    const state = accepted(
      applyAction(
        {
          ...flatFixture(),
          rules: {...flatFixture().rules, roadCostPerMeter: 31},
        },
        {type: 'found', name: 'Север', center: {x: 0, z: 0}},
        0,
      ),
    );
    const loaded = parseRegion(JSON.parse(serializeRegion(state)));

    expect(loaded).toEqual(state);
    const next = accepted(
      applyAction(
        loaded,
        {type: 'found', name: 'Юг', center: {x: 500, z: 0}},
        loaded.revision,
      ),
    );

    expect(next.settlements[1]?.id).not.toBe(loaded.settlements[0]?.id);
  });
  it('rejects unknown format version', () => {
    expect(() =>
      parseRegion({kind: 'simcity-region', version: 99, state: flatFixture()}),
    ).toThrow('Неподдерживаемая версия сохранения региона');
  });
  it('rejects duplicate IDs and orphan ownership', () => {
    const state = accepted(
      applyAction(
        flatFixture(),
        {type: 'found', name: 'A', center: {x: 0, z: 0}},
        0,
      ),
    );

    expect(() =>
      parseRegion({
        kind: 'simcity-region',
        version: 3,
        state: {
          ...state,
          settlements: [...state.settlements, ...state.settlements],
        },
      }),
    ).toThrow();
    expect(() =>
      parseRegion({
        kind: 'simcity-region',
        version: 3,
        state: {
          ...state,
          warehouses: [
            {
              id: 'warehouse-2',
              settlementId: 'missing',
              center: {x: 0, z: 0},
              heading: 0,
              access: null,
            },
          ],
          nextId: 3,
        },
      }),
    ).toThrow();
  });
  it('rejects malformed geometry, money and stale ID counters', () => {
    for (const bad of [
      {cash: NaN},
      {cash: -1},
      {
        roads: [
          {
            id: 'road-1',
            points: [
              {x: NaN, z: 0},
              {x: 10, z: 0},
            ],
          },
        ],
      },
      {
        settlements: [{id: 'settlement-5', name: 'A', center: {x: 0, z: 0}}],
        nextId: 2,
      },
    ]) {
      expect(() =>
        parseRegion({
          kind: 'simcity-region',
          version: 3,
          state: {...flatFixture(), ...bad},
        }),
      ).toThrow();
    }
  });
});
