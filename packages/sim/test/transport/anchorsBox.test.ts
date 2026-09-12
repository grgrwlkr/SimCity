// Where a trip starts or ends: never on an intersection box tile. A route that ends inside a box has no
// exit lane, so the arbiter never takes the car as a candidate and it waits at the box forever.
import { describe, expect, it } from 'vitest';
import type { TilePos } from '../../src/commands';
import { MapGrid } from '../../src/map/grid';
import { adjacentRoadTowards } from '../../src/transport/anchors';
import { setRoad } from './helpers';

const t = (x: number, y: number): TilePos => ({ x, y });

describe('road anchors and boxes', () => {
  it('aTripNeverStartsOrEndsInsideABox', () => {
    // The lane at (2,2) points away from the target; the neighbour towards it is a box tile.
    const grid = new MapGrid(5, 5);
    setRoad(grid, t(2, 2), { dir: 'East' });
    setRoad(grid, t(1, 2), { dir: 'None' });
    expect(adjacentRoadTowards(grid, t(2, 2), t(0, 2))).toEqual(t(2, 2));
  });

  it('aBoxAloneGivesNoAnchor', () => {
    const grid = new MapGrid(5, 5);
    setRoad(grid, t(1, 2), { dir: 'None' });
    expect(adjacentRoadTowards(grid, t(2, 2), t(0, 2))).toBeUndefined();
  });
});
