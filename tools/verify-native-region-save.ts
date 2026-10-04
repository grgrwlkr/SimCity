import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseGameSave} from '../packages/app/src/game/save';
import {CityLife} from '../packages/app/src/city/life/world';
import {parseRegion} from '../packages/app/src/region/model/save';
import type {RegionState} from '../packages/app/src/region/model/types';
import {generateTerrain} from '../packages/app/src/region/model/terrain';
import {readNativeRegionDocument} from '../packages/app/src/game/regionDocument';
import {
  convexInteriorsOverlap,
  isDryFootprint,
  rectangle,
} from '../packages/app/src/region/model/geometry';
import {z} from 'zod';
import {
  gameDay,
  gameMinute,
} from '../packages/app/src/region/model/life/legacyMetrics';

const legacyMetadata = z.object({
  identities: z.object({
    families: z.array(
      z.object({
        externalId: z.string(),
        nativeId: z.number().int().nonnegative(),
      }),
    ),
    people: z.array(
      z.object({
        externalId: z.string(),
        nativeId: z.number().int().nonnegative(),
      }),
    ),
    cars: z.array(
      z.object({
        externalId: z.string(),
        nativeId: z.number().int().nonnegative(),
      }),
    ),
  }),
  investors: z.array(z.object({id: z.string(), cash: z.number().finite()})),
  ledger: z.object({
    externalMoney: z.number().finite(),
    externalGoods: z.number().finite(),
    consumed: z.number().finite(),
    produced: z.number().finite(),
  }),
});

