import {describe, expect, it} from 'vitest';
import {applyAction} from '../src/region/model/commands';
import {accepted, flatFixture} from './helpers/regionFixture';

function prepared() {
  const found = accepted(
    applyAction(
      flatFixture(),
      {type: 'found', name: 'A', center: {x: -100, z: -100}},
      0,
    ),
  );

  return accepted(
    applyAction(
      found,
      {
        type: 'road',
        points: [
          {x: -200, z: 0},
          {x: 100, z: 0},
        ],
      },
      found.revision,
    ),
  );
}

describe('regional lots', () => {
  it('assigns zones to the selected settlement and preserves IDs when rezoning', () => {
    const state = prepared();
    const action = {
      type: 'zone' as const,
      settlementId: state.settlements[0]!.id,
      kind: 'residential' as const,
      selection: {minX: -180, maxX: 80, minZ: 6, maxZ: 40},
    };
    const zoned = accepted(applyAction(state, action, state.revision));

    expect(zoned.parcels.length).toBeGreaterThan(3);
    expect(
      zoned.parcels.every(
        p => p.settlementId === action.settlementId && p.access !== null,
      ),
    ).toBe(true);
    const again = accepted(
      applyAction(zoned, {...action, kind: 'commercial'}, zoned.revision),
    );

    expect(again.parcels.map(p => p.id)).toEqual(zoned.parcels.map(p => p.id));
    expect(again.parcels.every(p => p.zone === 'commercial')).toBe(true);
  });
  it('keeps lot identity after deleting and reconnecting a road', () => {
    const state = prepared();
    const action = {
      type: 'zone' as const,
      settlementId: state.settlements[0]!.id,
      kind: 'industrial' as const,
      selection: {minX: -180, maxX: 80, minZ: 6, maxZ: 40},
    };
    const zoned = accepted(applyAction(state, action, state.revision));
    const removed = accepted(
      applyAction(
        zoned,
        {type: 'remove', id: zoned.roads.at(-1)!.id},
        zoned.revision,
      ),
    );

    expect(removed.parcels.map(p => p.id)).toEqual(
      zoned.parcels.map(p => p.id),
    );
    expect(removed.parcels.every(p => p.access === null)).toBe(true);
    const connected = accepted(
      applyAction(
        removed,
        {
          type: 'road',
          points: [
            {x: -200, z: 0},
            {x: 100, z: 0},
          ],
        },
        removed.revision,
      ),
    );

    expect(connected.parcels.every(p => p.access !== null)).toBe(true);
    expect(connected.parcels.map(p => p.id)).toEqual(
      zoned.parcels.map(p => p.id),
    );
  });
  it('rejects zoning without a road or without a settlement', () => {
    const state = prepared();

    expect(
      applyAction(
        state,
        {
          type: 'zone',
          settlementId: state.settlements[0]!.id,
          kind: 'residential',
          selection: {minX: -500, maxX: -450, minZ: -500, maxZ: -450},
        },
        state.revision,
      ).ok,
    ).toBe(false);
    expect(
      applyAction(
        state,
        {
          type: 'zone',
          settlementId: 'missing',
          kind: 'residential',
          selection: {minX: -200, maxX: 100, minZ: 6, maxZ: 40},
        },
        state.revision,
      ).ok,
    ).toBe(false);
  });
});
