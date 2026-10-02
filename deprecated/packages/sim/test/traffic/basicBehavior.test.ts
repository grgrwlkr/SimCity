// Ported from crates/simcity_sim/src/game/traffic/tests/basic_behavior.rs and the `capacity_blocks_step`
// tests of traffic/movement/drive.rs.
import { describe, expect, it } from 'vitest';
import { STUCK_REROUTE_SECS, VEHICLE_LENGTH_TILES } from '../../src/traffic/constants';
import { capacityBlocksStep, moveVehicles } from '../../src/traffic/drive';
import { buildTrafficSpatialIndex } from '../../src/traffic/spatialIndex';
import { breakTileSwaps } from '../../src/traffic/swapBreak';
import { refSlot, resolveVehicle } from '../../src/traffic/vehicles';
import type { World } from '../../src/world';
import { DT, t, trafficWorld, vehicle } from './helpers';

const routeOf = (w: World, ref: number) => {
  const slot = refSlot(w.vehicles, ref);
  return [...(w.pathPool.get(w.vehicles.pathHandle[slot]!) ?? [])];
};

describe('basic vehicle behavior', () => {
  it('vehicleArrivalEmitsTripFinished', () => {
    const w = trafficWorld(8, 8, []);
    const v = vehicle(w, [], 0, 0, 0, 60, 20, 1, { passenger: { citizen: 42, purpose: 'Work' } });
    buildTrafficSpatialIndex(w);
    moveVehicles(w, 0);
    expect(w.events.tripFinished).toEqual([{ citizen: 42, purpose: 'Work' }]);
    expect(resolveVehicle(w.vehicles, v)).toBeUndefined();
  });

  it('lateralTileSwapOnSameDirectionLanesDoesNotDeadlockForever', () => {
    const roads = [0, 1].flatMap((y) => [0, 1, 2, 3].map((x) => [t(x, y), 'West', 'TwoLane', y] as const));
    const w = trafficWorld(4, 2, roads);
    const a = vehicle(w, [t(2, 0), t(2, 1), t(1, 1), t(0, 1)], 0, 0, 0, 60, 20, 1);
    const b = vehicle(w, [t(2, 1), t(2, 0), t(1, 0), t(0, 0)], 0, 0, 0, 60, 20, 1);
    for (let i = 0; i < 200; i++) {
      buildTrafficSpatialIndex(w);
      breakTileSwaps(w);
      moveVehicles(w, DT);
    }
    const done = (ref: number) => {
      const slot = resolveVehicle(w.vehicles, ref);
      return slot === undefined || w.vehicles.pathCursor[slot]! > 0;
    };
    expect(done(a) || done(b), 'tile-swap deadlock: both vehicles pinned at cursor 0 after 200 ticks').toBe(true);
  });

  it('swapBreakerIsInertForNormalQueueing', () => {
    const w = trafficWorld(4, 1, [0, 1, 2, 3].map((x) => [t(x, 0), 'West'] as const));
    const routeA = [t(3, 0), t(2, 0), t(1, 0), t(0, 0)];
    const routeB = [t(2, 0), t(1, 0), t(0, 0)];
    const a = vehicle(w, routeA, 0, 0, 0, 60, 20, 1);
    const b = vehicle(w, routeB, 0, 0, 0, 60, 20, 1);
    buildTrafficSpatialIndex(w);
    breakTileSwaps(w);
    expect(routeOf(w, a), 'follower route was rewritten').toEqual(routeA);
    expect(routeOf(w, b), 'leader route was rewritten').toEqual(routeB);
  });
});

