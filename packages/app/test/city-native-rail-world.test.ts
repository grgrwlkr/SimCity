import {expect, it} from 'vitest';
import {createAuthoredDefinition} from '../src/city/life/definition';
import {nativeRailwayAccessRoads} from '../src/city/life/nativeInfrastructure';
import {CityLife} from '../src/city/life/world';
import {generateCity} from '../src/city/generator';
import {CITY_GRID} from '../src/city/cityGrid';

it('disembarks a real family into native housing/jobs using one Population and resumes the placed train', () => {
  const source = generateCity('689856');
  const home = source.buildings.find(building => building.plot)!;
  const job = source.buildings.find(
    building => building.district === 'industrial',
  )!;
  const railway = {
    id: 'railway',
    center: {x: -34, z: -136},
    yaw: 0,
    stationPlaceId: 'station',
  };
  const roads = CITY_GRID.roads.flatMap((position, index) => [
    {
      id: `row-${index}`,
      points: [
        {x: CITY_GRID.roads[0]!, z: position},
        {x: CITY_GRID.roads.at(-1)!, z: position},
      ],
    },
    {
      id: `column-${index}`,
      points: [
        {x: position, z: CITY_GRID.roads[0]!},
        {x: position, z: CITY_GRID.roads.at(-1)!},
      ],
    },
  ]);
  const definition = createAuthoredDefinition({
    seed: source.seed,
    roads: [...roads, ...nativeRailwayAccessRoads(railway)],
    placements: [
      {
        id: 'home',
        municipalityId: 'town',
        template: home,
        sourceBlock: source.blocks.find(block => block.id === home.blockId)!,
        center: home,
        yaw: 0,
        kind: 'home',
      },
      {
        id: 'job',
        municipalityId: 'town',
        template: job,
        sourceBlock: source.blocks.find(block => block.id === job.blockId)!,
        center: job,
        yaw: 0,
        kind: 'factory',
      },
    ],
    infrastructure: {ports: [], railways: [railway]},
    economy: {automaticOrders: false},
  });
  const world = CityLife.fromDefinition(definition);
  const population = world.population;

  world.economy!.fundBusiness('job', {kind: 'treasury'}, 20000);
  world.advance(45);
  expect(world.population).toBe(population);
  expect(world.population.families).toHaveLength(1);
  expect(
    world.population.people.some(person => person.job?.building === 'job'),
  ).toBe(true);
  const saved: unknown = JSON.parse(JSON.stringify(world.save()));
  const resumed = CityLife.fromSave(saved);

  world.advance(180);
  resumed.advance(180);
  expect(world.population.families[0]!.arrived).toBe(true);
  expect(
    world.population.people.some(person =>
      person.history.some(event => event.text.includes('Вышел из поезда')),
    ),
  ).toBe(true);
  expect(resumed.save()).toEqual(world.save());
});

it('runs a placed original railway in the same world without phantom families when housing is absent', () => {
  const railway = {
    id: 'railway',
    center: {x: 500, z: 300},
    yaw: 0.45,
    stationPlaceId: 'station',
  };
  const definition = createAuthoredDefinition({
    seed: '689856',
    roads: nativeRailwayAccessRoads(railway),
    infrastructure: {ports: [], railways: [railway]},
  });
  const world = CityLife.fromDefinition(definition);

  expect(world.population.place('station').kind).toBe('station');
  expect(world.population.place('station').building).toBeUndefined();
  world.advance(20);
  expect(world.frame().railways?.[0]?.snapshot.train.phase).not.toBe('away');
  expect(world.population.people).toEqual([]);
  expect(world.traffic.save().vehicles).toEqual([]);
  const saved: unknown = JSON.parse(JSON.stringify(world.save()));
  const resumed = CityLife.fromSave(saved);

  world.advance(30);
  resumed.advance(30);
  expect(resumed.save()).toEqual(world.save());
  expect(resumed.frame().railways).toEqual(world.frame().railways);
});
