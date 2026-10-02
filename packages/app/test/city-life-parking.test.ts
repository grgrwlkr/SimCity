import { expect, it } from 'vitest';
import { generateCity } from '../src/city/generator';
import { createLifeProfile } from '../src/city/life/network';
import { ParkingBook } from '../src/city/life/parking';
import type { Household } from '../src/city/life/types';

it('distinguishes an empty private place from public availability and prevents double occupation', () => {
  const profile = createLifeProfile(generateCity('689856')),
    parking = new ParkingBook(profile);
  const home = profile.places.find((p) => p.building?.plot)!;
  const family = { id: 4 } as Household;
  const slot = parking.leaseHome(family, home)!;
  expect(parking.reserve(slot.facility, 7, 5, home.blockId)).toBeUndefined();
  expect(parking.reserve(slot.facility, 7, 4, home.blockId)?.id).toBe(slot.id);
  expect(parking.reserve(slot.facility, 8, 4, home.blockId)).toBeUndefined();
  expect(() => parking.park(slot.id, 8)).toThrow();
  parking.park(slot.id, 7);
  parking.leave(7);
  expect(slot.occupant).toBeNull();
  expect(slot.household).toBe(4);
  expect(parking.reserve(slot.facility, 8, 5, home.blockId)).toBeUndefined();
});

it('uses public curb spaces when an apartment has no underground parking', () => {
  const profile = createLifeProfile(generateCity('689856')),
    book = new ParkingBook(profile);
  const home = profile.places.find((p) => p.kind === 'home' && p.parking === null && Math.abs(p.door.z) > 88)!;
  expect(home).toBeDefined();
  const slot = book.leaseHome({ id: 500 } as Household, home)!;
  expect(profile.facilities[slot.facility]?.kind).toBe('street');
  expect(slot.household).toBeNull();
  book.reserve(slot.facility, 8, 500, home.blockId);
  book.park(slot.id, 8);
  book.leave(8);
  expect(book.reserve(slot.facility, 9, 501, home.blockId)?.id).toBe(slot.id);
});
