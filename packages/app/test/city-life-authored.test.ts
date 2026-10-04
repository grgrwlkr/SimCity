import {describe, expect, it} from 'vitest';
import {generateCity} from '../src/city/generator';
import {
  createAuthoredDefinition,
  createPrototypeDefinition,
} from '../src/city/life/definition';
import type {AuthoredWorldDefinition} from '../src/city/life/definition';
import {RegionRouting} from '../src/city/life/regionRouting';
import {CityLife} from '../src/city/life/world';
import type {LifeProfile, Point} from '../src/city/life/types';

function connectedFixture(): AuthoredWorldDefinition {
  const seed = '689856';
  const source = generateCity(seed);
  const homeTemplate = source.buildings.find(building => building.plot)!;
  const workTemplate = source.buildings.find(
    building => building.district === 'downtown',
  )!;
  const roads = [
    {
      id: 'between-towns',
      points: [
        {x: 0, z: 0},
        {x: 300, z: 180},
      ],
    },
  ];
  const layout = {
    seed,
    blocks: [],
    buildings: [
      {...homeTemplate, id: 'north/home'},
      {...workTemplate, id: 'south/work'},
    ],
  };
  const routing = new RegionRouting(layout, roads);
  const at = (offset: number, side = 12): Point => ({
    x: offset * 300 - (side * 180) / Math.hypot(300, 180),
    z: offset * 180 + (side * 300) / Math.hypot(300, 180),
    y: 1.07,
  });
  const homeDoor = at(0.15);
  const workDoor = at(0.8);
  const profile: LifeProfile = {
    seed,
    layout,
    places: [],
    facilities: [],
    slots: [],
    bays: [],
    garageBuildings: {},
    arrival: null,
  };

  for (const [index, door] of [homeDoor, workDoor].entries()) {
    const id = index ? 'south/work' : 'north/home';
    const slotPoint = at(index ? 0.8 : 0.15, 10);
    const yaw = Math.atan2(300, 180);

    profile.places.push({
      id,
      name: id,
      municipalityId: index ? 'south' : 'north',
      kind: index ? 'office' : 'home',
      building: layout.buildings[index]!,
      blockId: id,
      door,
      access: routing.access(door, []),
      capacity: index ? 8 : 1,
      parking: index,
      price: 100000,
      wage: index ? 4500 : 0,
      education: 0,
      open: 0,
      close: 1440,
    });
    profile.facilities.push({
      id: index,
      key: `${id}/parking`,
      kind: index ? 'underground' : 'private',
      name: id,
      buildingId: id,
      blockId: id,
      entrance: slotPoint,
      yaw,
      road: routing.roadAccess(at(index ? 0.8 : 0.15, 2), 1),
      access: routing.access(slotPoint, []),
      residentsOnly: !index,
      fee: 0,
      slots: [index],
    });
    profile.slots.push({
      id: index,
      key: `${id}/slot`,
      facility: index,
      position: slotPoint,
      yaw,
      length: 4.3,
      width: 2.4,
      household: null,
      occupant: null,
      reserved: null,
    });
  }

  return createAuthoredDefinition({seed, roads, profile});
}