describe('hard overlap clamp', () => {
  /** A 4-tile SixLane road with tile_meters 1 and s0 = 0: one step carries a fast follower past the safe gap. */
  function overlapClampWorld(): World {
    const w = trafficWorld(4, 1, [0, 1, 2, 3].map((x) => [t(x, 0), 'East', 'SixLane'] as const));
    w.trafficConfig.tileMeters = 1;
    w.trafficConfig.idmMinGapM = 0;
    return w;
  }
  const route4 = [t(0, 0), t(1, 0), t(2, 0), t(3, 0)];
  const step = (w: World) => {
    buildTrafficSpatialIndex(w);
    moveVehicles(w, DT);
  };

  it('sameTileFollowerCannotOverlapLeaderAfterLargeStep', () => {
    const w = overlapClampWorld();
    vehicle(w, route4, 0, 0.95, 0, 400, 50, 1);
    const ego = refSlot(w.vehicles, vehicle(w, route4, 0, 0, 400, 400, 50, 1.35));
    step(w);
    expect(w.vehicles.pathCursor[ego], 'ego left the tile; test setup invalid').toBe(0);
    const followerPos = w.vehicles.pathCursor[ego]! + w.vehicles.progress[ego]!;
    const bound = Math.max(0.95 - VEHICLE_LENGTH_TILES, 0);
    expect(followerPos, 'same-tile overlap').toBeLessThanOrEqual(bound + 1e-4);
  });

  it('nextTileFollowerCannotOverlapBoundaryCrossingLeader', () => {
    const w = overlapClampWorld();
    vehicle(w, route4, 1, 0.9, 0, 400, 50, 1);
    const ego = refSlot(w.vehicles, vehicle(w, route4, 0, 0, 400, 400, 50, 1.35));
    step(w);
    const followerPos = w.vehicles.pathCursor[ego]! + w.vehicles.progress[ego]!;
    const bound = 1.9 - VEHICLE_LENGTH_TILES;
    expect(followerPos, 'next-tile overlap').toBeLessThanOrEqual(bound + 1e-4);
    expect(followerPos, 'follower frozen; expected to advance to the safe bound ~0.5').toBeGreaterThan(0.3);
  });

  it('freeFlowFollowerNotThrottledByClamp', () => {
    const w = overlapClampWorld();
    const ego = refSlot(w.vehicles, vehicle(w, route4, 0, 0, 40, 400, 50, 1));
    step(w);
    expect(w.vehicles.pathCursor[ego], 'ego left the tile; test setup invalid').toBe(0);
    expect(w.vehicles.progress[ego], 'free-flow follower under-advanced').toBeGreaterThan(0.2);
    expect(w.vehicles.speed[ego], 'free-flow speed throttled').toBeGreaterThanOrEqual(40);
  });
});

describe('special cases of moveVehicles', () => {
  it('aStuckCarAtABlockedBoxNeverBacksUp', () => {
    // Was `stuckReverseNeverBacksIntoIntersectionBox`. Rust let a stuck car reverse within its tile: it
    // freed nothing, since the car kept its tile and the way ahead stayed blocked, and at the tile start it
    // rocked between reversing and creeping forward. A stuck car now waits; recovery re-routes or removes it.
    const w = trafficWorld(6, 1, [0, 1, 2, 3, 4, 5].map((x) => [t(x, 0), x === 1 || x === 3 ? 'None' : 'East'] as const));
    const ego = refSlot(
      w.vehicles,
      vehicle(w, [t(1, 0), t(2, 0), t(3, 0), t(4, 0)], 1, 0.3, 0, 60, 20, 1, {
        stuck: { secs: STUCK_REROUTE_SECS + 5, lastTile: t(2, 0), lastProgress: 0.3 },
      }),
    );
    let last = 1 + w.vehicles.progress[ego]!;
    for (let i = 0; i < 300; i++) {
      buildTrafficSpatialIndex(w);
      moveVehicles(w, DT);
      const at = w.vehicles.pathCursor[ego]! + w.vehicles.progress[ego]!;
      expect(at, `tick ${i}: the car moved back`).toBeGreaterThanOrEqual(last);
      last = at;
    }
  });

  it('busWithExhaustedPathIsNotDespawnedByMoveVehicles', () => {
    const w = trafficWorld(8, 8, []);
    const bus = vehicle(w, [], 0, 0, 0, 60, 20, 1, { role: 'bus' });
    buildTrafficSpatialIndex(w);
    moveVehicles(w, 0);
    expect(resolveVehicle(w.vehicles, bus), 'a bus with an exhausted path must not be despawned').toBeDefined();
  });

  it('leavingBoxOntoFullExitRoadIsNotCapacityBlocked', () => {
    expect(capacityBlocksStep(true, false, 2, 2), 'a car leaving the box always exits').toBe(false);
    expect(capacityBlocksStep(true, false, 3, 2)).toBe(false);
  });

  it('roadToRoadOntoFullTileIsStillCapacityBlocked', () => {
    expect(capacityBlocksStep(false, false, 2, 2)).toBe(true);
    expect(capacityBlocksStep(false, false, 1, 2)).toBe(false);
  });

  it('enteringBoxIsNotCapacityBlockedHere', () => {
    expect(capacityBlocksStep(false, true, 5, 2)).toBe(false);
    expect(capacityBlocksStep(true, true, 5, 2)).toBe(false);
  });
});
