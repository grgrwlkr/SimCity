import {describe, expect, it} from 'vitest';
import {generateCity} from '../src/city/generator';
import {CityLife} from '../src/city/life/world';
import {RegionRouting} from '../src/city/life/regionRouting';
import {
  nativePortRoads,
  nativeRailwayAccessRoads,
} from '../src/city/life/nativeInfrastructure';
import {compileNativeRegion} from '../src/game/compileRegion';
import {AUTHORIZED_LEGACY_REPLAN_ID} from '../src/game/legacyLayout';
import {
  createNativeRegionDocument,
  readNativeRegionDocument,
} from '../src/game/regionDocument';
import {repairLegacyHallRoads} from '../src/game/repairLegacyHallRoads';
import {createGameSave} from '../src/game/save';
import {townHallRoadPoints} from '../src/region/model/townHall';

function importedFixture() {
  const document = createNativeRegionDocument('imported', '689856');
  const source = generateCity(document.seed);
  const block = source.blocks.find(
    block =>
      block.district === 'residential' &&
      source.buildings.some(
        building => building.blockId === block.id && !building.plot,
      ),
  )!;
  const towns = [-1350, -500].map((x, index) => ({
    id: `settlement-${index * 2 + 1}`,
    name: `Town ${index + 1}`,
    center: {x, z: 0},
    townHall: {roadId: `road-${index * 2 + 2}`, heading: 0, level: 1},
  }));
  const port = {
    id: 'actual-port',
    center: {x: 900, z: 1000},
    yaw: 0,
    warehouseBuildingIds: ['warehouse-0', 'warehouse-1'],
  };
  const railway = {
    id: 'actual-railway',
    center: {x: -1000, z: -1000},
    yaw: 0,
    stationPlaceId: 'actual-station',
  };
  const doc = {
    ...document,
    settlements: towns,
    roads: [
      ...towns.map(town => ({
        id: `grid-${town.id}`,
        points: [
          {x: town.center.x - 102, z: 68},
          {x: town.center.x, z: 68},
          {x: town.center.x + 102, z: 68},
        ],
      })),
      ...towns.map(town => ({
        id: `rear-${town.id}`,
        points: [
          {x: town.center.x - 102, z: 102},
          {x: town.center.x + 102, z: 102},
        ],
      })),
      ...towns.flatMap(town =>
        [-17, 17].map(side => ({
          id: `side-${town.id}-${side}`,
          points: [
            {x: town.center.x + side, z: 68},
            {x: town.center.x + side, z: 102},
          ],
        })),
      ),
      ...nativePortRoads(port),
      ...nativeRailwayAccessRoads(railway),
    ],
    blocks: towns.map(town => ({
      id: `block-${town.id}`,
      municipalityId: town.id,
      sourceSeed: source.seed,
      sourceBlock: block,
      templates: source.buildings.filter(
        building => building.blockId === block.id,
      ),
      center: {x: town.center.x, z: 85},
      yaw: 0,
      startedAt: 0,
      duration: 0,
    })),
    infrastructure: {ports: [port], railways: [railway]},
  };
  const definition = compileNativeRegion(doc, 0);
  const world = CityLife.fromDefinition(
    {
      ...definition,
      economy: {externalGoods: 1000, automaticOrders: false},
      metadata: {
        ...definition.metadata,
        legacyReplan: {
          authorizedId: AUTHORIZED_LEGACY_REPLAN_ID,
          originalRoads: towns.map(town => ({
            id: town.townHall.roadId,
            points: townHallRoadPoints(town.center),
          })),
        },
        legacyMigration: {
          document: {id: AUTHORIZED_LEGACY_REPLAN_ID, settlements: towns},
        },
      },
    },
    {initialFamilies: 2},
  );

  world.advance(10);

  return createGameSave('imported', 'Imported native city', world.save());
}

