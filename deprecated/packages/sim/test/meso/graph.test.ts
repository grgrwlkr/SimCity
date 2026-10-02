// Stage 3½: the meso graph. A link is a carriageway of one direction between boxes, as wide as its lanes; links join
// through a box, at a bend and at the turn of a dead end, as the road graph lets a car move.
import { describe, expect, it } from 'vitest';
import { ROAD_DIRS } from '../../src/commands';
import { roadWorld, t } from './helpers';

describe('meso graph', () => {
  it('mesoLinksFollowCarriagewaysBetweenBoxes', () => {
    // Rows 9 (east) and 10 (west) cross columns 15 (south) and 16 (north) in a 2×2 box.
    const w = roadWorld(32, 32, [
      [t(1, 10), t(30, 10), 'TwoLane'],
      [t(15, 1), t(15, 30), 'TwoLane'],
    ]);
    const g = w.meso;
    expect(g.linkCount, 'four arms, a carriageway each way').toBe(8);
    const west = g.linkAt(t(5, 9));
    expect([ROAD_DIRS[g.dir[west]!], g.lanes[west], g.length[west], g.offsetAt(t(5, 9))]).toEqual(['East', 1, 14, 4]);

    const exits = g.successors(west);
    expect(new Set(exits.map((e) => e.link)), 'straight on, left, right and back').toEqual(
      new Set([g.linkAt(t(20, 9)), g.linkAt(t(16, 20)), g.linkAt(t(15, 5)), g.linkAt(t(5, 10))]),
    );
    expect(exits.find((e) => e.link === g.linkAt(t(20, 9))), 'straight on crosses two box tiles of its cluster').toMatchObject({
      boxTiles: 2,
      cluster: w.intersections.intersectionIdAt(t(15, 9)),
    });
  });

  it('aFourLaneCarriagewayIsOneLinkOfTwoLanes', () => {
    const w = roadWorld(32, 32, [[t(1, 25), t(30, 25), 'FourLane']]);
    const g = w.meso;
    expect(g.linkCount).toBe(2);
    const east = g.linkAt(t(5, 23));
    expect(g.linkAt(t(5, 24)), 'both eastbound lanes').toBe(east);
    expect([ROAD_DIRS[g.dir[east]!], g.lanes[east], g.length[east]]).toEqual(['East', 2, 30]);
    const west = g.linkAt(t(5, 26));
    expect([ROAD_DIRS[g.dir[west]!], g.lanes[west]]).toEqual(['West', 2]);
    expect(g.successors(east).map((e) => e.link), 'a dead end turns back').toEqual([west]);
    expect(g.linkAt(t(5, 5)), 'no road, no link').toBe(-1);
  });
});
