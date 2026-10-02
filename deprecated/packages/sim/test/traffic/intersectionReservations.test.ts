// Port of crates/simcity_sim/src/game/traffic/tests/intersection_reservations.rs.
import { describe, expect, it } from 'vitest';
import { moveVehicles } from '../../src/traffic/drive';
import { buildTrafficSpatialIndex } from '../../src/traffic/spatialIndex';
import { computeExitDirection } from '../../src/traffic/state';
import { refSlot } from '../../src/traffic/vehicles';
import { MapGrid } from '../../src/map/grid';
import { setRoad } from '../transport/helpers';
import { DT, detect, t, trafficWorld, vehicle } from './helpers';

describe('intersection reservations', () => {
  it('intersectionTileWithKindNoneDoesNotForceSpeedToZero', () => {
    const w = trafficWorld(4, 1, [
      [t(0, 0), 'East'],
      [t(1, 0), 'None'],
      [t(2, 0), 'None'],
      [t(3, 0), 'East'],
    ]);
    detect(w);
    const key = w.intersections.clusterKeyAt(t(1, 0))!;
    const ref = vehicle(w, [t(0, 0), t(1, 0), t(2, 0), t(3, 0)], 1, 0, 8, 60, 20, 1, {
      state: { kind: 'CrossingIntersection', intersection: key },
    });
    buildTrafficSpatialIndex(w);
    moveVehicles(w, DT);
    const slot = refSlot(w.vehicles, ref);
    expect(w.vehicles.speed[slot], 'speed forced near zero on an intersection tile').toBeGreaterThan(0.1);
    expect(w.vehicles.progress[slot], 'the vehicle advances while crossing').toBeGreaterThan(0);
  });

  it('exitDirectionFallsBackToRoadDirOnDiagonalClusterExit', () => {
    const grid = new MapGrid(6, 6);
    for (const [pos, dir] of [
      [t(5, 3), 'West'],
      [t(4, 3), 'None'],
      [t(4, 2), 'None'],
      [t(5, 1), 'South'],
      [t(5, 0), 'South'],
    ] as const) {
      setRoad(grid, pos, { kind: 'TwoLane', dir });
    }
    const route = [t(5, 3), t(4, 3), t(4, 2), t(5, 1), t(5, 0)];
    expect(computeExitDirection(route, grid, t(4, 3))).toBe('South');
  });
});
