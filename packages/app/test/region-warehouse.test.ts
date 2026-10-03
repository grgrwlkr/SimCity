import {expect, it} from 'vitest';
import {applyAction} from '../src/region/model/commands';
import {accepted, flatFixture} from './helpers/regionFixture';

it('does not reconnect a warehouse through its side wall', () => {
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
  state = accepted(
    applyAction(
      state,
      {type: 'remove', id: state.roads.at(-1)!.id},
      state.revision,
    ),
  );
  state = accepted(
    applyAction(
      state,
      {
        type: 'road',
        points: [
          {x: -84, z: 12},
          {x: -84, z: 24},
        ],
      },
      state.revision,
    ),
  );
  expect(state.warehouses[0]?.access).toBeNull();
});
it('places a snapped warehouse once and prevents overlapping warehouses', () => {
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
  const action = {
    type: 'warehouse' as const,
    settlementId: state.settlements[0]!.id,
    center: {x: -100, z: 20},
  };
  const built = accepted(applyAction(state, action, state.revision));

  expect(built.warehouses).toHaveLength(1);
  expect(built.cash).toBe(state.cash - 20_000);
  expect(built.warehouses[0]?.access).not.toBeNull();
  expect(applyAction(built, action, built.revision).ok).toBe(false);
  expect(
    applyAction(
      built,
      {type: 'remove', id: built.settlements[0]!.id},
      built.revision,
    ).ok,
  ).toBe(false);
  const disconnected = accepted(
    applyAction(
      built,
      {type: 'remove', id: built.roads.at(-1)!.id},
      built.revision,
    ),
  );

  expect(disconnected.warehouses[0]?.id).toBe(built.warehouses[0]?.id);
  expect(disconnected.warehouses[0]?.access).toBeNull();
});
