import { describe, expect, it } from 'vitest';
import { CityLife } from '../src/city/life/world';

describe('complete resident day', () => {
  it('clears evening trips and garage ramps before midnight', () => {
    const world = new CityLife('689856');
    world.advance(3000);
    const stranded = world.population.people.filter((p) => p.trip && world.seconds - p.trip.started > 900);
    expect(stranded.map((p) => ({ id: p.id, activity: p.activity, leg: p.trip?.leg }))).toEqual([]);
  }, 30000);
});
