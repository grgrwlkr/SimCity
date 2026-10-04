import {describe, expect, it} from 'vitest';
import {
  inspectLegacyRegionMigration,
  migrateLegacyRegionSave,
  LegacyMigrationError,
} from '../src/game/saveMigration';
import {parseRegion, serializeRegion} from '../src/region/model/save';
import type {Parcel} from '../src/region/model/types';
import {flatFixture} from './helpers/regionFixture';
import {generateCity} from '../src/city/generator';
import {createAuthoredDefinition} from '../src/city/life/definition';
import {CityLife} from '../src/city/life/world';
import {CityTraffic} from '../src/city/trafficFlow';
import {
  AUTHORIZED_LEGACY_REPLAN_ID,
  replanAuthorizedLegacyLayout,
} from '../src/game/legacyLayout';
import {
  convexInteriorsOverlap,
  isDryFootprint,
  rectangle,
} from '../src/region/model/geometry';

describe('legacy native migration preflight', () => {
  it('reports the original region, its clocks and balances without mutating input', () => {
    const state = flatFixture();

    state.life.elapsedSeconds = 604_800;
    state.life.remainderSeconds = 0.25;
    const input = serializeRegion(state);
    const before = parseRegion(input);
    const report = inspectLegacyRegionMigration(input);

    expect(report.status).toBe('eligible');
    expect(report.regionId).toBe('test-region');
    expect(report.calendar).toEqual({
      startingMinute: 360,
      secondsPerMinute: 60,
      elapsedSeconds: 604_800,
      remainderSeconds: 0.25,
      day: 7,
      minute: 360,
    });
    expect(report.balances).toEqual({
      treasury: state.cash,
      families: 0,
      investors: 0,
      businesses: 0,
      moneyInAccounts: state.cash,
      externalMoney: 0,
      conservedMoney: state.cash,
      goodsInAccountsAndCargo: 0,
      conservedGoods: 0,
    });
    expect(report.issues).toEqual([]);
    expect(parseRegion(input)).toEqual(before);
  });

  it('requires native authored geometry even when a valid old region has no inhabitants', () => {
    const report = inspectLegacyRegionMigration(serializeRegion(flatFixture()));

    expect(report.status).toBe('eligible');
    expect(report.requiresAuthoredDefinition).toBe(true);
    expect(report.identities).toEqual({families: [], people: [], cars: []});
  });

  it('retains a raw malformed source in an explicit migration error', () => {
    const raw = '{broken';

    expect(() => inspectLegacyRegionMigration(raw)).toThrow(
      /сохранение региона/i,
    );
  });
});

function settledFixture() {
  const state = flatFixture();
  const life = state.life;

  life.initialized = true;
  life.elapsedSeconds = 604_800;
  life.nextId = 3;
  life.families = [
    {
      id: 'family-1',
      memberIds: ['resident-1'],
      cash: 678,
      homeId: 'building-1',
      status: 'settled',
      availableAt: 0,
      carId: null,
      goods: 2,
      lastShopDay: 6,
      reason: null,
      finance: {
        sinceSeconds: 0,
        construction: 32_000,
        goods: 70,
        travel: 12,
        wages: 957,
      },
    },
  ];
  life.people = [
    {
      id: 'resident-1',
      familyId: 'family-1',
      name: 'Ирина',
      age: 34,
      qualification: 1,
      jobId: 'building-2',
      placeId: 'building-1',
      tripId: null,
      activity: 'home',
      reason: null,
      workedSeconds: 144_000,
      wageSeconds: 300,
    },
  ];
  life.investors = [{id: 'investor-1', cash: 1000}];
  const home = {
    id: 'building-1',
    lotId: 'parcel-3',
    settlementId: 'settlement-1',
    kind: 'residential' as const,
    ownerId: 'family-1',
    stage: 'ready' as const,
    startedAt: 0,
    progressSeconds: 100,
    durationSeconds: 100,
    capacity: 4,
    jobs: 0,
    qualification: 0,
    parking: 1,
    inventory: 0,
    inventoryCapacity: 0,
    cash: 0,
    productionWork: 0,
  };

  life.buildings = [
    home,
    {
      ...home,
      id: 'building-2',
      lotId: 'parcel-4',
      kind: 'industrial',
      ownerId: 'investor-1',
      capacity: 0,
      jobs: 4,
      parking: 0,
      inventory: 7,
      inventoryCapacity: 50,
      cash: 123,
      productionWork: 3960,
    },
  ];
  life.economy = {
    ...life.economy,
    initialMoney: 2000,
    initialGoods: 22,
    externalMoney: 99,
    externalGoods: 15,
    consumed: 3,
    produced: 5,
  };

  return {
    ...state,
    cash: 100,
    nextId: 5,
    life,
    settlements: [{id: 'settlement-1', name: 'Север', center: {x: 0, z: 300}}],
    roads: [
      {
        id: 'road-2',
        points: [
          {x: -100, z: 0},
          {x: 100, z: 0},
        ],
      },
    ],
    parcels: [
      {
        id: 'parcel-3',
        settlementId: 'settlement-1',
        center: {x: 0, z: 20},
        heading: 0,
        width: 32,
        depth: 32,
        zone: 'residential' as const,
        access: null,
      },
      {
        id: 'parcel-4',
        settlementId: 'settlement-1',
        center: {x: 50, z: 20},
        heading: 0,
        width: 32,
        depth: 32,
        zone: 'industrial' as const,
        access: null,
      },
    ],
  };
}

