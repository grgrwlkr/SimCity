// Ported from crates/simcity_data/src/game/route_oncoming_pins.rs (mod oracle_unit): a
// router-independent judge of a route against the map geometry, box tiles included.
import { describe, expect, it } from 'vitest';
import type { TilePos } from '../../src/commands';
import { MapGrid } from '../../src/map/grid';
import { firstOncoming } from '../../src/transport/oncoming';
import { oracleCrossingGrid, setRoad } from './helpers';

const route = (...tiles: Array<readonly [number, number]>): TilePos[] => tiles.map(([x, y]) => ({ x, y }));
const lane = (grid: MapGrid, x: number, y: number, dir: 'North' | 'South' | 'East' | 'West' | 'None') =>
  setRoad(grid, { x, y }, { kind: 'FourLane', dir });

describe('oncoming oracle', () => {
  it('straightThroughBoxIsClean', () => {
    const northbound = Array.from({ length: 10 }, (_, y) => ({ x: 5, y }));
    expect(firstOncoming(northbound, oracleCrossingGrid())).toBeUndefined();
  });

  it('legalUturnThroughCenterPasses', () => {
    const uTurn = route([2, 4], [3, 4], [4, 4], [5, 4], [5, 5], [4, 5], [3, 5], [2, 5]);
    expect(firstOncoming(uTurn, oracleCrossingGrid()), 'a П-through-center U-turn must be clean').toBeUndefined();
  });

  it('illegalEdgeHugUturnIsFlagged', () => {
    const edgeHug = route([2, 4], [3, 4], [4, 4], [4, 5], [3, 5], [2, 5]);
    expect(firstOncoming(edgeHug, oracleCrossingGrid()), 'edge-hug North on the southbound column must be flagged').toEqual([
      { x: 4, y: 4 },
      { x: 4, y: 5 },
    ]);
  });

  it('realLaneWrongWayIsFlagged', () => {
    expect(firstOncoming(route([5, 8], [5, 7], [5, 6]), oracleCrossingGrid())).toBeDefined();
  });

  /** Only the entering tile's own lane can flag a step whose origin is not a road at all. */
  it('bSideEnteringRealLaneAgainstDirIsFlagged', () => {
    const grid = new MapGrid(10, 10);
    for (let x = 0; x < 8; x++) lane(grid, x, 4, 'East');
    expect(grid.get({ x: 8, y: 4 })!.road.kind, 'precondition: step origin must be a non-road tile').toBe('None');
    expect(firstOncoming(route([8, 4], [7, 4]), grid)).toEqual([
      { x: 8, y: 4 },
      { x: 7, y: 4 },
    ]);
  });

  it('oneSidedTJunctionColumnStillConstrains', () => {
    const grid = new MapGrid(10, 10);
    for (let x = 0; x < 10; x++) lane(grid, x, 4, 'East');
    lane(grid, 5, 4, 'None');
    for (let y = 5; y < 9; y++) lane(grid, 5, y, 'North');
    expect(firstOncoming(route([5, 5], [5, 4]), grid), 'one-sided reconstruction must still flag the step').toBeDefined();
  });

  /** Known limitation: two different roads on one column that disagree leave the in-box step unconstrained. */
  it('disagreeingSidesYieldNoConstraintKnownFalseNegative', () => {
    const grid = new MapGrid(10, 10);
    for (let x = 0; x < 10; x++) lane(grid, x, 4, 'East');
    lane(grid, 5, 4, 'None');
    for (let y = 0; y < 4; y++) lane(grid, 5, y, 'North');
    for (let y = 5; y < 10; y++) lane(grid, 5, y, 'South');
    expect(firstOncoming(route([5, 3], [5, 4]), grid), 'disagreeing sides are a documented false negative').toBeUndefined();
  });
});
