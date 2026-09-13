// Stage 3½c: meso traffic. A car is a place in a link's queue: it leaves when its time on the link is up, the link has
// flow left, the light lets its direction go and the next link has room; a head held by a full link past
// `FORCE_PUSH_SECS` is pushed on.
import { describe, expect, it } from 'vitest';
import type { TilePos } from '../../src/commands';
import type { TripRequested } from '../../src/events';
import {
  CAR_SPACE_METERS,
  FORCE_PUSH_SECS,
  SATURATION_PER_LANE_SEC,
  TRUCK_PCE,
  TRUCK_SPACE_METERS,
  linkRoomMeters,
  linkStorage,
  stepMesoTraffic,
} from '../../src/meso/traffic';
import { TICK_DT_NS } from '../../src/schedule';
import type { LightPhase } from '../../src/traffic/lights';
import { summarizeTraffic } from '../../src/traffic/stats';
import type { World } from '../../src/world';
import { roadWorld, t } from './helpers';

const trip = (citizen: number, from: TilePos, to: TilePos): TripRequested => ({ citizen, from, carParkedAt: from, to, purpose: 'Work', mode: 'Car', pocket: true });
const truck = (id: number, from: TilePos, to: TilePos): TripRequested => ({ ...trip(-(id + 1), from, to), purpose: 'Freight', vehicle: 'Truck' });

/** Runs meso traffic for `seconds` of game time, a tick at a time; the arrivals with the second each came on. */
function drive(w: World, seconds: number): Array<readonly [citizen: number, at: number]> {
  const arrivals: Array<readonly [number, number]> = [];
  for (let i = 0; i < Math.round(seconds * 10); i++) {
    w.events.tripFinished.length = 0;
    stepMesoTraffic(w, TICK_DT_NS);
    for (const arrival of w.events.tripFinished) arrivals.push([arrival.citizen, w.mesoTraffic.nowSec]);
  }
  return arrivals;
}

/** The only light, on the box at `pos`, held in `phase`. */
function hold(w: World, pos: TilePos, phase: LightPhase): void {
  const intersectionId = w.intersections.intersectionIdAt(pos)!;
  w.trafficLights = [{ intersectionId, intersectionKey: 'test', pos, phase, phaseTimer: 1e9, greenDuration: 20, yellowDuration: 3, allRedDuration: 4 }];
}

/** Rows 9 (east) and 10 (west) crossing columns 15 (south) and 16 (north) in a box at 15..16 × 9..10. */
const crossing = () =>
  roadWorld(32, 32, [
    [t(1, 10), t(30, 10), 'TwoLane'],
    [t(15, 1), t(15, 30), 'TwoLane'],
  ]);