function definitionFixture() {
  const source = generateCity('fixture');
  const home = source.buildings.find(b => b.plot)!;
  const factory = source.buildings.find(b => b.district === 'industrial')!;

  return createAuthoredDefinition({
    seed: 'fixture',
    roads: settledFixture().roads,
    placements: [
      {
        id: 'building-1',
        municipalityId: 'settlement-1',
        template: home,
        center: {x: 0, z: 20},
        yaw: 0,
        kind: 'home',
        capacity: 1,
      },
      {
        id: 'building-2',
        municipalityId: 'settlement-1',
        template: factory,
        center: {x: 50, z: 20},
        yaw: 0,
        kind: 'factory',
        capacity: 4,
      },
    ],
  });
}

describe('settled legacy import into one native authored world', () => {
  it('keeps pending real cargo unsupported without converting it to shop stock', () => {
    const state = settledFixture();

    state.life.nextId = 5;
    state.life.deliveries = [
      {
        id: 'delivery-4',
        sourceId: null,
        targetId: 'building-2',
        quantity: 16,
        cargo: 0,
        state: 'waiting',
        tripId: null,
        phaseSeconds: 0,
        unitPrice: 20,
        reason: null,
      },
    ];
    const raw = serializeRegion(state);
    const report = inspectLegacyRegionMigration(raw);

    expect(report.status).toBe('unsupported');
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: 'delivery-operation',
        ids: ['delivery-4'],
      }),
    );
    expect(() => migrateLegacyRegionSave(raw, definitionFixture())).toThrow(
      /активные операции/,
    );
    expect(parseRegion(raw).life.buildings[1]!.inventory).toBe(7);
    expect(raw).toBe(serializeRegion(state));
  });

  it('replans only the authorized world with complete dry nonoverlapping source buildings', () => {
    const state = {...settledFixture(), id: AUTHORIZED_LEGACY_REPLAN_ID};
    const raw = serializeRegion(state);
    const definition = replanAuthorizedLegacyLayout(raw);
    const blocks = definition.placements.map(placement =>
      rectangle(
        placement.center,
        placement.template.width,
        placement.template.depth,
      ),
    );

    expect(definition.placements.map(p => p.id)).toEqual([
      'building-1',
      'building-2',
    ]);
    expect(blocks.every(block => isDryFootprint(state.terrain, block))).toBe(
      true,
    );
    expect(
      blocks.every((block, index) =>
        blocks
          .slice(index + 1)
          .every(other => !convexInteriorsOverlap(block, other)),
      ),
    ).toBe(true);
    expect(
      definition.layout.buildings.every(b => {
        const original = definition.placements.find(
          p => p.id === b.id,
        )!.template;

        return (
          b.width === original.width &&
          b.depth === original.depth &&
          b.height === original.height &&
          b.kit === original.kit
        );
      }),
    ).toBe(true);
    const imported = migrateLegacyRegionSave(raw, definition, {
      allowReplanForId: AUTHORIZED_LEGACY_REPLAN_ID,
    });

    expect(imported.world.population.people).toHaveLength(1);
    expect(() =>
      replanAuthorizedLegacyLayout(serializeRegion(settledFixture())),
    ).toThrow(/тестового сохранения/);
    expect(() =>
      migrateLegacyRegionSave(serializeRegion(settledFixture()), definition, {
        allowReplanForId: AUTHORIZED_LEGACY_REPLAN_ID,
      }),
    ).toThrow(/не разрешена/);
    expect(serializeRegion(state)).toBe(raw);
  });

  it('selects diverse complete prototype assemblies by stable legacy IDs without changing native parking roles', () => {
    const parcels: Parcel[] = [];
    const state = {
      ...settledFixture(),
      id: AUTHORIZED_LEGACY_REPLAN_ID,
      seed: '689856',
      parcels,
    };

    state.terrain = {...state.terrain, seed: state.seed, water: []};
    const home = state.life.buildings[0]!;
    const factory = state.life.buildings[1]!;

    state.life.buildings = [
      ...Array.from({length: 63}, (_, i) => ({
        ...home,
        id: i === 0 ? home.id : `home-${i + 10}`,
      })),
      ...Array.from({length: 24}, (_, i) => ({
        ...factory,
        id: i === 0 ? factory.id : `factory-${i + 10}`,
      })),
      ...Array.from({length: 24}, (_, i) => ({
        ...factory,
        kind: 'commercial' as const,
        id: `shop-${i + 10}`,
      })),
      ...Array.from({length: 24}, (_, i) => ({
        ...factory,
        kind: 'warehouse' as const,
        ownerId: 'region',
        cash: 0,
        id: `warehouse-${i + 10}`,
      })),
    ];
    state.nextId = 5000;
    state.life.nextId = 5000;
    state.life.buildings = state.life.buildings.map((building, i) => ({
      ...building,
      lotId: `lot-${i + 100}`,
    }));
    state.parcels = state.life.buildings.flatMap((building, i) =>
      building.kind === 'warehouse'
        ? []
        : [
            {
              id: building.lotId,
              settlementId: building.settlementId,
              center: {
                x: -1000 + (i % 12) * 40,
                z: -600 + Math.floor(i / 12) * 40,
              },
              heading: 0,
              width: 32,
              depth: 32,
              zone: building.kind,
              access: null,
            },
          ],
    );
    state.warehouses = state.life.buildings.flatMap((building, i) =>
      building.kind === 'warehouse'
        ? [
            {
              id: building.lotId,
              settlementId: building.settlementId,
              center: {
                x: -1000 + (i % 12) * 40,
                z: -600 + Math.floor(i / 12) * 40,
              },
              heading: 0,
              access: null,
            },
          ]
        : [],
    );
    const raw = serializeRegion(state);
    const result = replanAuthorizedLegacyLayout(raw);
    const homes = result.placements.filter(p => p.kind === 'home');
    const shops = result.placements.filter(p => p.id.startsWith('shop-'));
    const factories = result.placements.filter(
      p => p.id === factory.id || p.id.startsWith('factory-'),
    );
    const warehouses = result.placements.filter(p =>
      p.id.startsWith('warehouse-'),
    );

    expect(new Set(homes.map(p => p.template.variant))).toEqual(
      new Set(['slab', 'gable', 'terrace']),
    );
    expect(
      new Set(homes.map(p => JSON.stringify(p.template.kit))).size,
    ).toBeGreaterThan(6);
    expect(new Set(shops.map(p => p.template.variant))).toEqual(
      new Set(['store', 'mall', 'terrace']),
    );
    expect(new Set(factories.map(p => p.template.variant))).toEqual(
      new Set(['sawtooth', 'tanks', 'power']),
    );
    expect(warehouses.every(p => p.template.variant === 'warehouse')).toBe(
      true,
    );
    expect(new Set(warehouses.map(p => p.template.id)).size).toBeGreaterThan(1);
    const source = generateCity(state.seed);

    for (const placement of result.placements) {
      expect(placement.template).toEqual(
        source.buildings.find(b => b.id === placement.template.id),
      );
      expect(placement.sourceBlock).toEqual(
        source.blocks.find(b => b.id === placement.template.blockId),
      );
    }

    for (const placement of [...homes, ...shops]) {
      expect(placement.template.plot).toBeUndefined();
      expect(
        result.profile.facilities.some(
          f => f.buildingId === placement.id && f.kind === 'underground',
        ),
      ).toBe(true);
    }

    const reordered = replanAuthorizedLegacyLayout(
      serializeRegion({
        ...state,
        life: {
          ...state.life,
          buildings: state.life.buildings
            .filter(building =>
              [home.id, factory.id, 'warehouse-10'].includes(building.id),
            )
            .reverse(),
        },
      }),
    );
    const choices = (definition: typeof result) =>
      Object.fromEntries(definition.placements.map(p => [p.id, p.template.id]));

    for (const [id, template] of Object.entries(choices(reordered))) {
      expect(template).toBe(choices(result)[id]);
    }

    expect(serializeRegion(state)).toBe(raw);
  }, 60_000);

  it('maps the real parked car without copying dormant traffic actor slots', () => {
    const state = settledFixture();
    const traffic = new CityTraffic([], {roads: []});

    traffic.addCar({length: 4.2, width: 1.8});
    traffic.addCar({length: 6, width: 2});
    state.life.traffic = traffic.save();
    state.life.nextId = 4;
    state.life.families[0]!.carId = 'car-3';
    state.life.cars = [
      {
        id: 'car-3',
        familyId: 'family-1',
        driverId: null,
        parkedAt: 'building-1',
        parkingSlot: 0,
        tripId: null,
        trafficIndex: 0,
      },
    ];
    const imported = migrateLegacyRegionSave(
      serializeRegion(state),
      definitionFixture(),
    );
    const loaded = CityLife.fromSave(imported.world, imported.definition);
    const car = loaded.population.cars[0]!;

    expect(loaded.population.families[0]!.cars).toEqual([0]);
    expect(car).toMatchObject({owner: 0, driver: null, status: 'parked'});
    expect(loaded.parking.slots[car.slot!]!.occupant).toBe(0);
    expect(
      loaded.profile.facilities[loaded.parking.slots[car.slot!]!.facility]!
        .buildingId,
    ).toBe('building-1');
    expect(loaded.traffic.save().vehicles).toHaveLength(1);
    expect(imported.report.identities.cars).toEqual([
      {externalId: 'car-3', nativeId: 0},
    ]);
    expect(imported.definition.metadata?.['legacyMigration']).toMatchObject({
      originalTraffic: {vehicles: [{id: 0}, {id: 1}]},
    });
    loaded.advance(0.05);
    expect(loaded.traffic.save().vehicles).toHaveLength(1);
  });

  it('preserves addresses, accounts, stock and calendar through native restore', () => {
    const state = settledFixture();
    const raw = serializeRegion(state);
    const before = parseRegion(raw);
    const imported = migrateLegacyRegionSave(raw, definitionFixture());
    const loaded = CityLife.fromSave(imported.world, imported.definition);

    expect(loaded.frame().population).toBe(1);
    expect(loaded.frame().minute).toBe(360);
    expect(loaded.frame().day).toBe(8);
    expect(loaded.population.families[0]!.balance).toBe(678);
    expect(loaded.population.families[0]!.food).toBe(2);
    expect(loaded.population.home(loaded.population.families[0]!).id).toBe(
      'building-1',
    );
    expect(
      loaded.population.units[loaded.population.families[0]!.home]!.owner,
    ).toBe(0);
    expect(loaded.population.people[0]!.job?.building).toBe('building-2');
    expect(loaded.population.age(loaded.population.people[0]!, 7)).toBe(34);
    expect(loaded.population.treasury).toBe(100);
    expect(
      loaded.population.businesses.find(b => b.building === 'building-2'),
    ).toMatchObject({balance: 123, stock: 7, workers: [0]});
    expect(imported.report.balances.conservedMoney).toBe(2000);
    expect(imported.report.balances.conservedGoods).toBe(22);
    expect(imported.definition.metadata?.['legacyMigration']).toMatchObject({
      investors: [{id: 'investor-1', cash: 1000}],
      identities: {
        families: [{externalId: 'family-1', nativeId: 0}],
        people: [{externalId: 'resident-1', nativeId: 0}],
      },
    });
    expect(parseRegion(raw)).toEqual(before);
    expect(raw).toBe(serializeRegion(state));
    expect(
      CityLife.fromSave(
        JSON.parse(JSON.stringify(imported.world)),
        imported.definition,
      ).save(),
    ).toEqual(loaded.save());
  });

  it('rejects unsupported construction and retains the exact original source', () => {
    const state = settledFixture();

    state.life.buildings[1]!.stage = 'constructing';
    state.life.buildings[1]!.progressSeconds = 50;
    state.life.people[0]!.jobId = null;
    const raw = serializeRegion(state);

    try {
      migrateLegacyRegionSave(raw, definitionFixture());
      expect.fail('Construction must not become a completed native building');
    } catch (error) {
      expect(error).toBeInstanceOf(LegacyMigrationError);

      if (error instanceof LegacyMigrationError) {
        expect(error.original).toBe(raw);
        expect(error.report?.issues).toContainEqual(
          expect.objectContaining({code: 'construction', ids: ['building-2']}),
        );
      }
    }
  });
});
