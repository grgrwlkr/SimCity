// A two-way road that ends: the road graph turns cars around at the last tile, and the lanelet planner
// must be able to as well, or every trip that needs the turn falls back to a road route that ignores
// lane discipline in the boxes on its way.
import { describe, expect, it } from 'vitest';
import type { TilePos } from '../../src/commands';
import { tileKey } from '../../src/map/grid';
import { LaneletGraph } from '../../src/transport/lanelet/graph';
import { findRoute, routeIsDirectionCorrect } from '../../src/transport/lanelet/pathfinding';
import { buildLaneGraphInner } from '../../src/transport/laneGraph';
import { defaultPathfindingConfig } from '../../src/transport/pathfinding';
import { TrafficOccupancy } from '../../src/traffic/occupancy';
import { MapGrid } from '../../src/map/grid';
import { setRoad } from '../transport/helpers';

const t = (x: number, y: number): TilePos => ({ x, y });

/** Right-hand two-lane road along columns 4 (South) and 5 (North), ending at row 0. */
function deadEndRoad(): MapGrid {
  const grid = new MapGrid(10, 12);
  for (let y = 0; y < 10; y++) {
    setRoad(grid, t(4, y), { dir: 'South', lane: 1 });
    setRoad(grid, t(5, y), { dir: 'North', lane: 0 });
  }
  return grid;
}

describe('dead-end U-turn', () => {
  it('lanelet planner turns around where a two-way road ends', () => {
    const grid = deadEndRoad();
    const lanes = buildLaneGraphInner(grid, 1);
    const route = findRoute(
      lanes,
      new LaneletGraph(),
      { grid, traffic: new TrafficOccupancy(), cfg: defaultPathfindingConfig(), jitterSeed: 1n },
      lanes.posToId.get(tileKey(t(4, 8)))!,
      lanes.posToId.get(tileKey(t(5, 8)))!,
    );
    expect(route.tiles.length, 'a route exists').toBeGreaterThan(0);
    const turn = route.tiles.findIndex((tile, i) => i > 0 && tile.x === 5 && route.tiles[i - 1]!.x === 4);
    expect(route.tiles[turn], 'the turn is at the last tile of the road').toEqual(t(5, 0));
    expect(routeIsDirectionCorrect(route.tiles, grid)).toBe(true);
  });

  it('no U-turn onto the oncoming lane where the road goes on', () => {
    const grid = deadEndRoad();
    const lanes = buildLaneGraphInner(grid, 1);
    const route = findRoute(
      lanes,
      new LaneletGraph(),
      { grid, traffic: new TrafficOccupancy(), cfg: defaultPathfindingConfig(), jitterSeed: 1n },
      lanes.posToId.get(tileKey(t(4, 8)))!,
      lanes.posToId.get(tileKey(t(5, 8)))!,
    );
    const crossings = route.tiles.filter((tile, i) => i > 0 && tile.x !== route.tiles[i - 1]!.x);
    expect(crossings, 'one crossing, at the end of the road').toEqual([t(5, 0)]);
  });
});
