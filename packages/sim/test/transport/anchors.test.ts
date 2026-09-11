// Ported from crates/simcity_sim/src/game/transport/tests.rs (trip anchors beside a road).
import { describe, expect, it } from 'vitest';
import { MapGrid } from '../../src/map/grid';
import { adjacentRoadTowards, adjacentRoadTowardsFootprint } from '../../src/transport/anchors';
import { oneWay, setRoad } from './helpers';

describe('road anchors', () => {
  /** R11: without a matching lane the anchor prefers a perpendicular lane over the oncoming one. */
  it('adjacentRoadAnchorNeverPrefersOncomingLane', () => {
    const grid = new MapGrid(6, 6);
    setRoad(grid, { x: 2, y: 1 }, { dir: 'West' });
    setRoad(grid, { x: 2, y: 3 }, { dir: 'North' });
    expect(
      adjacentRoadTowards(grid, { x: 2, y: 2 }, { x: 5, y: 2 }),
      'anchor must prefer the perpendicular drivable lane over the oncoming one',
    ).toEqual({ x: 2, y: 3 });

    const oneWayGrid = new MapGrid(6, 6);
    setRoad(oneWayGrid, { x: 2, y: 1 }, { dir: 'West', flow: oneWay('East') });
    expect(
      adjacentRoadTowards(oneWayGrid, { x: 2, y: 2 }, { x: 5, y: 2 }),
      'the wrong-way half of a one-way road must never be a trip anchor',
    ).toBeUndefined();
  });

  /** The entrance is found along the whole footprint, nearest the destination; a fronting anchor keeps its own. */
  it('zoneDensityBuildingEntranceIsFoundAlongTheWholeFootprint', () => {
    const grid = new MapGrid(12, 12);
    for (let x = 0; x < 12; x++) setRoad(grid, { x, y: 6 }, { dir: 'East' });
    const anchor = { x: 2, y: 2 };
    const target = { x: 10, y: 6 };

    expect(adjacentRoadTowards(grid, anchor, target), 'the anchor tile alone sees no road').toBeUndefined();
    expect(
      adjacentRoadTowardsFootprint(grid, anchor, 4, 4, target),
      'the road tile beside the footprint nearest the destination is the entrance',
    ).toEqual({ x: 5, y: 6 });

    setRoad(grid, { x: 2, y: 1 }, { dir: 'East' });
    expect(
      adjacentRoadTowardsFootprint(grid, anchor, 4, 4, target),
      'an anchor that fronts a road keeps its own entrance',
    ).toEqual({ x: 2, y: 1 });
  });
});
