// Port of crates/simcity_sim/src/game/traffic/tests/pedestrians.rs.
import { describe, expect, it } from 'vitest';
import { STOP_LINE_OFFSET, TILE_CENTER_TO_EDGE_TILES } from '../../src/traffic/constants';
import { moveVehicles } from '../../src/traffic/drive';
import { buildTrafficSpatialIndex } from '../../src/traffic/spatialIndex';
import { refSlot } from '../../src/traffic/vehicles';
import { DT, detect, t, trafficWorld, vehicle } from './helpers';

describe('vehicles and pedestrians', () => {
  it('vehicleDoesNotEnterUncontrolledIntersectionWhilePedestrianIsCrossingEvenIfReserved', () => {
    const [approach, box, exit] = [t(1, 0), t(1, 1), t(2, 1)];
    const w = trafficWorld(3, 3, [
      [approach, 'North'],
      [box, 'None'],
      [exit, 'East'],
    ]);
    detect(w);
    const id = w.intersections.intersectionIdAt(box)!;
    const stopLine = TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET;
    const ego = vehicle(w, [approach, box, exit], 0, stopLine, 5, 60, 20, 1);
    // A reservation that would normally let it in.
    w.reservations.byIntersection.set(id, [{ vehicle: ego, state: 'Approaching', createdAtSec: 0, maneuver: 'Other', localIdx: null, coarse: false }]);
    w.pedestrianCrossings.push({ intersectionId: id, axisNs: true });

    // The Rust app ran one update, the first, whose frame time is zero.
    buildTrafficSpatialIndex(w);
    moveVehicles(w, 0);

    const slot = refSlot(w.vehicles, ego);
    const tile = () => w.pathPool.getTile(w.vehicles.pathHandle[slot]!, w.vehicles.pathCursor[slot]!);
    expect(tile(), 'it must not enter the box').toEqual(approach);
    expect(w.vehicles.progress[slot]).toBeLessThanOrEqual(stopLine + 1e-6);

    // TS: and on ticks that do move it, it never gets past the edge of its tile while the walker is on the crossing.
    for (let tick = 0; tick < 30; tick++) {
      buildTrafficSpatialIndex(w);
      moveVehicles(w, DT);
      expect(tile(), `still on the approach at tick ${tick}`).toEqual(approach);
      expect(w.vehicles.progress[slot]).toBeLessThanOrEqual(TILE_CENTER_TO_EDGE_TILES + 1e-6);
    }
  });
});
