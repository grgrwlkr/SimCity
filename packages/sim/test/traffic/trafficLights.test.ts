// Ported from crates/simcity_sim/src/game/traffic/tests/traffic_lights.rs and the yellow-light test
// of traffic/tests/vehicle_spawning.rs. Where Rust never advances `Time<Fixed>`, dt is 0 here too.
import { describe, expect, it } from 'vitest';
import { STOP_LINE_OFFSET, TILE_CENTER_TO_EDGE_TILES } from '../../src/traffic/constants';
import { moveVehicles } from '../../src/traffic/drive';
import { buildTrafficSpatialIndex } from '../../src/traffic/spatialIndex';
import { updateVehicleTrafficState } from '../../src/traffic/state';
import { refSlot } from '../../src/traffic/vehicles';
import { DT, detect, placeLight, t, trafficWorld, vehicle } from './helpers';

const STOP_LINE_PROGRESS = TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET;

describe('traffic lights and intersection states', () => {
  it('intersectionTilesIgnoreTileCapacityGateInMoveVehicles', () => {
    const w = trafficWorld(4, 1, [
      [t(0, 0), 'East'],
      [t(1, 0), 'None'],
      [t(2, 0), 'None'],
      [t(3, 0), 'East'],
    ]);
    detect(w);
    w.trafficOccupancy.ensureLen(4);
    w.trafficOccupancy.perTickVehicles[2] = 0xffff;
    const key = w.intersections.clusterKeyAt(t(1, 0))!;
    const v = refSlot(
      w.vehicles,
      vehicle(w, [t(0, 0), t(1, 0), t(2, 0), t(3, 0)], 1, 0, 8, 60, 20, 1, {
        state: { kind: 'CrossingIntersection', intersection: key },
      }),
    );
    buildTrafficSpatialIndex(w);
    moveVehicles(w, DT);
    expect(w.vehicles.progress[v], 'vehicle failed to advance between intersection tiles').toBeGreaterThan(0);
  });

  it('trafficLightStopLineIsOnApproachTileNotInIntersection', () => {
    const approach = t(1, 0);
    const box = t(1, 1);
    const exit = t(1, 2);
    const w = trafficWorld(3, 3, [
      [approach, 'North'],
      [box, 'None'],
      [exit, 'North'],
    ]);
    detect(w);
    placeLight(w, box, 'EastWestGreen', 10);
    const ego = refSlot(w.vehicles, vehicle(w, [approach, box, exit], 0, 0, 8, 60, 20, 1));
    for (let i = 0; i < 120; i++) {
      updateVehicleTrafficState(w);
      buildTrafficSpatialIndex(w);
      moveVehicles(w, 0);
    }
    expect(w.pathPool.getTile(w.vehicles.pathHandle[ego]!, w.vehicles.pathCursor[ego]!)).toEqual(approach);
    if (STOP_LINE_PROGRESS > 0) {
      expect(w.vehicles.progress[ego]).toBeLessThanOrEqual(STOP_LINE_PROGRESS + 1e-2);
    } else {
      expect(w.vehicles.progress[ego]).toBeGreaterThanOrEqual(0);
    }
    const state = w.vehicles.trafficState[ego]!;
    if (state.kind === 'Approaching' || state.kind === 'Stopped' || state.kind === 'WaitingForGreen') {
      expect(state.stopTile).toEqual(approach);
    }
  });

  it('vehicleInsideSignalizedIntersectionIsForcedToCrossingState', () => {
    const box = t(1, 1);
    const exit = t(1, 2);
    const w = trafficWorld(3, 3, [
      [box, 'None'],
      [exit, 'North'],
    ]);
    detect(w);
    placeLight(w, box, 'EastWestGreen', 10);
    const key = w.intersections.clusterKeyAt(box)!;
    const ego = refSlot(
      w.vehicles,
      vehicle(w, [box, exit], 0, 0.2, 0, 60, 20, 1, {
        state: { kind: 'WaitingForGreen', intersection: key, stopTile: t(1, 0) },
      }),
    );
    updateVehicleTrafficState(w);
    expect(w.vehicles.trafficState[ego]).toEqual({ kind: 'CrossingIntersection', intersection: key });
  });

  it('protectedLeftReleasesLeftTurner', () => {
    const approach = t(1, 0);
    const box = t(1, 1);
    const westExit = t(0, 1);
    const w = trafficWorld(3, 3, [
      [approach, 'North'],
      [box, 'None'],
      [westExit, 'West'],
    ]);
    detect(w);
    placeLight(w, box, 'NorthSouthLeftProtected', 5);
    const key = w.intersections.clusterKeyAt(box)!;
    const ego = refSlot(
      w.vehicles,
      vehicle(w, [approach, box, westExit], 0, STOP_LINE_PROGRESS, 0, 60, 20, 1, {
        state: { kind: 'WaitingForGreen', intersection: key, stopTile: approach },
      }),
    );
    updateVehicleTrafficState(w);
    expect(w.vehicles.trafficState[ego], 'protected-left phase must release a left-turning vehicle').toEqual({
      kind: 'Accelerating',
    });
  });

  it('rightTurnOnRedSpeedIsCappedToTurnSpeed', () => {
    const approach = t(1, 0);
    const box = t(1, 1);
    const exit = t(2, 1);
    const w = trafficWorld(3, 3, [
      [approach, 'North'],
      [box, 'None'],
      [exit, 'East'],
    ]);
    w.trafficConfig.rightTurnOnRed = true;
    detect(w);
    const id = placeLight(w, box, 'EastWestGreen', 10);
    const key = w.intersections.clusterKeyAt(box)!;
    const ref = vehicle(w, [approach, box, exit], 0, STOP_LINE_PROGRESS, 999, 999, 20, 1, {
      state: { kind: 'WaitingForGreen', intersection: key, stopTile: approach },
    });
    const ego = refSlot(w.vehicles, ref);
    w.reservations.byIntersection.set(id, [
      { vehicle: ref, state: 'Approaching', createdAtSec: 0, maneuver: 'Other', localIdx: null, coarse: false },
    ]);
    updateVehicleTrafficState(w);
    buildTrafficSpatialIndex(w);
    moveVehicles(w, 0);
    expect(w.vehicles.rightTurnOnRed[ego], 'RightTurnOnRed marker').toBe(id);
    expect(w.vehicles.speed[ego]).toBeLessThanOrEqual(w.vehicles.maxSpeed[ego]! + 1e-3);
  });

  it('yellowAllowsProceedingIfTooLateToStopComfortably', () => {
    const box = t(2, 3);
    const w = trafficWorld(6, 6, [
      [t(2, 0), 'North'],
      [t(2, 1), 'North'],
      [t(2, 2), 'North'],
      [box, 'None'],
      [t(3, 3), 'East'],
    ]);
    detect(w);
    placeLight(w, box, 'NorthSouthYellow', 3);
    const key = w.intersections.clusterKeyAt(box)!;
    const ego = refSlot(
      w.vehicles,
      vehicle(w, [t(2, 0), t(2, 1), t(2, 2), box, t(3, 3)], 0, 0, 100, 999, 20, 1, {
        state: { kind: 'Approaching', intersection: key, stopTile: t(2, 2), distanceToStop: 999 },
      }),
    );
    updateVehicleTrafficState(w);
    expect(w.vehicles.trafficState[ego]).toEqual({ kind: 'CrossingIntersection', intersection: key });
  });
});