describe('meso traffic', () => {
  it('aFreeRoadTakesLengthOverSpeed', () => {
    const w = roadWorld(64, 16, [[t(1, 8), t(62, 8), 'TwoLane']]);
    w.mesoTraffic.pending.push(trip(5, t(4, 7), t(54, 7)));
    const arrivals = drive(w, 60);
    expect(arrivals.map(([citizen]) => citizen)).toEqual([5]);
    // 50 tiles of 10 m at 40 km/h.
    expect(arrivals[0]![1]).toBeCloseTo(45, 0);
    expect(w.mesoTraffic.carCount(), 'and the car leaves the road').toBe(0);
  });

  it('flowNeverExceedsCapacity', () => {
    // Sixty cars for the east arm through the box, as many as fit on the approach at a time and the rest after them.
    const w = crossing();
    for (let i = 0; i < 60; i++) w.mesoTraffic.pending.push(trip(i, t(2, 9), t(25, 9)));
    const approach = w.meso.linkAt(t(2, 9));
    drive(w, 12);
    const before = w.mesoTraffic.exits[approach]!;
    drive(w, 60);
    const passed = w.mesoTraffic.exits[approach]! - before;
    expect(passed, 'a lane lets 1 800 cars an hour go: thirty a minute').toBeLessThanOrEqual(Math.floor(60 * SATURATION_PER_LANE_SEC) + 1);
    expect(passed, 'and it does let them go').toBeGreaterThan(20);
  });

  it('aRedLightHoldsTheQueueAndAGreenLetsItGo', () => {
    const w = crossing();
    hold(w, t(15, 9), 'NorthSouthGreen');
    w.mesoTraffic.pending.push(trip(1, t(3, 9), t(25, 9)));
    expect(drive(w, 60), 'east–west is red').toEqual([]);
    expect(w.mesoTraffic.waitingAtLights()).toBe(1);
    w.trafficLights[0]!.phase = 'EastWestGreen';
    expect(drive(w, 30).map(([citizen]) => citizen), 'and green').toEqual([1]);
  });

  it('aFullLinkBacksTheQueueUpTheStreetUntilItsHeadIsPushed', () => {
    // The light at the box is red; the cars come west along row 10, turn at the dead end and queue east on row 9.
    const w = crossing();
    hold(w, t(15, 9), 'NorthSouthGreen');
    const g = w.meso;
    const [westbound, approach, beyond] = [g.linkAt(t(10, 10)), g.linkAt(t(10, 9)), g.linkAt(t(25, 9))];
    // Parked off the road beside the westbound lane only.
    for (let i = 0; i < 40; i++) w.mesoTraffic.pending.push(trip(i, t(13, 11), t(25, 9)));
    const m = w.mesoTraffic;

    drive(w, FORCE_PUSH_SECS - 10);
    expect(m.carsOn(approach), 'the approach holds as many as fit').toBe(linkStorage(w, approach));
    expect(m.carsOn(westbound), 'the rest wait on the street before it').toBeGreaterThan(0);
    expect(m.stats.forcedPushes).toBe(0);

    // The approach is full from about 48 s: its follower is pushed on two minutes later.
    drive(w, 70);
    expect(m.stats.forcedPushes, 'a head held by a full link past the limit is pushed on').toBeGreaterThan(0);
    expect(m.carsOn(beyond), 'but nobody runs the red light').toBe(0);
  });

  // A tick of six game seconds lets through as many as the same seconds in tenths: the queues keep their own times.
  it('flowDoesNotDependOnTheLengthOfATick', () => {
    const passed = (tickNs: number, ticks: number) => {
      const w = crossing();
      for (let i = 0; i < 60; i++) w.mesoTraffic.pending.push(trip(i, t(2, 9), t(25, 9)));
      const approach = w.meso.linkAt(t(2, 9));
      for (let i = 0; i < ticks; i++) stepMesoTraffic(w, tickNs);
      return w.mesoTraffic.exits[approach]!;
    };
    const fine = passed(TICK_DT_NS, 720);
    const coarse = passed(60 * TICK_DT_NS, 12);
    expect(fine).toBeGreaterThan(20);
    // Within a tenth: new trips still join only at the start of a tick (it was a third of the flow before).
    expect(Math.abs(coarse - fine), `72 s in tenths let ${fine} through, in six-second ticks ${coarse}`).toBeLessThanOrEqual(Math.ceil(fine / 10));
  });

  it('aTruckTakesTheRoomOfMoreThanTwoCars', () => {
    const w = crossing();
    hold(w, t(15, 9), 'NorthSouthGreen');
    for (let i = 0; i < 20; i++) w.mesoTraffic.pending.push(truck(i, t(2, 9), t(25, 9)));
    const approach = w.meso.linkAt(t(2, 9));
    drive(w, 60);
    expect(TRUCK_SPACE_METERS / CAR_SPACE_METERS, 'a truck and its gap against a car and its gap').toBeGreaterThan(2);
    expect(w.mesoTraffic.carsOn(approach), 'the approach holds as many trucks as its length').toBe(Math.floor(linkRoomMeters(w, approach) / TRUCK_SPACE_METERS));
    expect(summarizeTraffic(w).trucks, 'counted as trucks').toBe(w.mesoTraffic.carCount());
  });

  it('aTruckUsesTheFlowOfTwoCars', () => {
    const w = crossing();
    for (let i = 0; i < 60; i++) w.mesoTraffic.pending.push(truck(i, t(2, 9), t(25, 9)));
    const approach = w.meso.linkAt(t(2, 9));
    drive(w, 12);
    const before = w.mesoTraffic.exits[approach]!;
    drive(w, 60);
    const passed = w.mesoTraffic.exits[approach]! - before;
    expect(passed, 'fifteen trucks a minute a lane').toBeLessThanOrEqual(Math.floor((60 * SATURATION_PER_LANE_SEC) / TRUCK_PCE) + 1);
    expect(passed, 'and it does let them go').toBeGreaterThan(8);
  });
});
