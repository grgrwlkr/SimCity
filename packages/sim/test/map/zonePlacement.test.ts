// Ported from crates/simcity_sim/src/game/zone_placement.rs (mod tests).
import { describe, expect, it } from 'vitest';
import { MapGrid } from '../../src/map/grid';
import { canZoneTile } from '../../src/map/zonePlacement';

describe('zone placement', () => {
  /** A building needs its whole footprint zoned within zone depth of a road, so zoning reaches that deep. */
  it('zoneDensityZoningReachesAsDeepAsBuildingsGrow', () => {
    const grid = new MapGrid(9, 9);
    const roadPos = { x: 2, y: 2 };
    grid.set(roadPos, {
      ...grid.get(roadPos)!,
      road: { kind: 'TwoLane', dir: 'East', lane: 0, flow: { kind: 'TwoWay' }, laneType: 'Regular' },
    });
    const waterPos = { x: 8, y: 8 };
    grid.set(waterPos, { ...grid.get(waterPos)!, water: true });

    expect(canZoneTile(grid, { x: 2, y: 3 }), 'beside the road').toBe(true);
    expect(canZoneTile(grid, { x: 2, y: 5 }), 'three tiles from the road, as deep as a building grows').toBe(true);
    expect(canZoneTile(grid, { x: 2, y: 6 }), 'four tiles from the road is too far').toBe(false);
    expect(canZoneTile(grid, roadPos), 'the road itself').toBe(false);
    expect(canZoneTile(grid, waterPos), 'water').toBe(false);
  });
});
