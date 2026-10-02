// Car following on a straight lane through the whole schedule.
import { describe, expect, it } from 'vitest';
import { step } from '../../src/app';
import { VEHICLE_LENGTH_TILES } from '../../src/traffic/constants';
import { refSlot } from '../../src/traffic/vehicles';
import { t, trafficWorld, vehicle } from './helpers';

describe('car following', () => {
  it('followerKeepsMovingBehindACruisingLeader', () => {
    // A leader three tiles ahead at a steady 12 world units/s: the follower must settle behind it,
    // never come to a stop and never close in below a car length.
    const route = Array.from({ length: 60 }, (_, x) => t(x, 0));
    const w = trafficWorld(60, 1, route.map((p) => [p, 'East'] as const));
    const leader = refSlot(w.vehicles, vehicle(w, route, 6, 0, 12, 12, 20, 1));
    const follower = refSlot(w.vehicles, vehicle(w, route, 3, 0, 12, 60, 20, 1));
    const v = w.vehicles;

    let minSpeed = Infinity;
    let minDistance = Infinity;
    for (let i = 0; i < 150; i++) {
      step(w, 1);
      if (v.pathCursor[leader]! >= route.length - 2) break;
      if (i < 5) continue;
      minSpeed = Math.min(minSpeed, v.speed[follower]!);
      const distance = v.pathCursor[leader]! + v.progress[leader]! - (v.pathCursor[follower]! + v.progress[follower]!);
      minDistance = Math.min(minDistance, distance);
    }
    expect(minSpeed, 'the follower never stalls behind a moving leader').toBeGreaterThan(6);
    expect(minDistance, 'and never overlaps it').toBeGreaterThanOrEqual(VEHICLE_LENGTH_TILES);
  });

  it('followerBrakesSmoothlyForAStoppedCar', () => {
    // A car standing twenty tiles ahead (a queue tail): the follower at 12 world units/s must see it in
    // time and brake within the model's hard limit, not be snapped to a stop on a tile boundary.
    const route = Array.from({ length: 40 }, (_, x) => t(x, 0));
    const w = trafficWorld(40, 1, route.map((p) => [p, 'East'] as const));
    const stopped = refSlot(w.vehicles, vehicle(w, route, 20, 0, 0, 0, 20, 1));
    const follower = refSlot(w.vehicles, vehicle(w, route, 2, 0, 12, 60, 20, 1));
    const v = w.vehicles;
    // idmMaxDecelMps2 7 m/s² at 1.6 world units per metre, over one 0.1 s tick, with f32 slack.
    const maxDropPerTick = 7 * 1.6 * 0.1 + 0.01;

    let previous = v.speed[follower]!;
    let worstDrop = 0;
    for (let i = 0; i < 300; i++) {
      step(w, 1);
      worstDrop = Math.max(worstDrop, previous - v.speed[follower]!);
      previous = v.speed[follower]!;
    }
    const gap = v.pathCursor[stopped]! + v.progress[stopped]! - (v.pathCursor[follower]! + v.progress[follower]!);
    expect(worstDrop, `worst one-tick speed drop ${worstDrop.toFixed(2)}`).toBeLessThanOrEqual(maxDropPerTick);
    expect(v.speed[follower], 'the follower has come to a stop').toBeLessThan(0.1);
    expect(gap, 'a car length behind the stopped car').toBeGreaterThanOrEqual(VEHICLE_LENGTH_TILES);
  });

  it('queuedCarsStopACarLengthAndAMinimumGapApart', () => {
    // A car is 5 m and a queue keeps the 2 m minimum gap: centres 7 m (0.7 tile) apart, like real traffic.
    const route = Array.from({ length: 40 }, (_, x) => t(x, 0));
    const w = trafficWorld(40, 1, route.map((p) => [p, 'East'] as const));
    const stopped = refSlot(w.vehicles, vehicle(w, route, 20, 0, 0, 0, 20, 1));
    const follower = refSlot(w.vehicles, vehicle(w, route, 10, 0, 12, 60, 20, 1));
    const v = w.vehicles;
    for (let i = 0; i < 300; i++) step(w, 1);
    const spacing = v.pathCursor[stopped]! + v.progress[stopped]! - (v.pathCursor[follower]! + v.progress[follower]!);
    expect(v.speed[follower], 'the follower has stopped').toBeLessThan(0.1);
    expect(spacing, `centres ${spacing.toFixed(2)} tiles apart`).toBeGreaterThanOrEqual(0.7 - 0.01);
    expect(spacing).toBeLessThanOrEqual(0.8);
  });
});
