import assert from 'node:assert/strict';
import {CityLife} from '../packages/app/src/city/life/world';
import {MINUTE_SECONDS} from '../packages/app/src/city/life/population';

// Run separately from the unit pool so the long soak does not compete with
// geometry and harbor tests for CPU and invalidate their timeout budgets.
const world = new CityLife('689856');
const week = 7 * 24 * 60 * MINUTE_SECONDS;
let day = -1;

while (world.seconds < week) {
  world.advance(Math.min(600, week - world.seconds));
  const stranded = world.population.people.filter(
    p => p.trip && world.seconds - p.trip.started > 900,
  );

  assert.deepEqual(
    stranded.map(p => ({id: p.id, activity: p.activity, leg: p.trip?.leg})),
    [],
    `Stranded residents on day ${world.day + 1}, minute ${world.minute}`,
  );

  if (world.day !== day) {
    day = world.day;
    console.log(`Day ${day + 1}: no stranded journeys`);
  }
}

assert.ok(world.harbor.status().delivered > 0);
assert.ok(world.harbor.status().exported > 0);
console.log(
  'Full week passed: weekday commutes, weekend outings and port deliveries.',
);
