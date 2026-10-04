import {describe, expect, it} from 'vitest';
import {CityTraffic} from '../src/city/trafficFlow';
import {polylineLane} from '../src/region/model/pathGeometry';

const junctions = [
  {id: 0, minX: -2, maxX: 5, minZ: -2, maxZ: 2},
  {id: 1, minX: 6, maxX: 12, minZ: -2, maxZ: 2},
];
const route = (from: number, to: number) =>
  polylineLane([
    {x: from, z: 0},
    {x: to, z: 0},
  ]);

describe('authored junction handover', () => {
  it('releases the former junction after a same-tick handover so a following actor can pass safely', () => {
    const traffic = new CityTraffic([], {roads: [], junctions});
    const first = traffic.addCar({length: 4, width: 2});

    expect(traffic.beginTrip(first, route(0, 30))).toBe(true);
    traffic.update(3);
    expect(traffic.save().held[first]).toBe(1);
    expect(traffic.save().owners).toEqual([-1, first]);
    traffic.update(10);
    expect(traffic.atStop(first)).toBe(1);
    expect(traffic.save().owners).toEqual([-1, -1]);
    const following = traffic.addCar({length: 4, width: 2});

    expect(traffic.beginTrip(following, route(-12, 20))).toBe(true);

    for (let time = 10.05; time < 20; time += 0.05) {
      traffic.update(time);
      expect(traffic.pose(first).x - traffic.pose(following).x).toBeGreaterThan(
        4,
      );
    }

    traffic.update(20);
    expect(traffic.atStop(following)).toBe(1);
    expect(traffic.save().owners).toEqual([-1, -1]);
  });

  it('retains a former junction claimed by an active maneuver until its actual completion', () => {
    const traffic = new CityTraffic([], {roads: [], junctions});
    const first = traffic.addCar({length: 4, width: 2});

    expect(traffic.beginTrip(first, route(0, 30), 20)).toBe(true);
    traffic.update(3);
    expect(traffic.save().held[first]).toBe(1);
    expect(traffic.save().owners).toEqual([first, first]);
    expect(traffic.reconcileOrphanReservations()).toEqual([]);
    const following = traffic.addCar({length: 4, width: 2});

    expect(traffic.beginTrip(following, route(1, 4))).toBe(false);
    traffic.update(10);
    expect(traffic.save().owners).toEqual([-1, -1]);
    expect(traffic.beginTrip(following, route(1, 4))).toBe(true);
  });

  it('recovers only authored orphan claims without changing vehicles or default-grid ownership', () => {
    const traffic = new CityTraffic([], {roads: [], junctions});
    const car = traffic.addCar({length: 4, width: 2});

    traffic.beginTrip(car, route(0, 30));
    traffic.update(10);
    const saved = traffic.save();

    saved.owners[0] = car;
    saved.held[car] = -1;
    const restored = new CityTraffic([], {roads: [], junctions});

    restored.restore(saved);
    expect(restored.reconcileOrphanReservations()).toEqual([0]);
    expect(restored.save().owners).toEqual([-1, -1]);
    expect(restored.save().vehicles).toEqual(saved.vehicles);
    const defaultGrid = new CityTraffic([], {roads: [0, 34], junctions});

    defaultGrid.restore(saved);
    expect(defaultGrid.reconcileOrphanReservations()).toEqual([]);
    expect(defaultGrid.save().owners[0]).toBe(car);
  });

  it('keeps an untracked owner whose body touches any rotated bound sharing the identity', () => {
    const aliases = [
      ...junctions,
      {
        id: 0,
        minX: 27,
        maxX: 33,
        minZ: -3,
        maxZ: 3,
        oriented: {
          center: {x: 30, z: 0},
          yaw: Math.PI / 4,
          minX: -2,
          maxX: 2,
          minZ: -2,
          maxZ: 2,
        },
      },
    ];
    const traffic = new CityTraffic([], {roads: [], junctions: aliases});
    const car = traffic.addCar({length: 4, width: 2});

    traffic.beginTrip(car, route(30, 40));
    traffic.update(0.05);
    const saved = traffic.save();

    saved.held[car] = -1;
    saved.owners[1] = car;
    const restored = new CityTraffic([], {roads: [], junctions: aliases});

    restored.restore(saved);
    expect(restored.reconcileOrphanReservations()).toEqual([1]);
    expect(restored.save().owners).toEqual([car, -1]);
  });

  it('shares every compound bound and maneuver claim while remapping a member identity', () => {
    const traffic = new CityTraffic([], {roads: [], junctions});
    const car = traffic.addCar({length: 4, width: 2});

    traffic.beginTrip(car, route(0, 30), 20);
    traffic.update(3);
    const before = traffic.save();

    traffic.setJunctions(
      junctions.map(box => ({...box, id: 1})),
      new Map([[0, 1]]),
    );
    expect(traffic.save().owners).toEqual([-1, car]);
    expect(traffic.save().held[car]).toBe(1);
    expect(traffic.save().vehicles).toEqual(before.vehicles);
    expect(traffic.reconcileOrphanReservations()).toEqual([]);
    const following = traffic.addCar({length: 4, width: 2});

    expect(traffic.beginTrip(following, route(1, 4))).toBe(false);
    traffic.update(10);
    expect(traffic.save().owners).toEqual([-1, -1]);
    expect(traffic.beginTrip(following, route(1, 4))).toBe(true);
  });

  it('rejects conflicting compound owners without dropping either reservation or moving actors', () => {
    const separate = [junctions[0]!, {...junctions[1]!, minX: 28, maxX: 35}];
    const traffic = new CityTraffic([], {roads: [], junctions: separate});
    const first = traffic.addCar({length: 4, width: 2});
    const second = traffic.addCar({length: 4, width: 2});

    traffic.beginTrip(first, route(0, 20));
    traffic.beginTrip(second, route(30, 50));
    traffic.update(0.05);
    const before = traffic.save();

    expect(before.owners).toEqual([first, second]);
    expect(() =>
      traffic.setJunctions(
        separate.map(box => ({...box, id: 1})),
        new Map([[0, 1]]),
      ),
    ).toThrow('Несовместимые владельцы');
    expect(traffic.save()).toEqual(before);
  });
});
