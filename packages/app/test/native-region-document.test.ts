import {describe, expect, it} from 'vitest';
import {generateCity} from '../src/city/generator';
import {
  applyNativeEdit,
  createNativeRegionDocument,
  readNativeRegionDocument,
} from '../src/game/regionDocument';
import {compileNativeRegion} from '../src/game/compileRegion';
import {nativePortNavigation} from '../src/city/nativePortNavigation';
import {townHallRoadPoints} from '../src/region/model/townHall';

describe('native region document', () => {
  it('keeps the validated whole-ship boundary route through document and world JSON', () => {
    const initial = createNativeRegionDocument('world', '689856');
    const placed = applyNativeEdit(
      initial,
      {
        type: 'port',
        center: {x: 1571.3997225421572, z: -176.83003340676078},
        yaw: Math.PI * 1.5,
      },
      1000000,
      0,
    ).document;
    const port = placed.infrastructure!.ports[0]!;
    const route = nativePortNavigation(initial.terrain, port);

    expect(route).not.toBeNull();
    expect(port.navigation).toEqual(route);
    const restored = readNativeRegionDocument(
      JSON.parse(JSON.stringify(placed)) as unknown,
    );

    expect(restored!.infrastructure!.ports[0]!.navigation).toEqual(route);
    expect(
      compileNativeRegion(restored!, 0).infrastructure!.ports[0]!.navigation,
    ).toEqual(route);
  });
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
      generateCity(block.sourceSeed).buildings.filter(
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
  it('assembles distinct placed blocks from stable original procedural seeds', () => {
    const founded = applyNativeEdit(
      createNativeRegionDocument('world', '689856'),
      {type: 'found', center: {x: -600, z: 0}, name: 'Первый'},
      1000000,
      0,
    ).document;
    const edit = {
      type: 'block' as const,
      settlementId: founded.settlements[0]!.id,
      center: {x: -600, z: 75},
      district: 'residential' as const,
      houses: true,
    };
    const first = applyNativeEdit(founded, edit, 1000000, 10).document;
    const removed = applyNativeEdit(
      first,
      {type: 'remove', id: first.blocks[0]!.id},
      1000000,
      10,
    ).document;
    const second = applyNativeEdit(removed, edit, 1000000, 10).document;

    expect(first.blocks[0]!.sourceSeed).not.toBe(second.blocks[0]!.sourceSeed);
    expect(first.blocks[0]!.templates).not.toEqual(second.blocks[0]!.templates);
    expect(applyNativeEdit(founded, edit, 1000000, 10).document).toEqual(first);
    const restored = readNativeRegionDocument(
      JSON.parse(JSON.stringify(second)) as unknown,
    )!;

    expect(restored.blocks[0]!.templates).toEqual(second.blocks[0]!.templates);
    expect(compileNativeRegion(restored, 10)).toEqual(
      compileNativeRegion(second, 10),
    );
  });
  it('places distinct parks from stable original procedural seeds', () => {
    const founded = applyNativeEdit(
      createNativeRegionDocument('world', '689856'),
      {type: 'found', center: {x: -600, z: 0}, name: 'Первый'},
      1000000,
      0,
    ).document;
    const edit = {
      type: 'park' as const,
      settlementId: founded.settlements[0]!.id,
      center: {x: -640, z: 75},
    };
    const otherEdit = {
      type: 'park' as const,
      settlementId: founded.settlements[0]!.id,
      center: {x: -560, z: 75},
    };
    const first = applyNativeEdit(founded, edit, 1000000, 10).document;
    const second = applyNativeEdit(first, otherEdit, 1000000, 10).document;
    const removed = applyNativeEdit(
      second,
      {type: 'remove', id: second.spaces![1]!.id},
      1000000,
      10,
    ).document;
    const replaced = applyNativeEdit(removed, otherEdit, 1000000, 10).document;
    const [parkA, parkC] = replaced.spaces!;
    const source = generateCity(founded.seed);

    expect(parkA!.sourceBlock).not.toEqual(parkC!.sourceBlock);
    expect(parkA!.sourceBlock).toEqual(
      source.blocks.find(block => block.id === parkA!.sourceBlock.id),
    );
    expect(parkA!.sourceSeed).toBe(founded.seed);
    expect(applyNativeEdit(founded, edit, 1000000, 10).document).toEqual(first);
    const restored = readNativeRegionDocument(
      JSON.parse(JSON.stringify(replaced)) as unknown,
    )!;

    expect(restored.spaces).toEqual(replaced.spaces);
    expect(compileNativeRegion(restored, 10)).toEqual(
      compileNativeRegion(replaced, 10),
    );
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
  it('expands a hall only after eight full blocks finish and the upgrade is paid', () => {
    let document = applyNativeEdit(
      createNativeRegionDocument('world', '689856'),
      {type: 'found', center: {x: -600, z: 0}, name: 'Первый'},
      1000000,
      0,
    ).document;
    const settlementId = document.settlements[0]!.id;

    for (const z of [90, 130]) {
      for (const x of [-680, -640, -600, -560]) {
        document = applyNativeEdit(
          document,
          {
            type: 'block',
            center: {x, z},
            settlementId,
            district: 'residential',
          },
          1000000,
          0,
        ).document;
      }
    }

    expect(() =>
      applyNativeEdit(document, {type: 'upgrade', settlementId}, 50000, 59),
    ).toThrow('готовых');
    expect(() =>
      applyNativeEdit(document, {type: 'upgrade', settlementId}, 49999, 60),
    ).toThrow('средств');
    const upgraded = applyNativeEdit(
      document,
      {type: 'upgrade', settlementId},
      50000,
      60,
    );

    expect(upgraded.cost).toBe(50000);
    expect(upgraded.document.settlements[0]!.townHall!.level).toBe(2);
    expect(document.settlements[0]!.townHall!.level).toBe(1);
    expect(upgraded.document.blocks).toEqual(document.blocks);
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
