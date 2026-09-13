// Stage 3½d: where the cars of citizens are drawn. A meso car stands at its share of the way along its link, no nearer
// than a car's room to the car ahead and across the lanes; a parked car stands on its tile.
import { describe, expect, it } from 'vitest';
import { newBuilding } from '../../src/buildings/building';
import { newCitizen } from '../../src/citizens';
import type { TilePos } from '../../src/commands';
import type { TripRequested } from '../../src/events';
import { tileFToWorld } from '../../src/map/coords';
import { forEachCitizenCar } from '../../src/meso/render';
import { CAR_LENGTH_METERS, CAR_SPACE_METERS, TRUCK_LENGTH_METERS, stepMesoTraffic } from '../../src/meso/traffic';
import { giveCar } from '../../src/parking';
import { TICK_DT_NS } from '../../src/schedule';
import type { World } from '../../src/world';
import { roadWorld, t } from './helpers';

const trip = (citizen: number, from: TilePos, to: TilePos): TripRequested => ({ citizen, from, carParkedAt: from, to, purpose: 'Work', mode: 'Car', pocket: true });

function drive(w: World, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 10); i++) stepMesoTraffic(w, TICK_DT_NS);
}

interface Pose {
  readonly parked: boolean;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

function poses(w: World): Pose[] {
  const out: Pose[] = [];
  forEachCitizenCar(w, (parked, _id, _generation, x, y, heading) => out.push({ parked, x, y, heading }));
  return out;
}

/** Every tick of game time until the car with render id `id` has left the road: its tile position, tick by tick. */
function track(w: World, id: number, maxSeconds: number): Array<readonly [x: number, y: number]> {
  const path: Array<readonly [number, number]> = [];
  const size = w.mapConfig.tileSize;
  const origin = tileFToWorld(w.mapConfig, 0, 0);
  for (let i = 0; i < maxSeconds * 10; i++) {
    stepMesoTraffic(w, TICK_DT_NS);
    let seen = false;
    forEachCitizenCar(w, (parked, car, _generation, x, y) => {
      if (parked || car !== id) return;
      seen = true;
      path.push([(x - origin.x) / size, (y - origin.y) / size]);
    });
    if (!seen && path.length > 0) break;
  }
  return path;
}

/** Tile positions of every driving car by render id. */
function drivingCars(w: World): Map<number, readonly [x: number, y: number]> {
  const out = new Map<number, readonly [number, number]>();
  const size = w.mapConfig.tileSize;
  const origin = tileFToWorld(w.mapConfig, 0, 0);
  forEachCitizenCar(w, (parked, car, _generation, x, y) => {
    if (!parked) out.set(car, [(x - origin.x) / size, (y - origin.y) / size]);
  });
  return out;
}

const largestStep = (path: ReadonlyArray<readonly [number, number]>) =>
  Math.max(0, ...path.slice(1).map(([x, y], i) => Math.abs(x - path[i]![0]) + Math.abs(y - path[i]![1])));

/** Rows 9 (east) and 10 (west) crossing columns 15 (south) and 16 (north) in a box at 15..16 × 9..10. */
const crossing = () =>
  roadWorld(32, 32, [
    [t(1, 10), t(30, 10), 'TwoLane'],
    [t(15, 1), t(15, 30), 'TwoLane'],
  ]);

/** A four-lane road on rows 23, 24 (east) and 25, 26 (west) across a two-lane one on columns 30 (south) and 31 (north). */
function avenue(): World {
  const w = roadWorld(64, 48, [
    [t(30, 1), t(30, 46), 'TwoLane'],
    [t(1, 25), t(62, 25), 'FourLane'],
  ]);
  const intersectionId = w.intersections.intersectionIdAt(t(30, 23))!;
  w.trafficLights = [{ intersectionId, intersectionKey: 'test', pos: t(30, 23), phase: 'NorthSouthGreen', phaseTimer: 1e9, greenDuration: 20, yellowDuration: 3, allRedDuration: 4 }];
  return w;
}

describe('meso render', () => {
  it('aMesoCarIsDrawnAtItsShareOfTheWayAlongItsLink', () => {
    const w = roadWorld(64, 16, [[t(1, 8), t(62, 8), 'TwoLane']]);
    w.mesoTraffic.pending.push(trip(5, t(4, 7), t(54, 7)));
    drive(w, 22.5);

    const [car, ...rest] = poses(w);
    expect(rest).toEqual([]);
    // Halfway through its 45 s: 25 of its 50 tiles on from (4, 7), heading east.
    const at = tileFToWorld(w.mapConfig, 29, 7);
    expect(car).toMatchObject({ parked: false, heading: 0 });
    expect(Math.abs(car!.x - at.x), `x ${car!.x} against ${at.x}`).toBeLessThan(w.mapConfig.tileSize / 2);
    expect(Math.abs(car!.y - at.y)).toBeLessThan(w.mapConfig.tileSize / 2);
  });

  it('queuedCarsStandACarsRoomApart', () => {
    const w = roadWorld(32, 32, [
      [t(1, 10), t(30, 10), 'TwoLane'],
      [t(15, 1), t(15, 30), 'TwoLane'],
    ]);
    const intersectionId = w.intersections.intersectionIdAt(t(15, 9))!;
    w.trafficLights = [{ intersectionId, intersectionKey: 'test', pos: t(15, 9), phase: 'NorthSouthGreen', phaseTimer: 1e9, greenDuration: 20, yellowDuration: 3, allRedDuration: 4 }];
    w.mesoTraffic.pending.push(trip(1, t(3, 9), t(25, 9)), trip(2, t(2, 9), t(25, 9)));
    drive(w, 40);

    const [head, second] = poses(w).sort((a, b) => b.x - a.x);
    // The head waits on the last tile before the box, the next 7.5 m — three quarters of a tile — behind it.
    expect(head!.x).toBeCloseTo(tileFToWorld(w.mapConfig, 14, 9).x, 0);
    expect(second!.x).toBeCloseTo(tileFToWorld(w.mapConfig, 13.25, 9).x, 0);
    expect([head!.y, second!.y]).toEqual([tileFToWorld(w.mapConfig, 14, 9).y, tileFToWorld(w.mapConfig, 14, 9).y]);
  });

  // A truck is 16.5 m long: behind a car its middle stands a car's room and the rest of its own length back.
  it('aTruckQueuesItsLengthBehindTheCarAhead', () => {
    const w = crossing();
    const intersectionId = w.intersections.intersectionIdAt(t(15, 9))!;
    w.trafficLights = [{ intersectionId, intersectionKey: 'test', pos: t(15, 9), phase: 'NorthSouthGreen', phaseTimer: 1e9, greenDuration: 20, yellowDuration: 3, allRedDuration: 4 }];
    w.mesoTraffic.pending.push(trip(1, t(3, 9), t(25, 9)), { ...trip(-1, t(2, 9), t(25, 9)), purpose: 'Freight', vehicle: 'Truck' });
    drive(w, 40);

    const drawn: Array<{ x: number; truck: boolean }> = [];
    forEachCitizenCar(w, (_parked, _id, _generation, x, _y, _heading, truck) => drawn.push({ x, truck }));
    const [head, behind] = drawn.sort((a, b) => b.x - a.x);
    expect([head!.truck, behind!.truck]).toEqual([false, true]);
    const back = (CAR_SPACE_METERS + (TRUCK_LENGTH_METERS - CAR_LENGTH_METERS) / 2) / w.trafficConfig.tileMeters;
    expect(Math.abs(behind!.x - tileFToWorld(w.mapConfig, 14 - back, 9).x), `truck at ${behind!.x}`).toBeLessThan(0.05 * w.mapConfig.tileSize);
  });

  it('aParkedCarIsDrawnWhereItStands', () => {
    const w = roadWorld(64, 16, [[t(1, 8), t(62, 8), 'TwoLane']]);
    const house = w.buildings.add(newBuilding({ kind: 'Residential', anchor: t(5, 11), capacityResidents: 8 }));
    const citizen = w.citizens.add(newCitizen(house));
    expect(giveCar(w, citizen)).toBe(true);

    const at = tileFToWorld(w.mapConfig, 5, 11);
    expect(poses(w)).toEqual([{ parked: true, x: at.x, y: at.y, heading: 0 }]);
  });
  // A car used to stand at the end of one link through the box time and appear at the start of the next, three tiles on.
  it('aCarCrossesTheBoxWithoutAJump', () => {
    const w = crossing();
    w.mesoTraffic.pending.push(trip(1, t(3, 9), t(25, 9)));
    const path = track(w, 0, 60);
    expect(path.length, 'the car was on the road').toBeGreaterThan(100);
    expect(largestStep(path), 'no tick moves it half a tile').toBeLessThan(0.5);
    expect(path.every(([, y]) => Math.abs(y - 9) < 0.01), 'straight on stays on its row').toBe(true);
  });

  // ГОСТ trajectories, as micro traffic keeps them: a turn in the box is an L, not a chord across the corner.
  it('aTurningCarTurnsAtTheCornerOfAnL', () => {
    const w = crossing();
    w.mesoTraffic.pending.push(trip(1, t(3, 9), t(15, 4)));
    const path = track(w, 0, 60);
    expect(largestStep(path), 'no jump').toBeLessThan(0.5);
    expect(
      path.some(([x, y]) => Math.abs(x - 15) < 0.3 && Math.abs(y - 9) < 0.3),
      'on the entry row as far as the exit column, then down it',
    ).toBe(true);
  });

  // The lane was the place in the queue modulo the lanes: a car switched lanes whenever the queue ahead moved on by one.
  it('aCarKeepsItsLaneAsTheQueueMovesOn', () => {
    const w = avenue();
    for (let i = 0; i < 6; i++) w.mesoTraffic.pending.push(trip(i, t(3 + i, 23), t(50, 23)));
    drive(w, 55);
    const rows = new Map<number, Set<number>>();
    // Five seconds of the queue at red, then twenty after the light turns green.
    for (let tick = 0; tick < 250; tick++) {
      if (tick === 50) w.trafficLights[0]!.phase = 'EastWestGreen';
      drive(w, 0.1);
      // On the approach: its last tile is column 29, the box starts at 30.
      for (const [car, [x, y]] of drivingCars(w)) if (x <= 29.01) (rows.get(car) ?? rows.set(car, new Set()).get(car)!).add(y);
    }
    expect(rows.size).toBe(6);
    for (const [car, ys] of rows) expect([...ys], `car ${car} keeps its lane`).toHaveLength(1);
  });

  it('aCarWaitsInTheLaneOfItsTurn', () => {
    const w = avenue();
    // First a car turning left, onto column 31 north; then one turning right, onto column 30 south.
    w.mesoTraffic.pending.push(trip(1, t(5, 23), t(31, 40)), trip(2, t(4, 23), t(30, 10)));
    drive(w, 60);
    const cars = drivingCars(w);
    expect(cars.get(0)![1], 'the left turner waits in the lane by the centre line').toBeCloseTo(24, 5);
    expect(cars.get(1)![1], 'the right turner by the kerb').toBeCloseTo(23, 5);
  });
});
