import { describe, expect, it } from 'vitest';
import { CityLife } from '../src/city/life/world';
import type { Household, Resident } from '../src/city/life/types';
import { RouteBuilder } from '../src/city/life/network';

const SEED = '689856';

function advanceUntil(world: CityLife, predicate: () => boolean, limit: number): void {
  const deadline = world.seconds + limit;
  while (!predicate() && world.seconds < deadline) {
    world.advance(0.05);
  }
  expect(predicate(), `Condition did not occur before second ${deadline}`).toBe(true);
}

function members(world: CityLife, family: Household): Resident[] {
  return family.members.map((id) => world.population.people[id]!);
}

function approachingFamily(world: CityLife): Household {
  advanceUntil(world, () => world.population.people.some((p) => p.activity === 'train'), 300);
  const person = world.population.people.find((p) => p.activity === 'train')!;
  return world.population.families[person.family]!;
}

function westboundWorld(): CityLife {
  const saved = new CityLife(SEED, 3).save();
  // Exercise the opposite platform on the next timetabled train, keeping the same real simulation.
  saved.nextImmigration = 232;
  return CityLife.fromSave(saved);
}

describe('railway arrivals in city life', () => {
  it('brings a persistent family on the train and lets every member walk from the platform to their home', () => {
    const world = new CityLife(SEED, 180);
    const family = approachingFamily(world);
    expect(world.railway.snapshot().train.phase).toBe('arriving');
    expect(world.railway.snapshot().train.direction).toBe(1);
    expect(members(world, family).map((p) => p.activity)).toEqual(['train', 'train', 'train']);
    expect(family.arrived).toBe(false);
    expect(world.railway.snapshot().train.passengers).toBe(3);
    for (const person of members(world, family)) {
      const pose = world.frame().people.find((p) => p.id === person.id)!;
      expect(pose.x).toBe(world.railway.snapshot().train.x);
      expect(pose.z).toBe(world.railway.snapshot().train.z);
      expect(person.trip?.destination).toBe(world.population.home(family).id);
    }
    advanceUntil(world, () => members(world, family).some((p) => p.activity === 'walk'), 100);
    const first = members(world, family).find((p) => p.activity === 'walk')!;
    expect(world.railway.snapshot().train.doorsOpen).toBe(true);
    expect(world.railway.snapshot().train.passengers).toBe(2);
    expect(first.trip?.points.slice(0, 3).map((p) => [p.x, p.z])).toEqual([
      [-34, -130],
      [-24, -130],
      [-24, -126.5],
    ]);
    advanceUntil(world, () => family.arrived, 600);
    const home = world.population.home(family);
    expect(members(world, family).every((p) => p.location === home.id && p.activity === 'home')).toBe(true);
    expect(world.population.arrivals).toBe(3);
    expect(
      members(world, family).every((p) => p.history.some((event) => event.text.includes('Семья заселилась'))),
    ).toBe(true);
    expect(world.railway.snapshot().train.passengers).toBe(0);
    expect(world.errors).toEqual([]);
  }, 120000);

  it('takes westbound arrivals over the elevated footbridge before they reach city sidewalks', () => {
    const world = westboundWorld();
    const family = approachingFamily(world);
    expect(world.railway.snapshot().train.direction).toBe(-1);
    advanceUntil(world, () => members(world, family).some((p) => p.activity === 'walk'), 100);
    const first = members(world, family).find((p) => p.activity === 'walk')!;
    expect(first.trip?.points.some((p) => p.y === 7.35 && p.z === -142)).toBe(true);
    expect(first.trip?.points.some((p) => p.y === 7.35 && p.z === -130)).toBe(true);
    let crossedBridge = false;
    let returnedToGround = false;
    while (!family.arrived && world.seconds < 900) {
      world.advance(0.05);
      if (
        first.position.y !== undefined &&
        first.position.y > 7 &&
        first.position.z > -142 &&
        first.position.z < -130
      ) {
        crossedBridge = true;
      }
      if (crossedBridge && first.position.z > -126.5 && (first.position.y ?? 1.07) < 2) {
        returnedToGround = true;
      }
    }
    expect(crossedBridge).toBe(true);
    expect(returnedToGround).toBe(true);
    expect(family.arrived).toBe(true);
    expect(world.population.arrivals).toBe(3);
    expect(world.railway.status().passengers).toBe(3);
    expect(world.errors).toEqual([]);
  });

  it('restores a mixed train/platform disembarkation and completes the identical family journey', () => {
    const original = westboundWorld();
    const family = approachingFamily(original);
    advanceUntil(original, () => members(original, family).some((p) => p.activity === 'walk'), 100);
    expect(members(original, family).filter((p) => p.activity === 'train')).toHaveLength(2);
    const data: unknown = JSON.parse(JSON.stringify(original.save()));
    const restored = CityLife.fromSave(data);
    expect(restored.save()).toEqual(original.save());
    const loadedFamily = restored.population.families[family.id]!;
    for (let second = 0; second < 600 && !family.arrived; second++) {
      original.advance(1);
      restored.advance(0.4);
      restored.advance(0.6);
    }
    expect(family.arrived).toBe(true);
    expect(loadedFamily.arrived).toBe(true);
    expect(restored.save()).toEqual(original.save());
    expect(restored.frame().people.map((p) => p.id)).toEqual(original.frame().people.map((p) => p.id));
    expect(restored.railway.snapshot().train.passengers).toBe(0);
    expect(restored.errors).toEqual([]);
  });

  it('stops actual traffic and walkers at the train gate, then resumes both after the train clears', () => {
    const world = new CityLife(SEED, 0);
    const car = world.traffic.addCar({ length: 3, width: 1.5 });
    const route = new RouteBuilder({ x: -189, z: -183, y: 0.91 }).line({ x: -189, z: -123, y: 0.91 }).route();
    expect(world.traffic.beginTrip(car, route)).toBe(true);
    world.advance(6);
    const family = world.population.createFamily(world.seconds, false)!;
    const walker = world.population.people[family.members[0]!]!;
    const home = world.population.home(family);
    walker.activity = 'walk';
    walker.position = { x: -191.45, z: -148, y: 1.07 };
    walker.nextAt = Infinity;
    walker.trip = {
      purpose: 'home',
      destination: home.id,
      started: world.seconds,
      reason: 'Crossing integration fixture',
      leg: 'walk',
      car: null,
      facility: null,
      distance: 0,
      length: 24,
      points: [walker.position, { x: -191.45, z: -124, y: 1.07 }],
    };
    world.advance(5);
    expect(world.railway.snapshot().crossings[0]?.state).toBe('closed');
    expect(world.traffic.pose(car).z).toBeLessThanOrEqual(-146.5);
    expect(walker.position.z).toBeLessThanOrEqual(-145.22);
    const distanceBefore = walker.trip.distance;
    const carBefore = world.traffic.pose(car).z;
    world.advance(1);
    expect(world.traffic.pose(car).z).toBeCloseTo(carBefore);
    expect(walker.trip.distance).toBe(distanceBefore);
    world.advance(25);
    expect(world.traffic.pose(car).z).toBe(-123);
    expect(walker.history.some((event) => event.text === `Прибыл: ${home.name}`)).toBe(true);
    expect(world.errors).toEqual([]);
  });

  it('starts an inactive car outside a closing gate without sweeping from its dormant off-map pose', () => {
    const world = new CityLife(SEED, 0);
    world.advance(6);
    const car = world.traffic.addCar({ length: 3, width: 1.5 });
    const route = new RouteBuilder({ x: -189, z: -149, y: 0.91 }).line({ x: -189, z: -123, y: 0.91 }).route();
    expect(world.traffic.beginTrip(car, route)).toBe(true);
  });

  it('does not create train passengers when immigration becomes due just before the doors close', () => {
    const initial = new CityLife(SEED, 3).save();
    initial.nextImmigration = 1000;
    const arriving = CityLife.fromSave(initial);
    arriving.advance(40);
    expect(arriving.railway.snapshot().train.phase).toBe('boarding');
    const parked = arriving.save();
    parked.nextImmigration = parked.railway.dwellUntil - 1.5;
    const world = CityLife.fromSave(parked);
    world.advance(parked.railway.dwellUntil - world.seconds - 0.05);
    expect(world.population.families).toHaveLength(3);
    expect(world.population.people.some((p) => p.activity === 'train')).toBe(false);
    world.advance(600);
    expect(world.population.people.some((p) => p.activity === 'train')).toBe(false);
    expect(world.save().railArrival).toBeNull();
    expect(world.population.families).toHaveLength(4);
    expect(world.population.families[3]?.arrived).toBe(true);
  });
});
