// Port of crates/simcity_sim/src/game/pedestrians/tests_graph.rs. Walkers here walk the lane beside the kerb, not a tile
// beside the road, so the invariant reads on lane tiles: a six-lane road carries no pavement, but the lane tile at its box
// is a corner a walker stands on to cross, and the box itself is walked.
import { describe, expect, it } from 'vitest';
import { defaultPedestrianConfig } from '../../src/pedestrians/graph';
import { startWalk, t, walk, walkWorld } from './helpers';

describe('pedestrian graph', () => {
  it('sixlaneHasNoSidewalksButIntersectionCornersAreWalkable', () => {
    // A six-lane road on rows 7..12 across a two-lane one on columns 30..31: the box is 30..31 × 7..12.
    // The narrow road first: the road tool lays a wider road over a narrower one, not the other way.
    const w = walkWorld(64, 24, [
      [t(30, 1), t(30, 22), 'TwoLane'],
      [t(1, 10), t(62, 10), 'SixLane'],
    ]);
    const g = w.pedestrianGraph;
    const kerb = w.grid.get(t(10, 7))!;
    expect(kerb.road.kind, 'row 7 is the kerb lane of the six-lane road').toBe('SixLane');
    expect(g.isWalkable(t(10, 7)), 'a six-lane lane away from any box has no pavement').toBe(false);
    expect(g.isWalkable(t(29, 7)), 'the six-lane lane beside the box is a corner').toBe(true);
    expect(g.isWalkable(t(30, 9)), 'the box is walked across').toBe(true);
    expect(g.isWalkable(t(30, 18)), 'a two-lane road has its pavement').toBe(true);
    expect(g.isWalkable(t(10, 3)), 'grass is not').toBe(false);
  });

  // Not a Rust port: in Rust a walk with no pavement to go by was not spawned. Here it goes along the six-lane road as a
  // last resort, still on the road, rather than straight across the blocks.
  it('aWalkWithNoPavementStillFollowsTheRoad', () => {
    const w = walkWorld(64, 24, [[t(1, 10), t(62, 10), 'SixLane']]);
    const slot = startWalk(w, t(8, 13), t(50, 13));
    const path = walk(w, slot, 400);
    expect(path.length).toBeGreaterThan(300);
    const astray = path.filter((p) => w.grid.get({ x: Math.round(p.x), y: Math.round(p.y) })?.road.kind === 'None' && Math.abs(p.x - 8) > 1 && Math.abs(p.x - 50) > 1);
    expect(astray, 'on the road but at the two doors').toEqual([]);
    expect(path.at(-1)!.x, 'and on the way to the far door').toBeGreaterThan(30);
  });

  // Not a Rust port: the pedestrian knobs are constants, like `defaultTrafficConfig`, pinned at the values of
  // rust-final:assets/config/pedestrians.ron.
  it('pedestrianConfigPinsTheShippedKnobs', () => {
    expect(defaultPedestrianConfig()).toEqual({
      // Rust counted `wait_reroute_hours: 6.0` on a clock of a second an hour; on a real-time clock that wait is a
      // game minute.
      waitRerouteSecs: 60,
      waitRerouteMaxAttempts: 3,
      uncontrolledSafetyMarginSecs: 0.5,
      uncontrolledMinGapTiles: 0.35,
    });
  });
});
