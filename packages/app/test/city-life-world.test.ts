import {describe, expect, it} from 'vitest';
import {CityLife} from '../src/city/life/world';

describe('observable city life', () => {
  it('keeps identical time, people and cars for different frame subdivisions', () => {
    const a = new CityLife('689856', 3);
    const b = new CityLife('689856', 3);

    a.advance(18);

    for (let i = 0; i < 180; i++) {
      b.advance(0.1);
    }

    expect(a.save()).toEqual(b.save());
  });
  it('continues the same people, car ownership and cargo after saving a moving world', () => {
    const a = new CityLife('689856', 3);

    a.advance(35);
    const data: unknown = JSON.parse(JSON.stringify(a.save()));
    const b = CityLife.fromSave(data);

    a.advance(18);
    b.advance(18);
    expect(b.save()).toEqual(a.save());
    expect(b.frame().people.map(p => p.id)).toEqual(
      a.frame().people.map(p => p.id),
    );
  });
  it('lets people make purposeful trips and keeps unique, legally occupied parking places', () => {
    const life = new CityLife('689856', 12);

    life.advance(300);
    expect(
      life.population.people.some(p =>
        p.history.some(e => e.text.includes('Прибыл')),
      ),
    ).toBe(true);
    const occupied = life.parking.slots
      .filter(s => s.occupant !== null)
      .map(s => s.occupant);

    expect(new Set(occupied).size).toBe(occupied.length);

    for (const car of life.population.cars) {
      if (car.slot !== null) {
        expect(life.parking.slots[car.slot]!.occupant).toBe(car.id);
      }
    }

    expect(life.population.families.every(f => f.balance >= 0)).toBe(true);
    expect(life.errors).toEqual([]);
  }, 30000);
});

it('does not duplicate a shared family car or teleport it between parking and a trip', () => {
  const world = new CityLife('689856', 12);
  let previous = world.frame();

  for (let second = 0.5; second <= 220; second += 0.5) {
    world.advance(0.5);
    const current = world.frame();

    for (const car of current.cars) {
      const before = previous.cars.find(c => c.id === car.id);

      if (before) {
        expect(
          Math.hypot(car.x - before.x, car.z - before.z),
        ).toBeLessThanOrEqual(2.751);
      }

      const drivers = world.population.people.filter(
        p => p.activity === 'drive' && p.trip?.car === car.id,
      );

      expect(drivers.length).toBeLessThanOrEqual(1);

      if (drivers.length) {
        expect(car.driver).toBe(drivers[0]!.id);
      }
    }

    previous = current;
  }
});
