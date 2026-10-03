import {describe, expect, it} from 'vitest';
import {applyAction, previewAction} from '../src/region/model/commands';
import {buildRoadGraph, findRoadPath} from '../src/region/model/roads';
import {accepted, flatFixture} from './helpers/regionFixture';

describe('player roads', () => {
  it('connects a branch snapped to a diagonal after centimeter normalization', () => {
    let state = accepted(
      applyAction(
        flatFixture(),
        {
          type: 'road',
          points: [
            {x: 0, z: 0},
            {x: 100, z: 33},
          ],
        },
        0,
      ),
    );

    state = accepted(
      applyAction(
        state,
        {
          type: 'road',
          points: [
            {x: 33.333, z: 10.99989},
            {x: 33.33, z: 100},
          ],
        },
        state.revision,
      ),
    );
    expect(
      findRoadPath(
        buildRoadGraph(state.roads),
        {x: 0, z: 0},
        {x: 33.33, z: 100},
      ),
    ).not.toBeNull();
  });
  it('rejects the rendered sidewalk extending onto water', () => {
    const state = flatFixture();

    expect(
      applyAction(
        state,
        {
          type: 'road',
          points: [
            {x: 195, z: 250},
            {x: 195, z: 350},
          ],
        },
        0,
      ),
    ).toEqual({ok: false, state, reason: 'water'});
  });
  it('rejects a road whose width leaves the region along the border', () => {
    const state = flatFixture();

    expect(
      applyAction(
        state,
        {
          type: 'road',
          points: [
            {x: -100, z: -2000},
            {x: 100, z: -2000},
          ],
        },
        0,
      ),
    ).toEqual({ok: false, state, reason: 'outside'});
  });
  it('charges 100 meters once and previews its footprint', () => {
    const state = flatFixture();
    const action = {
      type: 'road' as const,
      points: [
        {x: -100, z: 0},
        {x: 0, z: 0},
      ],
    };

    expect(previewAction(state, action).cost).toBe(10_000);
    const built = accepted(applyAction(state, action, 0));

    expect(built.cash).toBe(990_000);
    expect(built.roads).toHaveLength(1);
    expect(built.roadRevision).toBe(1);
    expect(applyAction(built, action, 0).ok).toBe(false);
    expect(built.cash).toBe(990_000);
  });
  it('rejects the whole polyline when a later segment crosses water', () => {
    const state = flatFixture();
    const result = applyAction(
      state,
      {
        type: 'road',
        points: [
          {x: 0, z: 300},
          {x: 100, z: 300},
          {x: 500, z: 300},
        ],
      },
      0,
    );

    expect(result).toEqual({ok: false, state, reason: 'water'});
    expect(state.roads).toHaveLength(0);
    expect(state.nextId).toBe(1);
  });
  it('supports an external entry at the real border and rejects an internal endpoint', () => {
    const state = accepted(
      applyAction(
        flatFixture(),
        {
          type: 'road',
          points: [
            {x: -2000, z: 0},
            {x: -1900, z: 0},
          ],
        },
        0,
      ),
    );
    const road = state.roads[0]!;

    expect(
      applyAction(
        state,
        {type: 'external-entry', roadId: road.id, endpoint: 'end'},
        state.revision,
      ).ok,
    ).toBe(false);
    const entry = accepted(
      applyAction(
        state,
        {type: 'external-entry', roadId: road.id, endpoint: 'start'},
        state.revision,
      ),
    );

    expect(entry.externalEntries[0]?.roadId).toBe(road.id);
  });
  it('rejects overlap, zero length and insufficient funds without mutation', () => {
    const state = accepted(
      applyAction(
        flatFixture(),
        {
          type: 'road',
          points: [
            {x: -100, z: 0},
            {x: 0, z: 0},
          ],
        },
        0,
      ),
    );
    const overlap = applyAction(
      state,
      {
        type: 'road',
        points: [
          {x: -50, z: 0},
          {x: 20, z: 0},
        ],
      },
      state.revision,
    );

    expect(overlap.ok).toBe(false);
    expect(
      applyAction(
        state,
        {
          type: 'road',
          points: [
            {x: 0, z: 0},
            {x: 0, z: 0},
          ],
        },
        state.revision,
      ).ok,
    ).toBe(false);
    const poor = {...state, cash: 1};

    expect(
      applyAction(
        poor,
        {
          type: 'road',
          points: [
            {x: 0, z: 0},
            {x: 0, z: 100},
          ],
        },
        poor.revision,
      ),
    ).toEqual({ok: false, state: poor, reason: 'insufficient-funds'});
  });
});
