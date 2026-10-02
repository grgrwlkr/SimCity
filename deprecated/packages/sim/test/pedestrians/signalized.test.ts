// Port of crates/simcity_sim/src/game/pedestrians/tests_signalized.rs on the TS walkers: a walker north of the box of
// `crossroads()` walks south along column 30, through the box, across the east–west road.
import { describe, expect, it } from 'vitest';
import { crossroads, startWalk, t, walk, walkerAt } from './helpers';
import type { World } from '../../src/world';

function lit(w: World, phase: 'NorthSouthGreen' | 'EastWestGreen') {
  const intersectionId = w.intersections.intersectionIdAt(t(30, 9))!;
  w.intersections.trafficLights.add(intersectionId);
  w.trafficLights = [{ intersectionId, intersectionKey: 'test', pos: t(30, 9), phase, phaseTimer: 1e9, greenDuration: 20, yellowDuration: 3, allRedDuration: 4 }];
  return w.trafficLights[0]!;
}

/** North of the box: the box's rows are 9 and 10, its northern edge at 10.5. */
const inOrPastTheBox = (p: { y: number }) => p.y < 10.5;

describe('pedestrians at a signalized intersection', () => {
  it('pedestrianWaitsForAllowedPhaseBeforeEnteringIntersection', () => {
    const w = crossroads();
    const light = lit(w, 'EastWestGreen');
    const slot = startWalk(w, t(29, 14), t(29, 4));

    const waiting = walk(w, slot, 120);
    expect(waiting.at(-1)!.y, 'it comes to the corner').toBeLessThan(11.6);
    expect(waiting.filter(inOrPastTheBox), 'walking south is not let go while east–west has green').toEqual([]);

    light.phase = 'NorthSouthGreen';
    expect(walk(w, slot, 10).some(inOrPastTheBox), 'on its own green it enters the box').toBe(true);
  });

  it('pedestrianCanFinishCrossingInsideSignalizedIntersectionAfterPhaseChanges', () => {
    const w = crossroads();
    const light = lit(w, 'NorthSouthGreen');
    const slot = startWalk(w, t(29, 14), t(29, 4));

    walk(w, slot, 200, () => {
      const at = walkerAt(w, slot);
      // The moment it is inside the box, the phase turns against it.
      if (at !== undefined && at.y < 10.4) light.phase = 'EastWestGreen';
    });
    expect(light.phase, 'it got into the box').toBe('EastWestGreen');
    expect(walkerAt(w, slot)!.y, 'and out of it on the far side, whatever the light').toBeLessThan(8.5);
  });
});
