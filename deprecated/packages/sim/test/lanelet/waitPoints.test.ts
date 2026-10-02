// Wait points of turning lanelets: how far into the box a left turn may drive before it must yield.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import { detectIntersections } from '../../src/intersections/index';
import { tileKey } from '../../src/map/grid';
import { buildSignalizedCross } from '../../src/scenarios/signalizedCross';
import { requestState } from '../../src/state';
import { createWorld } from '../../src/world';

describe('lanelet wait points', () => {
  it('leftTurnWaitsBeforeTheOncomingPath', () => {
    const w = createWorld();
    requestState(w, 'InGame');
    frame(w, 0);
    buildSignalizedCross(w.grid);
    w.graphVersion += 1;
    detectIntersections(w);
    step(w, 1);

    const entryLane = w.laneGraph.posToId.get(tileKey({ x: 39, y: 40 }))!;
    const ids = w.laneletGraph.ofIntersection(0);
    const local = ids.findIndex((lid) => {
      const l = w.laneletGraph.get(lid)!;
      return l.entryLane === entryLane && l.maneuver === 'LeftTurn';
    });
    expect(local, 'the eastbound approach has a left-turn lanelet').toBeGreaterThanOrEqual(0);
    const lanelet = w.laneletGraph.get(ids[local]!)!;
    const matrix = w.laneletConflicts.byIntersection.get(0)!;
    // Eastbound left: (40,40) -> (41,40) -> (41,41). The westbound straight runs (41,41) -> (40,41).
    expect(lanelet.internalPath).toEqual([
      { x: 40, y: 40 },
      { x: 41, y: 40 },
      { x: 41, y: 41 },
    ]);
    expect(matrix.waitLen(local), 'it may hold (40,40) and (41,40) while it yields').toBe(2);

    const straight = ids.findIndex((lid) => {
      const l = w.laneletGraph.get(lid)!;
      return l.entryLane === entryLane && l.maneuver === 'Straight';
    });
    expect(matrix.waitLen(straight), 'a straight has no wait point').toBe(0);
  });
});