describe('one native authored world', () => {
  it('waits without creating a family when an authored bus has no legal return lane', () => {
    const definition = connectedFixture();
    const routing = new RegionRouting(definition.layout, definition.roads);
    const access = routing.roadAccess({x: 15, z: 9}, 1);
    const exit = routing.roadAccess({x: 15, z: 9}, -1);
    const world = CityLife.fromDefinition({
      ...definition,
      entries: [{id: 'entry', access, exit, terminalFacilityId: 1}],
      profile: {...definition.profile, arrival: access},
    });
    const money = world.economy!.moneyBalance();

    expect(() => world.advance(150)).not.toThrow();
    expect(world.population.families).toEqual([]);
    expect(world.population.people).toEqual([]);
    expect(world.traffic.save().vehicles).toHaveLength(1);
    expect(world.economy!.moneyBalance()).toBe(money);
    expect(
      CityLife.fromSave(
        JSON.parse(JSON.stringify(world.save())) as unknown,
      ).save(),
    ).toEqual(world.save());
  });

  it('preserves retired junction identity capacity after removing an unused crossing and saving', () => {
    const definition = connectedFixture();
    const world = CityLife.fromDefinition({
      ...definition,
      roads: [
        ...definition.roads,
        {
          id: 'crossing',
          points: [
            {x: 150, z: 30},
            {x: 150, z: 150},
          ],
        },
      ],
    });

    expect(world.traffic.save().owners).toHaveLength(1);
    world.applyDefinitionUpdate(definition);
    const saved = world.save();

    expect(saved.traffic.owners).toHaveLength(1);
    expect(
      CityLife.fromSave(JSON.parse(JSON.stringify(saved)) as unknown).save(),
    ).toEqual(saved);
  });

  it('registers a whole native plot only after physical construction completes', () => {
    const source = generateCity('689856');
    const template = source.buildings.find(
      building => building.plot?.front === 'south',
    )!;
    const sourceBlock = source.blocks.find(
      block => block.id === template.blockId,
    )!;
    const definition = createAuthoredDefinition({
      seed: source.seed,
      roads: [
        {
          id: 'frontage',
          points: [
            {x: sourceBlock.x - 17, z: sourceBlock.z + 17},
            {x: sourceBlock.x + 17, z: sourceBlock.z + 17},
          ],
        },
      ],
      placements: [
        {
          id: 'town/new-home',
          municipalityId: 'town',
          template,
          sourceBlock,
          center: template,
          yaw: 0,
          kind: 'home',
          startedAt: 0,
          readyAt: 2,
        },
      ],
    });
    const world = CityLife.fromDefinition(definition);
    const population = world.population;

    world.advance(1);
    expect(world.population.units).toEqual([]);
    expect(world.frame().construction?.['town/new-home']).toBe(0.5);
    const resumed = CityLife.fromSave(
      JSON.parse(JSON.stringify(world.save())) as unknown,
    );

    world.advance(1);
    resumed.advance(1);
    expect(world.population).toBe(population);
    expect(world.population.hasPlace('town/new-home')).toBe(true);
    expect(world.population.units).toHaveLength(1);
    expect(world.profile.layout.buildings[0]!.kit).toEqual(template.kit);
    expect(world.profile.layout.buildings[0]!.plot).toEqual(template.plot);
    expect(world.frame().construction?.['town/new-home']).toBe(1);
    expect(resumed.save()).toEqual(world.save());
  });

  it('restores a bus added after cars without changing native traffic identities', () => {
    const definition = connectedFixture();
    const world = CityLife.fromDefinition(definition, {initialFamilies: 1});
    const access = definition.profile.facilities[0]!.road;
    const exit = definition.profile.facilities[1]!.road;

    if (!('kind' in access) || !('kind' in exit)) {
      throw new Error('Expected authored access');
    }

    world.applyDefinitionUpdate({
      ...definition,
      entries: [{id: 'entry', access, exit, terminalFacilityId: 1}],
      profile: {...definition.profile, arrival: access},
    });
    const saved = world.save();

    expect(saved.version).toBe(3);

    if (saved.version !== 3) {
      throw new Error('Expected authored save');
    }

    expect(saved.vehicleIds).toEqual({cars: [0], bus: 1});
    const resumed = CityLife.fromSave(
      JSON.parse(JSON.stringify(saved)) as unknown,
    );

    expect(resumed.save()).toEqual(saved);
    expect(resumed.carVehicleId(0)).toBe(0);
  });

  it('advances a truly empty world without phantom roads, people, cargo or vehicles', () => {
    const world = CityLife.fromDefinition(
      createAuthoredDefinition({seed: 'empty'}),
    );

    world.advance(300);
    expect(world.population.people).toEqual([]);
    expect(world.profile.places).toEqual([]);
    expect(world.parking.slots).toEqual([]);
    expect(world.traffic.save().vehicles).toEqual([]);
    expect(world.traffic.save().owners).toEqual([]);
    expect(world.frame().freight).toEqual([]);
    expect(world.frame().harbor.cargo).toEqual([]);
    expect(world.frame().harbor.ship.visible).toBe(false);
    expect(world.frame().railway.crossings).toEqual([]);
    expect(world.inviteFamily()).toBe(false);
    expect(world.errors).toEqual([]);
  });

  it('drives between two cities on an arbitrary-angle road and continues the same trip after JSON save', () => {
    const definition = connectedFixture();
    const world = CityLife.fromDefinition(definition, {initialFamilies: 1});
    const person = world.population.people[0]!;
    const car = world.population.cars[0]!;

    world.startTrip(
      person,
      world.population.place('south/work'),
      'work',
      car.id,
    );

    for (let i = 0; i < 400 && car.status !== 'driving'; i++) {
      world.advance(0.1);
    }

    expect(car.status).toBe('driving');
    expect(world.traffic.save().vehicles).toHaveLength(1);
    const saved: unknown = JSON.parse(JSON.stringify(world.save()));
    const resumed = CityLife.fromSave(saved);

    world.advance(80);
    resumed.advance(80);
    expect(resumed.save()).toEqual(world.save());
    expect(world.population.people[0]!.location).toBe('south/work');
    expect(car.status).toBe('parked');
    expect(world.parking.slots[1]!.occupant).toBe(car.id);
  });

  it('keeps the same authoritative controllers and occupied state when appending roads and places', () => {
    const definition = connectedFixture();
    const world = CityLife.fromDefinition(definition, {initialFamilies: 1});
    const population = world.population;
    const parking = world.parking;
    const traffic = world.traffic;
    const saved = world.save();
    const next = {
      ...definition,
      roads: [
        ...definition.roads,
        {
          id: 'extension',
          points: [
            {x: 300, z: 180},
            {x: 450, z: 230},
          ],
        },
      ],
    };

    world.applyDefinitionUpdate(next, 200);
    expect(world.population).toBe(population);
    expect(world.parking).toBe(parking);
    expect(world.traffic).toBe(traffic);
    expect(world.population.families).toEqual(saved.population.families);
    expect(world.population.cars).toEqual(saved.population.cars);
    expect(world.parking.slots).toEqual(saved.parking);
    expect(world.population.treasury).toBe(saved.population.treasury - 200);
  });

  it('rejects occupied demolition and disconnected routes before changing family/car state', () => {
    const definition = connectedFixture();
    const world = CityLife.fromDefinition(definition, {initialFamilies: 1});
    const removed = createAuthoredDefinition({seed: definition.seed});
    const before = world.save();

    expect(() => world.applyDefinitionUpdate(removed)).toThrow(/занят/i);
    expect(world.save()).toEqual(before);
    const disconnected = {
      ...definition,
      roads: [
        {
          id: 'between-towns',
          points: [
            {x: 0, z: 0},
            {x: 70, z: 42},
          ],
        },
        {
          id: 'isolated',
          points: [
            {x: 210, z: 126},
            {x: 300, z: 180},
          ],
        },
      ],
    };
    const routing = new RegionRouting(disconnected.layout, disconnected.roads);
    const profile = structuredClone(disconnected.profile);

    for (const place of profile.places) {
      place.access = routing.access(place.door, []);
    }

    for (const facility of profile.facilities) {
      facility.road = routing.roadAccess(facility.road.point, 1);
      facility.access = routing.access(facility.entrance, []);
    }

    const unavailable = CityLife.fromDefinition(
      {...disconnected, profile},
      {initialFamilies: 1},
    );
    const person = unavailable.population.people[0]!;
    const cars = structuredClone(unavailable.population.cars);

    unavailable.startTrip(
      person,
      unavailable.population.place('south/work'),
      'work',
      0,
    );
    expect(person.trip).toBeNull();
    expect(unavailable.population.cars).toEqual(cars);
  });

  it('retains calendar and metadata and keeps original prototype snapshots untouched', () => {
    const authored = createAuthoredDefinition({
      seed: 'calendar',
      calendar: {startingMinute: 360, secondsPerMinute: 60},
      metadata: {investors: [{id: 'investor', cash: 1234}]},
    });
    const world = CityLife.fromDefinition(authored);

    world.advance(120);
    expect(world.minute).toBe(362);
    const resumed = CityLife.fromSave(
      JSON.parse(JSON.stringify(world.save())) as unknown,
    );

    expect(resumed.minute).toBe(362);
    expect(resumed.definition).toEqual(authored);
    const prototype = new CityLife('689856', 3);

    expect(
      CityLife.fromDefinition(createPrototypeDefinition('689856'), {
        initialFamilies: 3,
      }).save(),
    ).toEqual(prototype.save());
  });
});
