// Port of crates/simcity_sim/src/game/pedestrians/tests_uncontrolled.rs on the TS walkers.
import { describe, expect, it } from 'vitest';
import { buildTrafficSpatialIndex } from '../../src/traffic/spatialIndex';
import { despawnVehicle, spawnVehicle } from '../../src/traffic/vehicles';
import { boxAt, crossroads, eastboundRow, startWalk, t, walk, walkWorld } from './helpers';

describe('pedestrians at an uncontrolled intersection', () => {
  it('pedestrianWaitsForSafeGapOnUncontrolledIntersection', () => {
    const w = crossroads();
    const row = eastboundRow(w);
    // A car at the very end of the approach tile, its next tile the box.
    const car = spawnVehicle(w, { route: [t(29, row), t(30, row), t(31, row), t(32, row)], progress: 0.9, speed: 5 });
    buildTrafficSpatialIndex(w);
    const slot = startWalk(w, t(29, 14), t(29, 4));

    // Twenty-odd seconds to the corner, then half a minute there: short of the wait that sends it round.
    const waiting = walk(w, slot, 55);
    expect(waiting.at(-1)!.y, 'it comes to the corner').toBeLessThan(11.6);
    expect(waiting.filter((p) => p.y < 10.5), 'but does not step in front of the car').toEqual([]);

    despawnVehicle(w, car);
    buildTrafficSpatialIndex(w);
    expect(walk(w, slot, 10).some((p) => p.y < 10.5), 'the car gone, it enters the box').toBe(true);
  });

  it('pedestrianReroutesAfterLongWaitAtUncontrolledIntersection', () => {
    // An east–west road on rows 9..10 crossed by streets on columns 10..11 and 50..51. The walker crosses the road at
    // column 30, a tile nearer the first box than the second, so it goes to the first.
    const w = walkWorld(64, 32, [
      [t(6, 10), t(54, 10), 'TwoLane'],
      [t(10, 4), t(10, 26), 'TwoLane'],
      [t(50, 4), t(50, 26), 'TwoLane'],
    ]);
    expect(w.grid.get(t(12, 10))!.road.dir).toBe('West');
    // A car standing at the end of the westbound lane into the first box, where the walker waits.
    spawnVehicle(w, { route: [t(12, 10), t(11, 10), t(10, 10), t(9, 10)], progress: 0.9, speed: 0 });
    buildTrafficSpatialIndex(w);
    const slot = startWalk(w, t(30, 11), t(30, 8));
    const inFirstBox = (p: { x: number; y: number }) => p.x > 9.5 && p.x < 11.5 && p.y > 8.5 && p.y < 10.5;

    const toTheCorner = walk(w, slot, 170);
    expect(toTheCorner.at(-1)!.x, 'it goes to the first box').toBeLessThan(12.5);
    expect(toTheCorner.filter(inFirstBox), 'and waits at it').toEqual([]);

    // Past the wait a walker gives up on this crossing.
    w.citizens.walkWaitSecs[slot] = w.pedestrianConfig.waitRerouteSecs;
    const around = walk(w, slot, 900);
    expect(w.citizens.walkAvoid[slot]).toBe(boxAt(w, t(10, 9)));
    expect(around.filter(inFirstBox), 'the new way avoids the box it waited at').toEqual([]);
    expect(around.some((p) => p.x > 49.5 && p.x < 51.5 && p.y > 8.5 && p.y < 10.5), 'it crosses at the second').toBe(true);
    expect(Math.abs(around.at(-1)!.x - 30), 'and walks back to its door').toBeLessThan(1);
  });
});