describe('authorized imported hall road repair', () => {
  it('keeps saved legacy hiring capacity instead of recalculating it during a road-only import', () => {
    const input = importedFixture();

    if (input.world.version !== 3) {
      throw new Error('Expected authored world');
    }

    input.world.population.businesses[0]!.jobs += 1;
    const original = JSON.stringify(input.world.population);
    const result = repairLegacyHallRoads(input);

    expect(JSON.stringify(result.world.population)).toBe(original);
  });

  it('restores real founding streets and links without advancing native residents, parking, cargo or trains', () => {
    const input = importedFixture();
    const before = JSON.stringify(input);
    const result = repairLegacyHallRoads(input);

    if (input.world.version !== 3 || result.world.version !== 3) {
      throw new Error('Expected authored native saves');
    }

    expect(result.world.definition.roads.map(road => road.id)).toContain(
      'road-2',
    );
    expect(result.world.definition.roads.map(road => road.id)).toContain(
      'road-4',
    );
    expect(result.world.definition.roads).toHaveLength(
      input.world.definition.roads.length + 4,
    );
    expect(
      readNativeRegionDocument(
        result.world.definition.metadata?.['regionDocument'],
      )!.roads,
    ).toEqual(result.world.definition.roads);
    const routing = new RegionRouting(
      result.world.definition.layout,
      result.world.definition.roads,
    );

    for (const x of [-1350, -500]) {
      expect(routing.isOnRoad({x, z: 48})).toBe(true);
      expect(routing.isOnRoad({x, z: 58})).toBe(true);
      expect(
        routing.walk(
          routing.access({x, z: 48}, []),
          routing.access({x: x + 17, z: 68}, []),
        ).length,
      ).toBeGreaterThan(1);
    }

    expect(input.world.population.people.length).toBeGreaterThan(0);
    expect(input.world.parking.some(slot => slot.occupant !== null)).toBe(true);
    expect(input.world.ports[0]!.harbor.cargo.length).toBeGreaterThan(0);
    expect(input.world.railways[0]!.railway.train.phase).toBe('arriving');
    expect(result.world.population).toEqual(input.world.population);
    expect(result.world.parking).toEqual(input.world.parking);
    expect(result.world.ports).toEqual(input.world.ports);
    expect(result.world.railways).toEqual(input.world.railways);
    expect(result.world.tick).toBe(input.world.tick);
    expect(result.world.requested).toBe(input.world.requested);
    expect(result.world.traffic.tick).toBe(input.world.traffic.tick);
    expect(result.world.traffic.lastTime).toBe(input.world.traffic.lastTime);
    expect(result.world.economy).toEqual(input.world.economy);
    expect(result.world.vehicleIds).toEqual(input.world.vehicleIds);
    expect(result.world.bus).toEqual(input.world.bus);
    expect(result.world.railArrival).toEqual(input.world.railArrival);
    expect(result.id).toBe(input.id);
    expect(JSON.stringify(input)).toBe(before);
    const restored = CityLife.fromSave(result.world);
    const original = CityLife.fromSave(input.world);

    expect(restored.economy!.moneyBalance()).toBe(
      original.economy!.moneyBalance(),
    );
    expect(restored.economy!.goodsBalance()).toBe(
      original.economy!.goodsBalance(),
    );
    expect(repairLegacyHallRoads(result)).toBe(result);
    expect(JSON.stringify(repairLegacyHallRoads(result))).toBe(
      JSON.stringify(result),
    );
  });

  it('does not repair ordinary manual worlds or a correct already founded town', () => {
    const input = importedFixture();

    if (input.world.version !== 3) {
      throw new Error('Expected native authored save');
    }

    const manual = {
      ...input,
      world: {
        ...input.world,
        definition: {...input.world.definition, metadata: {}},
      },
    };

    expect(repairLegacyHallRoads(manual)).toBe(manual);
    const mismatched = {
      ...input,
      world: {
        ...input.world,
        definition: {
          ...input.world.definition,
          metadata: {
            ...input.world.definition.metadata,
            legacyMigration: {document: {id: 'manual-region'}},
          },
        },
      },
    };

    expect(repairLegacyHallRoads(mismatched)).toBe(mismatched);
    const first = input.world.definition.roads[0]!;
    const roads = [
      ...input.world.definition.roads,
      {id: 'road-2', points: townHallRoadPoints({x: -1350, z: 0})},
      {id: 'road-4', points: townHallRoadPoints({x: -500, z: 0})},
    ];
    const document = readNativeRegionDocument(
      input.world.definition.metadata?.['regionDocument'],
    )!;
    const consistent = {
      ...input,
      world: {
        ...input.world,
        definition: {
          ...input.world.definition,
          roads,
          metadata: {
            ...input.world.definition.metadata,
            regionDocument: {...document, roads},
          },
        },
      },
    };

    expect(first.id).toContain('grid-');
    expect(repairLegacyHallRoads(consistent)).toBe(consistent);
  });

  it('rejects wet or overlapping parallel founding streets without mutating the saved world', () => {
    const input = importedFixture();

    if (input.world.version !== 3) {
      throw new Error('Expected authored world');
    }

    const document = readNativeRegionDocument(
      input.world.definition.metadata?.['regionDocument'],
    )!;
    const wetDocument = {
      ...document,
      terrain: {
        ...document.terrain,
        water: [
          ...document.terrain.water,
          [
            {x: -1420, z: 42},
            {x: -1280, z: 42},
            {x: -1280, z: 55},
            {x: -1420, z: 55},
          ],
        ],
      },
    };
    const wet = {
      ...input,
      world: {
        ...input.world,
        definition: {
          ...input.world.definition,
          metadata: {
            ...input.world.definition.metadata,
            regionDocument: wetDocument,
          },
        },
      },
    };
    const wetRaw = JSON.stringify(wet);

    expect(() => repairLegacyHallRoads(wet)).toThrow(
      'неподдерживаемая геометрия',
    );
    expect(JSON.stringify(wet)).toBe(wetRaw);
    const roads = [
      ...document.roads,
      {id: 'manual-frontage', points: townHallRoadPoints({x: -1350, z: 0})},
    ];
    const occupied = {
      ...input,
      world: {
        ...input.world,
        definition: {
          ...input.world.definition,
          roads,
          metadata: {
            ...input.world.definition.metadata,
            regionDocument: {...document, roads},
          },
        },
      },
    };
    const occupiedRaw = JSON.stringify(occupied);

    expect(() => repairLegacyHallRoads(occupied)).toThrow(
      'неподдерживаемая геометрия',
    );
    expect(JSON.stringify(occupied)).toBe(occupiedRaw);
  });

  it('reconstructs the authorized legacy editor document when only the native definition was saved', () => {
    const input = importedFixture();

    if (input.world.version !== 3) {
      throw new Error('Expected authored world');
    }

    const metadata = {...input.world.definition.metadata};

    delete metadata['regionDocument'];
    const fallback = {
      ...input,
      world: {
        ...input.world,
        definition: {...input.world.definition, metadata},
      },
    };
    const result = repairLegacyHallRoads(fallback);

    if (result.world.version !== 3) {
      throw new Error('Expected authored world');
    }

    expect(result.world.definition.roads).toHaveLength(
      input.world.definition.roads.length + 4,
    );
    expect(result.world.population).toEqual(input.world.population);
    expect(result.world.parking).toEqual(input.world.parking);
    expect(result.world.ports).toEqual(input.world.ports);
    expect(result.world.railways).toEqual(input.world.railways);
  });
});
