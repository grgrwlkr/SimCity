import {expect, it} from 'vitest';
import {CityTraffic} from '../src/city/trafficFlow';
import {polylineLane} from '../src/region/model/life/routes';

it('grows arbitrary junction reservations without resetting a moving vehicle', () => {
  const box = {id: 0, minX: -6, maxX: 6, minZ: -6, maxZ: 6};
  const traffic = new CityTraffic([], {roads: [], junctions: [box]});
  const car = traffic.addCar({length: 4.2, width: 1.8});

  expect(
    traffic.beginTrip(
      car,
      polylineLane([
        {x: -20, z: 2},
        {x: 100, z: 2},
      ]),
    ),
  ).toBe(true);
  traffic.update(4);
  const before = traffic.save();

  expect(before.owners[0]).toBe(car);
  traffic.setJunctions([box, {id: 1, minX: 50, maxX: 62, minZ: -6, maxZ: 6}]);
  const after = traffic.save();

  expect(after.owners).toEqual([car, -1]);
  expect(after.vehicles).toEqual(before.vehicles);
  expect(after.held).toEqual(before.held);
  traffic.update(30);
  expect(traffic.atStop(car)).toBe(1);
});

it('keeps a car behind a pedestrian on a free-form route and resumes when clear', () => {
  let pedestrians = [{x: 0, z: 2}];
  const traffic = new CityTraffic([], {
    roads: [],
    junctions: [],
    pedestrians: () => pedestrians,
  });
  const car = traffic.addCar({length: 4.2, width: 1.8});

  traffic.beginTrip(
    car,
    polylineLane([
      {x: -20, z: 2},
      {x: 40, z: 2},
    ]),
  );
  traffic.update(10);
  expect(traffic.pose(car).x).toBeLessThan(-2.5);
  expect(traffic.atStop(car)).toBeNull();
  pedestrians = [];
  traffic.update(30);
  expect(traffic.atStop(car)).toBe(1);
});

it('keeps idle time advancement equivalent to fixed steps without invoking a reset', () => {
  const traffic = new CityTraffic([], {roads: []});
  const car = traffic.addCar(
    {length: 4.2, width: 1.8},
    {x: -100, z: 2, dx: 1, dz: 0},
  );

  traffic.update(86_400);
  const idle = traffic.save();

  expect(idle.tick).toBe(1_728_000);
  expect(idle.vehicles[0]!.pose).toMatchObject({x: -100, z: 2});
  expect(
    traffic.beginTrip(
      car,
      polylineLane([
        {x: -100, z: 2},
        {x: -50, z: 2},
      ]),
    ),
  ).toBe(true);
  traffic.update(86_401);
  expect(traffic.progress(car)).toBeGreaterThan(0);
});

it('restores only the bounded arrival reservation and preserves subsequent motion', () => {
  const traffic = new CityTraffic([], {roads: []});
  const car = traffic.addCar({length: 6.5, width: 2.3});

  traffic.beginTrip(
    car,
    polylineLane([
      {x: 0, z: 0},
      {x: 100, z: 0},
    ]),
  );
  traffic.update(10);
  expect(traffic.reserveManeuver(car, 70, 100)).toBe(true);
  const saved = traffic.save();

  expect(saved.vehicles[car]!.maneuverFrom).toBe(70);
  const restored = new CityTraffic([], {roads: []});

  restored.restore(saved);
  expect(restored.pedestrianBlocked({x: 10, z: 0})).toBe(false);
  expect(restored.pedestrianBlocked({x: 90, z: 0})).toBe(true);
  traffic.update(12);
  restored.update(12);
  expect(restored.save()).toEqual(traffic.save());
});

it('gives a pedestrian already in the junction priority over an approaching car', () => {
  let pedestrians = [{x: 0, z: 2}];
  const traffic = new CityTraffic([], {
    roads: [],
    junctions: [{id: 0, minX: -6, maxX: 6, minZ: -6, maxZ: 6}],
    pedestrianRadius: 0.3,
    pedestrians: () => pedestrians,
  });
  const car = traffic.addCar({length: 4.2, width: 1.8});

  traffic.beginTrip(
    car,
    polylineLane([
      {x: -30, z: 2},
      {x: 30, z: 2},
    ]),
  );
  traffic.update(10);
  expect(traffic.save().owners[0]).toBe(-1);
  expect(traffic.pose(car).x).toBeLessThan(-6);
  pedestrians = [];
  traffic.update(30);
  expect(traffic.atStop(car)).toBe(1);
});

it('reserves only the vehicle path through a junction and leaves a parallel sidewalk open', () => {
  const traffic = new CityTraffic([], {
    roads: [],
    junctions: [{id: 0, minX: -6, maxX: 6, minZ: -6, maxZ: 6}],
    pedestrianRadius: 0.3,
  });
  const car = traffic.addCar({length: 4.2, width: 1.8});

  traffic.beginTrip(
    car,
    polylineLane([
      {x: -20, z: 2},
      {x: 30, z: 2},
    ]),
  );
  traffic.update(4);
  expect(traffic.save().owners[0]).toBe(car);
  expect(traffic.pedestrianJunctionBlocked({x: 0, z: 2})).toBe(true);
  expect(traffic.pedestrianJunctionBlocked({x: 0, z: 4.8})).toBe(false);
});

it('uses one physical pedestrian radius for a roadside wait and a passing car', () => {
  let pedestrian = {x: 0, z: 1.26};
  const traffic = new CityTraffic([], {
    roads: [],
    pedestrianRadius: 0.3,
    pedestrians: () => [pedestrian],
  });
  const car = traffic.addCar({length: 4.2, width: 1.8});

  expect(
    traffic.beginTrip(
      car,
      polylineLane([
        {x: -0.5, z: 0},
        {x: -20, z: 0},
      ]),
    ),
  ).toBe(true);

  for (let tick = 1; tick <= 200; tick++) {
    const proposed = {x: pedestrian.x, z: Math.max(-3, pedestrian.z - 0.06)};

    if (!traffic.pedestrianBlocked(proposed)) {
      pedestrian = proposed;
    }

    traffic.update(tick * 0.05);
    const pose = traffic.pose(car);

    expect(
      Math.abs(pedestrian.x - pose.x) >= 2.1 + 0.29 ||
        Math.abs(pedestrian.z - pose.z) >= 0.9 + 0.29,
    ).toBe(true);
  }

  expect(traffic.atStop(car)).toBe(1);
  expect(pedestrian.z).toBe(-3);
});

it('stops at a temporary maneuver limit without reporting destination arrival', () => {
  let limit = 20;
  const traffic = new CityTraffic([], {roads: [], travelLimit: () => limit});
  const car = traffic.addCar({length: 6.5, width: 2.3});

  traffic.beginTrip(
    car,
    polylineLane([
      {x: 0, z: 0},
      {x: 100, z: 0},
    ]),
  );
  traffic.update(20);
  expect(traffic.progress(car)).toBe(20);
  expect(traffic.atStop(car)).toBeNull();
  expect(traffic.isActive(car)).toBe(true);
  const snapshot = traffic.save();
  const restored = new CityTraffic([], {roads: [], travelLimit: () => limit});

  restored.restore(snapshot);
  restored.update(30);
  expect(restored.progress(car)).toBe(20);
  expect(restored.atStop(car)).toBeNull();
  limit = Infinity;
  restored.update(60);
  expect(restored.atStop(car)).toBe(1);
});
