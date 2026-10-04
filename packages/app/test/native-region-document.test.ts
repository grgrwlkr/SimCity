import {describe, expect, it} from 'vitest';
import {generateCity} from '../src/city/generator';
import {
  applyNativeEdit,
  createNativeRegionDocument,
} from '../src/game/regionDocument';
import {townHallRoadPoints} from '../src/region/model/townHall';

describe('native region document', () => {
  it('founds a hall with its road and removes both atomically', () => {
    const initial = createNativeRegionDocument('world', '689856');
    const result = applyNativeEdit(
      initial,
      {type: 'found', center: {x: -600, z: 0}, name: 'Первый'},
      1000000,
      0,
    );

    expect(result.document.settlements).toHaveLength(1);
    expect(result.document.roads[0]!.points).toEqual(
      townHallRoadPoints({x: -600, z: 0}),
    );
    const removed = applyNativeEdit(
      result.document,
      {type: 'remove', id: result.document.roads[0]!.id},
      1000000,
      0,
    );

    expect(removed.document.settlements).toEqual([]);
    expect(removed.document.roads).toEqual([]);
    expect(initial.settlements).toEqual([]);
  });
  it('reserves the native whole block footprint without resizing its source templates', () => {
    const initial = createNativeRegionDocument('world', '689856');
    const founded = applyNativeEdit(
      initial,
      {type: 'found', center: {x: -600, z: 0}, name: 'Первый'},
      1000000,
      0,
    ).document;
    const placed = applyNativeEdit(
      founded,
      {
        type: 'block',
        settlementId: founded.settlements[0]!.id,
        center: {x: -600, z: 75},
        district: 'residential',
        houses: true,
      },
      1000000,
      10,
    ).document;
    const block = placed.blocks[0]!;

    expect(block.templates.some(template => template.plot)).toBe(true);
    expect(block.templates).toEqual(
      generateCity('689856').buildings.filter(
        template => template.blockId === block.sourceBlock.id,
      ),
    );
    expect(() =>
      applyNativeEdit(
        placed,
        {
          type: 'block',
          settlementId: founded.settlements[0]!.id,
          center: {x: -600, z: 400},
          district: 'residential',
        },
        1000000,
        10,
      ),
    ).toThrow('радиусе');
  });
  it('never mutates a document on a failed budget or upgrade requirement', () => {
    const initial = createNativeRegionDocument('world', '689856');

    expect(() =>
      applyNativeEdit(
        initial,
        {type: 'found', center: {x: -600, z: 0}, name: 'Первый'},
        0,
        0,
      ),
    ).toThrow('средств');
    expect(initial.revision).toBe(0);
    const founded = applyNativeEdit(
      initial,
      {type: 'found', center: {x: -600, z: 0}, name: 'Первый'},
      1000000,
      0,
    ).document;

    expect(() =>
      applyNativeEdit(
        founded,
        {type: 'upgrade', settlementId: founded.settlements[0]!.id},
        1000000,
        100,
      ),
    ).toThrow('готовых');
  });
  it('rounds ray-picked diagonal road prices to whole game currency', () => {
    const initial = createNativeRegionDocument('world', '689856');
    const result = applyNativeEdit(
      initial,
      {
        type: 'road',
        points: [
          {x: -1400.123, z: -700.231},
          {x: -1267.813, z: -652.163},
        ],
      },
      1000000,
      0,
    );

    expect(Number.isInteger(result.cost)).toBe(true);
    expect(result.cost).toBe(Math.round(Math.hypot(132.31, 48.068) * 100));
  });
});
