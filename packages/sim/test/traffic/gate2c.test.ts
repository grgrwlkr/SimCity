// Gate of stage 2c (docs/plans/2026-09-11-web-phase-2-traffic.md): 300 citizens drive their own cars
// between home and work road tiles of the test city for 6000 ticks. No car waits for green 600 ticks or
// longer, no route runs against a lane, recovery removes no car, nothing is left in the trip backlog, and
// the number of driving cars does not grow in the second half.
import { describe, expect, it } from 'vitest';
import type { TilePos } from '../../src/commands';
import { step } from '../../src/app';
import { rangeU32, stdRngSeedFromU64 } from '../../src/rng';
import { routeDirectionOk } from '../../src/traffic/reroute';
import { vehicleRef } from '../../src/traffic/vehicles';
import { loadTestCity } from '../testCity';

const TICKS = 6000;
const CITIZENS = 300;
const WINDOW = 600;

describe('stage 2c gate', () => {
  it('testCityCommuteDrivesWithoutJams', () => {
    const w = loadTestCity();
    const rng = stdRngSeedFromU64(7n);
    const roads: TilePos[] = [];
    for (let y = 0; y < w.grid.height; y++) {
      for (let x = 0; x < w.grid.width; x++) {
        const cell = w.grid.get({ x, y });
        if (cell !== undefined && !cell.water && cell.road.kind !== 'None' && cell.road.dir !== 'None') roads.push({ x, y });
      }
    }
    const pick = () => roads[rangeU32(rng, 0, roads.length)]!;
    const citizens = Array.from({ length: CITIZENS }, () => ({
      home: pick(),
      work: pick(),
      atWork: false,
      driving: false,
      departAt: rangeU32(rng, 1, 600),
    }));

    const v = w.vehicles;
    const waitingSince = new Map<number, number>();
    const lastCursor = new Map<number, readonly [cursor: number, len: number]>();
    let longestWaitForGreen = 0;
    let removed = 0;
    let wrongWay = 0;
    const drivingPerWindow: number[] = [];

    for (let k = 1; k <= TICKS; k++) {
      citizens.forEach((c, i) => {
        if (c.driving || w.tick < c.departAt) return;
        const here = c.atWork ? c.work : c.home;
        const there = c.atWork ? c.home : c.work;
        w.pendingEvents.tripRequested.push({ citizen: i, from: here, carParkedAt: here, to: there, purpose: c.atWork ? 'ReturnHome' : 'Work', mode: 'Car' });
        c.driving = true;
      });
      step(w, 1);

      const alive = new Set<number>();
      for (const slot of v.order) {
        const ref = vehicleRef(v, slot);
        alive.add(ref);
        if (v.parked[slot] === 1) continue;
        lastCursor.set(ref, [v.pathCursor[slot]!, w.pathPool.len(v.pathHandle[slot]!)]);
        if (v.trafficState[slot]!.kind === 'WaitingForGreen') {
          if (!waitingSince.has(ref)) waitingSince.set(ref, w.tick);
          longestWaitForGreen = Math.max(longestWaitForGreen, w.tick - waitingSince.get(ref)!);
        } else waitingSince.delete(ref);
      }
      // A car gone short of the end of its route was removed by recovery.
      for (const [ref, [cursor, len]] of lastCursor) {
        if (alive.has(ref)) continue;
        if (cursor < len - 2) removed += 1;
        lastCursor.delete(ref);
        waitingSince.delete(ref);
      }
      for (const e of w.events.tripFinished) {
        const c = citizens[e.citizen]!;
        c.driving = false;
        c.atWork = !c.atWork;
        c.departAt = w.tick + rangeU32(rng, 200, 800);
      }

      if (k % WINDOW === 0) {
        let driving = 0;
        for (const slot of v.order) {
          if (v.parked[slot] === 1) continue;
          driving += 1;
          if (!routeDirectionOk(w.pathPool.remainingFrom(v.pathHandle[slot]!, v.pathCursor[slot]!) ?? [], w.grid)) wrongWay += 1;
        }
        drivingPerWindow.push(driving);
      }
    }

    const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const half = drivingPerWindow.length / 2;
    expect(longestWaitForGreen, 'the longest wait for green, ticks').toBeLessThan(600);
    expect(wrongWay, 'routes against a lane at the window checks').toBe(0);
    expect(removed, 'cars removed by recovery').toBe(0);
    expect(w.tripBacklog.length, 'trips still waiting for a car').toBe(0);
    expect(mean(drivingPerWindow.slice(half)), `driving cars per window: ${drivingPerWindow.join(' ')}`).toBeLessThanOrEqual(
      mean(drivingPerWindow.slice(0, half)) * 1.1,
    );
  }, 120_000);
});
