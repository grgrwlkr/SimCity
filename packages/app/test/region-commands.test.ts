import {describe, expect, it} from 'vitest';
import {applyAction, previewAction} from '../src/region/model/commands';
import {accepted, flatFixture} from './helpers/regionFixture';

describe('regional commands', () => {
  it('founds two settlements and preserves the original identity', () => {
    const initial = flatFixture();
    const first = accepted(
      applyAction(
        initial,
        {type: 'found', name: ' Север ', center: {x: -100, z: 0}},
        0,
      ),
    );
    const second = accepted(
      applyAction(
        first,
        {type: 'found', name: 'Юг', center: {x: 400, z: 0}},
        1,
      ),
    );

    expect(second.settlements.map(s => s.name)).toEqual(['Север', 'Юг']);
    expect(second.settlements[0]).toEqual(first.settlements[0]);
    expect(second.settlements[1]?.id).not.toBe(first.settlements[0]?.id);
    expect(initial.settlements).toEqual([]);
  });
  it.each([
    {x: NaN, z: 0},
    {x: Infinity, z: 0},
    {x: 2100, z: 0},
    {x: 300, z: 300},
  ])('rejects invalid founding atomically at %j', center => {
    const state = flatFixture();
    const result = applyAction(
      state,
      {type: 'found', name: 'Город', center},
      0,
    );

    expect(result.ok).toBe(false);
    expect(result.state).toBe(state);
    expect(state.nextId).toBe(1);
    expect(state.cash).toBe(1_000_000);
  });
  it('rejects a repeated confirmation against an old revision', () => {
    const action = {
      type: 'found' as const,
      name: 'Город',
      center: {x: 0, z: 0},
    };
    const first = accepted(applyAction(flatFixture(), action, 0));

    expect(applyAction(first, action, 0)).toEqual({
      ok: false,
      state: first,
      reason: 'stale-revision',
    });
    expect(first.settlements).toHaveLength(1);
  });
  it('previews without consuming money or IDs', () => {
    const state = flatFixture();

    expect(
      previewAction(state, {type: 'found', name: 'Город', center: {x: 0, z: 0}})
        .valid,
    ).toBe(true);
    expect(state.revision).toBe(0);
    expect(state.nextId).toBe(1);
  });
});
