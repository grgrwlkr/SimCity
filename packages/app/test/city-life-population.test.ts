import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/city/generator';
import { createLifeProfile } from '../src/city/life/network';
import { ParkingBook } from '../src/city/life/parking';
import { Population } from '../src/city/life/population';

describe('families and personal economy', () => {
  it('creates persistent families and jobs reproducibly without overfilling homes or vacancies', () => {
    const profile = createLifeProfile(generateCity('689856'));
    const a = new Population(profile, new ParkingBook(profile), 180);
    const b = new Population(profile, new ParkingBook(profile), 180);
    expect(a.people).toHaveLength(540);
    expect(a.save()).toEqual(b.save());
    for (const family of a.families) {
      expect(family.balance).toBeGreaterThanOrEqual(0);
      expect(a.units[family.home]!.tenant).toBe(family.id);
      expect(family.members.length).toBeLessThanOrEqual(a.units[family.home]!.capacity);
      for (const id of family.members) {
        expect(a.people[id]!.family).toBe(family.id);
      }
    }
    for (const business of a.businesses) {
      expect(business.workers.length).toBeLessThanOrEqual(business.jobs);
    }
    expect(a.people.filter((p) => a.age(p, 0) < 18).every((p) => p.job === null)).toBe(true);
  });
  it('requires money and an available home place to buy a car, and charges the family', () => {
    const profile = createLifeProfile(generateCity('689856')),
      parking = new ParkingBook(profile);
    const pop = new Population(profile, parking, 1, false),
      family = pop.families[0]!;
    family.balance = 10;
    expect(pop.buyCar(family, 0, true)).toBeNull();
    family.balance = 800000;
    const before = family.balance,
      car = pop.buyCar(family, 0, true)!;
    expect(before - family.balance).toBe(car.price);
    expect(car.owner).toBe(family.id);
    expect(parking.slots[car.slot!]!.occupant).toBe(car.id);
    expect(pop.buyCar(family, 0, true)).toBeNull();
  });
  it('creates a child at home with real parents and keeps the family inside its housing capacity', () => {
    const profile = createLifeProfile(generateCity('689856'));
    const pop = new Population(profile, new ParkingBook(profile), 1, false),
      family = pop.families[0]!;
    family.babyDueDay = 1;
    pop.daily(1, 4320);
    const child = pop.people.at(-1)!;
    expect(child.parents).toEqual(family.members.slice(0, 2));
    expect(pop.age(child, 1)).toBe(0);
    expect(child.activity).toBe('home');
    expect(child.job).toBeNull();
    expect(family.members).toContain(child.id);
    expect(pop.born).toBe(1);
  });
});
