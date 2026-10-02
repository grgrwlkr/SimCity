import { expect, it } from 'vitest';
import { CityTraffic } from '../src/city/trafficFlow';
import type { LaneRoute } from '../src/city/trafficRoutes';

const route: LaneRoute = {
  direction: 1,
  closed: false,
  length: 14,
  segments: [{ kind: 'line', x: 0, z: -117, dx: 1, dz: 0, length: 14 }],
};
it('keeps parked cars inactive, drives a finite trip, and restores a moving car exactly', () => {
  const traffic = new CityTraffic([{ length: 3.2, width: 1.5 }], { initiallyInactive: new Set([0]) });
  expect(traffic.isActive(0)).toBe(false);
  expect(traffic.beginTrip(0, route)).toBe(true);
  traffic.update(2);
  const saved = traffic.save();
  const other = new CityTraffic([{ length: 3.2, width: 1.5 }], { initiallyInactive: new Set([0]) });
  other.restore(saved);
  expect(other.update(3)).toEqual(traffic.update(3));
  traffic.update(10);
  expect(traffic.atStop(0)).toBe(1);
  expect(traffic.pose(0).x).toBeCloseTo(14);
  traffic.park(0);
  expect(traffic.isActive(0)).toBe(false);
});

it('yields to a pedestrian crossing its lane and continues when the crossing clears', () => {
  let people = [{ x: 0, z: -117 }];
  const traffic = new CityTraffic([{ length: 3.2, width: 1.5 }], {
    initiallyInactive: new Set([0]),
    pedestrians: () => people,
  });
  const trip: LaneRoute = {
    direction: 1,
    closed: false,
    length: 16,
    segments: [{ kind: 'line', x: -8, z: -117, dx: 1, dz: 0, length: 16 }],
  };
  expect(traffic.beginTrip(0, trip)).toBe(true);
  traffic.update(5);
  expect(traffic.pose(0).x).toBeLessThan(-2.3);
  const waiting = traffic.pose(0).x;
  traffic.update(8);
  expect(traffic.pose(0).x).toBeCloseTo(waiting);
  people = [];
  traffic.update(15);
  expect(traffic.atStop(0)).toBe(1);
  expect(traffic.pose(0).x).toBeCloseTo(8);
});

it('reserves the body sweep at a garage turn between the old sampling points', async () => {
  const { generateCity } = await import('../src/city/generator');
  const { createLifeProfile, parkingRoute } = await import('../src/city/life/network');
  const { sampleLaneRoute } = await import('../src/city/trafficRoutes');
  const profile = createLifeProfile(generateCity('689856'));
  const garage = profile.facilities.find((f) => f.kind === 'underground' && f.blockId === 'block-1-0')!;
  const exit = parkingRoute(garage, profile.slots[garage.slots[0]!]!, false).route;
  const traffic = new CityTraffic(
    [
      { length: 3.8, width: 1.5 },
      { length: 3.8, width: 1.5 },
    ],
    { initiallyInactive: new Set([0, 1]) },
  );
  expect(traffic.beginTrip(0, exit, exit.length)).toBe(true);
  const state = traffic.save(),
    departing = state.vehicles[0]!;
  // Actual day-two failure: the next change of heading is only 0.01 m away.
  departing.distance = departing.previous = 8.228;
  departing.pose = sampleLaneRoute(exit, departing.distance);
  traffic.restore(state);
  const approach: LaneRoute = {
    direction: 1,
    closed: false,
    length: 0.1,
    segments: [{ kind: 'line', ...garage.road.point, dx: -1, dz: 0, length: 0.1 }],
  };
  expect(traffic.beginTrip(1, approach)).toBe(false);
  traffic.update(8);
  expect(traffic.atStop(0)).toBe(1);
  expect(traffic.beginTrip(1, approach)).toBe(true);
});

it('can finish an already wedged departure without touching the stopped car behind it', async () => {
  const { generateCity } = await import('../src/city/generator');
  const { createLifeProfile, parkingRoute } = await import('../src/city/life/network');
  const { sampleLaneRoute } = await import('../src/city/trafficRoutes');
  const profile = createLifeProfile(generateCity('689856'));
  const garage = profile.facilities.find((f) => f.kind === 'underground' && f.blockId === 'block-1-0')!;
  const exit = parkingRoute(garage, profile.slots[garage.slots[0]!]!, false).route;
  const traffic = new CityTraffic(
    [
      { length: 3.8, width: 1.5 },
      { length: 3.8, width: 1.5 },
    ],
    { initiallyInactive: new Set([0, 1]) },
  );
  expect(traffic.beginTrip(0, exit, exit.length)).toBe(true);
  const state = traffic.save(),
    departing = state.vehicles[0]!,
    stopped = state.vehicles[1]!;
  departing.distance = departing.previous = 8.228;
  departing.pose = sampleLaneRoute(exit, departing.distance);
  // An old save can contain this stationary arrival inside the desired bumper gap.
  stopped.active = true;
  stopped.stopped = true;
  stopped.pose = { ...garage.road.point, dx: -1, dz: 0 };
  traffic.restore(state);
  const clearance = Math.hypot(3.8, 1.5);
  for (let frame = 1; frame <= 160; frame++) {
    traffic.update(frame * 0.05);
    const a = traffic.pose(0),
      b = traffic.pose(1);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(clearance);
  }
  expect(traffic.atStop(0)).toBe(1);
});
