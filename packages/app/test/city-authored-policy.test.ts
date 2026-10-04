import {expect, it} from 'vitest';
import {generateCity} from '../src/city/generator';
import {createLifeProfile} from '../src/city/life/network';
import {createAuthoredDefinition} from '../src/city/life/definition';
import {nativePlacementTransform} from '../src/city/nativeInfrastructurePlacement';
import {CityLife} from '../src/city/life/world';
import type {CityBlock} from '../src/city/generator';

function perimeter(block: CityBlock) {
  return [
    {
      id: 'perimeter',
      points: [
        {x: block.x - 17, z: block.z - 17},
        {x: block.x + 17, z: block.z - 17},
        {x: block.x + 17, z: block.z + 17},
        {x: block.x - 17, z: block.z + 17},
        {x: block.x - 17, z: block.z - 17},
      ],
    },
  ];
}

it('uses approved full-source shop policy despite subset compiler classifying its first commercial as school', () => {
  const source = generateCity('689856');
  const profile = createLifeProfile(source);
  const approved = profile.places.find(place => place.kind === 'shop')!;
  const template = approved.building!;
  const block = source.blocks.find(block => block.id === template.blockId)!;
  const subset = createLifeProfile({
    ...source,
    blocks: [block],
    buildings: [template],
  });

  expect(subset.places[0]!.kind).toBe('school');
  const definition = createAuthoredDefinition({
    seed: source.seed,
    roads: perimeter(block),
    placements: [
      {
        id: 'shop',
        municipalityId: 'town',
        template,
        sourceBlock: block,
        center: template,
        yaw: 0,
        kind: 'shop',
      },
    ],
  });
  const shop = definition.profile.places.find(place => place.id === 'shop')!;

  expect(shop.kind).toBe('shop');
  expect(shop.name).not.toBe('Городская школа');
  expect(shop.price).toBeGreaterThan(0);
  expect({
    price: shop.price,
    wage: shop.wage,
    education: shop.education,
    open: shop.open,
    close: shop.close,
  }).toEqual({
    price: approved.price,
    wage: approved.wage,
    education: approved.education,
    open: approved.open,
    close: approved.close,
  });
});

it('registers the original public park without a fake building or Population after its physical construction', () => {
  const source = generateCity('689856');
  const block = source.blocks.find(block => block.district === 'park')!;
  const space = {
    id: 'park',
    municipalityId: 'town',
    sourceBlock: block,
    center: {x: block.x + 300, z: block.z + 500},
    yaw: 0.4,
    startedAt: 0,
    readyAt: 2,
  };
  const transform = nativePlacementTransform(space, block);
  const roads = perimeter(block).map(road => ({
    ...road,
    points: road.points.map(point => transform.toWorld(point)),
  }));
  const world = CityLife.fromDefinition(
    createAuthoredDefinition({seed: source.seed, roads, spaces: [space]}),
  );
  const population = world.population;

  expect(world.population.hasPlace('park')).toBe(false);
  world.advance(1);
  expect(world.frame().construction?.['park']).toBe(0.5);
  const resumed = CityLife.fromSave(
    JSON.parse(JSON.stringify(world.save())) as unknown,
  );

  world.advance(1);
  resumed.advance(1);
  expect(world.population).toBe(population);
  expect(world.population.place('park').kind).toBe('park');
  expect(world.population.place('park').building).toBeUndefined();
  expect(world.population.place('park').capacity).toBe(60);
  expect(world.profile.layout.buildings).toEqual([]);
  expect(resumed.save()).toEqual(world.save());
});
