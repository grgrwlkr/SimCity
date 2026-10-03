import {describe, expect, it} from 'vitest';
import {applyAction, previewAction} from '../src/region/model/commands';
import {parseRegion, serializeRegion} from '../src/region/model/save';
import {accepted, flatFixture} from './helpers/regionFixture';

const action = {
  type: 'found' as const,
  name: 'Север',
  center: {x: -500, z: -500},
};

describe('town hall lifecycle', () => {
  it('charges the fixed frontage length without a floating-point surcharge', () => {
    const request = {...action, center: {x: -299.98, z: -999.24}};
    const state = flatFixture();
    const result = applyAction(state, request, state.revision);

    expect(result.ok && result.cost).toBe(12_800);
    expect(previewAction(state, request).cost).toBe(12_800);
  });
  it('loads legacy geography and placements without moving or flooding them', () => {
    const initial = flatFixture();
    const {life: emptyLife, ...editor} = initial;

    expect(emptyLife.people).toEqual([]);
    const legacy = {
      ...editor,
      schemaVersion: 1,
      nextId: 3,
      settlements: [{id: 'settlement-1', name: 'Старый', center: {x: 0, z: 0}}],
      roads: [
        {
          id: 'road-2',
          points: [
            {x: -100, z: 0},
            {x: 100, z: 0},
          ],
        },
      ],
    };
    const loaded = parseRegion({
      kind: 'simcity-region',
      version: 1,
      state: legacy,
    });

    expect(loaded.schemaVersion).toBe(3);
    expect(loaded.terrain).toEqual(legacy.terrain);
    expect(loaded.settlements).toEqual(legacy.settlements);
    expect(loaded.roads).toEqual(legacy.roads);
    expect(loaded.cash).toBe(legacy.cash);
  });
  it('founds a town hall with an owned road as one budgeted command', () => {
    const initial = flatFixture();
    const preview = previewAction(initial, action);
    const state = accepted(applyAction(initial, action, initial.revision));
    const hall = state.settlements[0]!;

    expect(preview.valid).toBe(true);
    expect(preview.contours).toHaveLength(2);
    expect(preview.cost).toBe(12_800);
    expect(hall.townHall?.roadId).toBe(state.roads[0]?.id);
    expect(state.roads[0]?.points).toEqual([
      {x: -564, z: -452},
      {x: -436, z: -452},
    ]);
    expect(state.cash).toBe(initial.cash - 12_800);
    expect(initial.settlements).toEqual([]);
    expect(initial.roads).toEqual([]);
  });

  it.each(['settlement', 'road'])(
    'removes the hall and road when selecting %s',
    target => {
      const state = accepted(applyAction(flatFixture(), action, 0));
      const id =
        target === 'settlement' ? state.settlements[0]!.id : state.roads[0]!.id;
      const removed = accepted(
        applyAction(state, {type: 'remove', id}, state.revision),
      );

      expect(removed.settlements).toEqual([]);
      expect(removed.roads).toEqual([]);
      expect(removed.cash).toBe(state.cash);
    },
  );

  it('keeps independently added roads when removing the civic complex', () => {
    let state = accepted(applyAction(flatFixture(), action, 0));

    state = accepted(
      applyAction(
        state,
        {
          type: 'road',
          points: [
            {x: -436, z: -452},
            {x: -300, z: -452},
          ],
        },
        state.revision,
      ),
    );
    const independent = state.roads[1]!;
    const removed = accepted(
      applyAction(
        state,
        {type: 'remove', id: state.settlements[0]!.id},
        state.revision,
      ),
    );

    expect(removed.roads).toEqual([independent]);
  });

  it('reserves expansion land against roads and warehouses', () => {
    const state = accepted(applyAction(flatFixture(), action, 0));

    expect(
      applyAction(
        state,
        {
          type: 'road',
          points: [
            {x: -540, z: -500},
            {x: -460, z: -500},
          ],
        },
        state.revision,
      ),
    ).toEqual({ok: false, state, reason: 'occupied'});
    expect(
      applyAction(
        state,
        {
          type: 'warehouse',
          settlementId: state.settlements[0]!.id,
          center: {x: -500, z: -482},
        },
        state.revision,
      ),
    ).toEqual({ok: false, state, reason: 'occupied'});
  });

  it('rejects the whole complex when its road crosses water or funds run out', () => {
    for (const state of [flatFixture(), {...flatFixture(), cash: 10}]) {
      const request =
        state.cash === 10 ? action : {...action, center: {x: 150, z: 300}};
      const result = applyAction(state, request, state.revision);

      expect(result.ok).toBe(false);
      expect(result.state).toBe(state);
      expect(state.nextId).toBe(1);
    }
  });

  it('roundtrips road ownership and rejects a broken owned-road reference', () => {
    const state = accepted(applyAction(flatFixture(), action, 0));

    expect(parseRegion(serializeRegion(state))).toEqual(state);
    expect(() => parseRegion(serializeRegion({...state, roads: []}))).toThrow();
  });
});
