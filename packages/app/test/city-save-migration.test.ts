import {expect, it} from 'vitest';
import {CityLife} from '../src/city/life/world';

it('expands a legacy save without losing residents, property, active trips or port cargo', () => {
  const original = new CityLife('689856', 3, false);

  original.advance(35);
  const before = original.save();
  const legacy: Record<string, unknown> = {...before, version: 1};

  delete legacy['expanded'];
  delete legacy['railway'];
  delete legacy['railArrival'];
  const migrated = CityLife.fromSave(
    JSON.parse(JSON.stringify(legacy)) as unknown,
  );

  expect(migrated.profile.layout.blocks).toHaveLength(81);
  expect(migrated.seconds).toBe(original.seconds);
  const persons = (world: CityLife) =>
    world.population.people.map(p => ({
      ...p,
      trip: p.trip ? {...p.trip, facility: null} : null,
    }));

  expect(persons(migrated)).toEqual(persons(original));
  expect(migrated.population.families).toEqual(original.population.families);
  expect(migrated.harbor.save()).toEqual(original.harbor.save());
  expect(migrated.population.units.length).toBeGreaterThan(
    original.population.units.length,
  );

  for (const car of migrated.population.cars) {
    const prior = original.population.cars[car.id]!;

    expect(car.owner).toBe(prior.owner);
    const a = migrated.traffic.pose(117 + car.id);
    const b = original.traffic.pose(117 + car.id);

    expect(a.x).toBe(b.x);
    expect(a.z).toBe(b.z);

    if (car.slot !== null) {
      expect(migrated.parking.slots[car.slot]!.occupant).toBe(car.id);
      expect(
        migrated.profile.facilities[migrated.parking.slots[car.slot]!.facility]!
          .buildingId,
      ).toBe(
        original.profile.facilities[
          original.parking.slots[prior.slot!]!.facility
        ]!.buildingId,
      );
    }
  }

  migrated.advance(100);
  expect(migrated.errors).toEqual([]);
  const roundTrip = CityLife.fromSave(
    JSON.parse(JSON.stringify(migrated.save())) as unknown,
  );

  roundTrip.advance(5);
  migrated.advance(5);
  expect(roundTrip.save()).toEqual(migrated.save());
});