/** Observable evidence only; this verifier never writes or replaces a world save. */
export function verifyNativeRegionSave(value: unknown, original?: RegionState) {
  const game = parseGameSave(value);
  const world = CityLife.fromSave(game.world);
  const definition = world.definition;

  if (definition.kind !== 'authored') {
    throw new Error('Verification requires an authored native region');
  }

  const document = readNativeRegionDocument(
    definition.metadata?.['regionDocument'],
  );
  const terrain =
    document?.terrain ?? original?.terrain ?? generateTerrain(game.seed, 4000);
  const footprints = definition.layout.blocks.map(block => {
    const place = definition.profile.places.find(
      place => place.blockId === block.id,
    );
    const placement = definition.placements.find(
      placement => placement.id === place?.id,
    );

    return rectangle(block, 26, 26, placement?.yaw ?? 0);
  });
  const dry = footprints.every(footprint => isDryFootprint(terrain, footprint));
  const overlaps = footprints.some((footprint, index) =>
    footprints
      .slice(index + 1)
      .some(other => convexInteriorsOverlap(footprint, other)),
  );
  const occupied = world.parking.slots.filter(
    slot => slot.occupant !== null && slot.occupant >= 0,
  );
  const parking = world.population.cars.every(
    car =>
      car.slot === null || world.parking.slots[car.slot]?.occupant === car.id,
  );
  const identitiesUnique =
    new Set(world.population.people.map(person => person.id)).size ===
      world.population.people.length &&
    world.population.people.every((person, index) => person.id === index) &&
    world.population.families.every((family, index) => family.id === index) &&
    world.population.cars.every((car, index) => car.id === index);
  const metadata = legacyMetadata.safeParse(
    definition.metadata?.['legacyMigration'],
  );
  const balances = {
    treasury: world.population.treasury,
    families: world.population.families.reduce(
      (sum, family) => sum + family.balance,
      0,
    ),
    businesses: world.population.businesses.reduce(
      (sum, business) => sum + business.balance,
      0,
    ),
    investors: world.economy
      ? world.economy.investors.reduce(
          (sum, investor) => sum + investor.cash,
          0,
        )
      : metadata.success
        ? metadata.data.investors.reduce(
            (sum, investor) => sum + investor.cash,
            0,
          )
        : 0,
    foodAndStock:
      world.population.families.reduce((sum, family) => sum + family.food, 0) +
      world.population.businesses.reduce(
        (sum, business) => sum + business.stock,
        0,
      ),
  };
  const cash =
    world.economy?.moneyBalance() ??
    balances.treasury +
      balances.families +
      balances.businesses +
      balances.investors +
      (metadata.success ? metadata.data.ledger.externalMoney : 0);
  const goods =
    world.economy?.goodsBalance() ??
    balances.foodAndStock +
      (metadata.success
        ? metadata.data.ledger.externalGoods +
          metadata.data.ledger.consumed -
          metadata.data.ledger.produced
        : 0);
  let sourceMatches: boolean | null = original === undefined ? null : false;

  if (original && metadata.success) {
    const expectedCash =
      original.cash +
      original.life.economy.externalMoney +
      original.life.families.reduce((sum, family) => sum + family.cash, 0) +
      original.life.investors.reduce(
        (sum, investor) => sum + investor.cash,
        0,
      ) +
      original.life.buildings.reduce((sum, building) => sum + building.cash, 0);
    const expectedGoods =
      original.life.economy.externalGoods +
      original.life.economy.consumed -
      original.life.economy.produced +
      original.life.families.reduce((sum, family) => sum + family.goods, 0) +
      original.life.buildings.reduce(
        (sum, building) => sum + building.inventory,
        0,
      ) +
      original.life.deliveries.reduce(
        (sum, delivery) => sum + delivery.cargo,
        0,
      );

    const familyIds = new Map(
      metadata.data.identities.families.map(id => [id.externalId, id.nativeId]),
    );
    const mappedFamilies = metadata.data.identities.families.every(id => {
      const source = original.life.families.find(
        family => family.id === id.externalId,
      );
      const family = world.population.families[id.nativeId];
      const unit = family ? world.population.units[family.home] : undefined;

      return (
        source !== undefined &&
        family !== undefined &&
        family.balance === source.cash &&
        family.food === source.goods &&
        unit?.building === source.homeId
      );
    });
    const mappedCars = metadata.data.identities.cars.every(id => {
      const source = original.life.cars.find(car => car.id === id.externalId);
      const car = world.population.cars[id.nativeId];
      const slot =
        car?.slot === null || car?.slot === undefined
          ? undefined
          : world.parking.slots[car.slot];
      const facility = slot
        ? world.profile.facilities[slot.facility]
        : undefined;

      return (
        source !== undefined &&
        car !== undefined &&
        facility !== undefined &&
        slot !== undefined &&
        car.owner === familyIds.get(source.familyId) &&
        facility.buildingId === source.parkedAt &&
        facility.slots.indexOf(slot.id) === source.parkingSlot
      );
    });

    sourceMatches =
      cash === expectedCash &&
      goods === expectedGoods &&
      world.day === gameDay(original) &&
      world.minute === gameMinute(original) % 1440 &&
      metadata.data.identities.people.length === original.life.people.length &&
      metadata.data.identities.families.length ===
        original.life.families.length &&
      metadata.data.identities.cars.length === original.life.cars.length &&
      mappedFamilies &&
      mappedCars &&
      world.population.people.length === original.life.people.length &&
      world.population.families.length === original.life.families.length &&
      world.population.cars.length === original.life.cars.length &&
      metadata.data.identities.people.every(
        id =>
          world.population.people[id.nativeId]?.name ===
          original.life.people.find(person => person.id === id.externalId)
            ?.name,
      );
  }

  const continued = CityLife.fromSave(JSON.parse(JSON.stringify(world.save())));
  const calendar = {
    seconds: world.seconds,
    day: world.day,
    minute: world.minute,
  };
  const observed = {
    buildings: definition.layout.buildings.length,
    people: world.population.people.length,
    families: world.population.families.length,
    cars: world.population.cars.length,
    occupiedParking: occupied.length,
    finiteParking: world.parking.slots.length,
    trafficActors: world.traffic.save().vehicles.length,
  };

  world.advance(0.05);
  continued.advance(0.05);
  const continuation =
    JSON.stringify(world.save()) === JSON.stringify(continued.save());
  const passed =
    dry &&
    !overlaps &&
    parking &&
    identitiesUnique &&
    sourceMatches !== false &&
    continuation;

  return {
    passed,
    id: game.id,
    name: game.name,
    nativeVersion: game.world.version,
    ...observed,
    ...calendar,
    dry,
    overlaps,
    parking,
    identitiesUnique,
    sourceMatches,
    continuation,
    balances,
    conservedCash: cash,
    conservedGoods: goods,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const input = args[0];
  const legacy = args.find(arg => arg.startsWith('--legacy='))?.slice(9);
  const output = args.find(arg => arg.startsWith('--output='))?.slice(9);

  if (!input || input.startsWith('--')) {
    throw new Error(
      'Usage: bun tools/verify-native-region-save.ts GAME_SAVE [--legacy=ORIGINAL_REGION] [--output=REPORT]',
    );
  }
  if (
    output &&
    (resolve(output) === resolve(input) ||
      (legacy !== undefined && resolve(output) === resolve(legacy)))
  ) {
    throw new Error('The report must not overwrite either input save');
  }

  const raw = await readFile(input, 'utf8');
  const original = legacy
    ? parseRegion(await readFile(legacy, 'utf8'))
    : undefined;
  const report = verifyNativeRegionSave(raw, original);
  const text = JSON.stringify(report, null, 2);

  if (output) {
    await writeFile(output, text + '\n');
  }

  console.log(text);

  if (!report.passed) {
    process.exitCode = 1;
  }
}
