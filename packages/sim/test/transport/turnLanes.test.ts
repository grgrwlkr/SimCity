// Ported from crates/simcity_sim/src/game/transport/turn_lanes.rs (mod tests) and transport/tests.rs
// (autogen ordering pins).
import { describe, expect, it } from 'vitest';
import { runFixedTick } from '../../src/app';
import type { RoadKind } from '../../src/commands';
import { MapGrid } from '../../src/map/grid';
import { EDGE_N } from '../../src/transport/roadGraph';
import { rebuildRoadGraph } from '../../src/transport/roadGraph';
import { autogenTurnLanes, autogenTurnLanesInner } from '../../src/transport/turnLanes';
import { createWorld, type World } from '../../src/world';
import { fourLaneTurnIntersectionGrid, loadGrid, setRoad } from './helpers';

const road = (grid: MapGrid, x: number, y: number, kind: RoadKind, dir: 'None' | 'North' | 'West', lane: number) =>
  setRoad(grid, { x, y }, { kind, dir, lane });

function worldWithTurnIntersection(): World {
  const w = createWorld({ mapWidth: 5, mapHeight: 5 });
  loadGrid(w, fourLaneTurnIntersectionGrid());
  w.graphVersion = 7;
  return w;
}

describe('turn lane autogen', () => {
  /** With a straight exit present no lane is dedicated: through traffic needs both lanes. */
  it('autogenKeepsLanesRegularWhenStraightExitExists', () => {
    const grid = new MapGrid(10, 10);
    road(grid, 4, 4, 'FourLane', 'None', 0);
    road(grid, 5, 4, 'FourLane', 'None', 0);
    road(grid, 4, 3, 'FourLane', 'North', 1);
    road(grid, 5, 3, 'FourLane', 'North', 0);
    road(grid, 4, 5, 'FourLane', 'North', 1);
    road(grid, 5, 5, 'FourLane', 'North', 0);
    road(grid, 3, 4, 'FourLane', 'West', 0);

    autogenTurnLanesInner(grid);

    expect(grid.get({ x: 4, y: 3 })!.road.laneType, 'leftmost approach lane stays Regular').toBe('Regular');
    expect(grid.get({ x: 5, y: 3 })!.road.laneType, 'rightmost approach lane stays Regular').toBe('Regular');
  });

  /** A must-turn approach (T without a straight exit) still gets its left lane dedicated. */
  it('autogenMarksLeftLaneOnMustTurnApproach', () => {
    const grid = new MapGrid(10, 10);
    road(grid, 4, 4, 'FourLane', 'None', 0);
    road(grid, 5, 4, 'FourLane', 'None', 0);
    road(grid, 4, 3, 'FourLane', 'North', 1);
    road(grid, 5, 3, 'FourLane', 'North', 0);
    road(grid, 3, 4, 'FourLane', 'West', 0);

    autogenTurnLanesInner(grid);

    expect(grid.get({ x: 4, y: 3 })!.road.laneType, 'leftmost lane becomes LeftTurnOnly').toBe('LeftTurnOnly');
    expect(grid.get({ x: 5, y: 3 })!.road.laneType, 'no right exit to dedicate the rightmost lane for').toBe(
      'Regular',
    );
  });

  it('autogenSingleLaneApproachStaysRegular', () => {
    const grid = new MapGrid(10, 10);
    road(grid, 4, 4, 'TwoLane', 'None', 0);
    road(grid, 4, 3, 'TwoLane', 'North', 0);
    road(grid, 4, 5, 'TwoLane', 'North', 0);
    road(grid, 3, 4, 'TwoLane', 'West', 0);

    autogenTurnLanesInner(grid);

    expect(grid.get({ x: 4, y: 3 })!.road.laneType, 'single-lane approach must stay Regular').toBe('Regular');
  });

  it('autogenTurnLanesFourLaneTwoLanesAssignsLeftAndStraightOnly', () => {
    const grid = fourLaneTurnIntersectionGrid();
    autogenTurnLanesInner(grid);
    expect(grid.get({ x: 3, y: 1 })!.road.laneType).toBe('LeftTurnOnly');
    expect(grid.get({ x: 2, y: 1 })!.road.laneType).toBe('Regular');
  });

  /** One fixed tick produces a road graph that already reflects this version's autogen marks. */
  it('autogenTurnLanesFeedsRoadGraphOnFixedUpdate', () => {
    const w = worldWithTurnIntersection();
    runFixedTick(w);

    const leftmost = { x: 3, y: 1 };
    const rightmost = { x: 2, y: 1 };
    expect(w.grid.get(leftmost)!.road.laneType, 'autogen must have marked the leftmost approach this tick').toBe(
      'LeftTurnOnly',
    );
    expect(w.roadGraph.isBuiltFor(7), 'road graph must be built this tick').toBe(true);
    expect(
      w.roadGraph.edges[w.grid.idx(leftmost)!]! & EDGE_N,
      'LeftTurnOnly approach must not get a straight entry edge (autogen must run before the road graph)',
    ).toBe(0);
    expect(w.roadGraph.edges[w.grid.idx(rightmost)!]! & EDGE_N, 'Regular approach keeps its straight entry edge').not.toBe(
      0,
    );
  });

  /** Negative control: the reverse order bakes the stale Regular mark into the cached edges. */
  it('roadGraphBeforeAutogenBakesStaleLaneMarks', () => {
    const w = worldWithTurnIntersection();
    rebuildRoadGraph(w);
    autogenTurnLanes(w);

    const leftmost = { x: 3, y: 1 };
    expect(w.grid.get(leftmost)!.road.laneType, 'autogen still ran (after the graph)').toBe('LeftTurnOnly');
    expect(
      w.roadGraph.edges[w.grid.idx(leftmost)!]! & EDGE_N,
      'reverse order must bake the stale Regular mark — otherwise the positive pin is tautological',
    ).not.toBe(0);
  });
});
