// Port of crates/simcity_sim/src/game/traffic/tests/vehicle_spawning.rs and vehicle_parking.rs: trip
// vehicles spawn at the road beside where the citizen's car is parked, an owned car is parked on
// arrival and driven again on the next car trip. Plus the congestion throttle.
import { describe, expect, it } from 'vitest';
import type { TripRequested } from '../../src/events';
import type { TilePos } from '../../src/commands';
import { tileToWorld } from '../../src/map/coords';
import { moveVehicles } from '../../src/traffic/drive';
import { buildTrafficSpatialIndex } from '../../src/traffic/spatialIndex';
import { spawnTripVehicles } from '../../src/traffic/spawn';
import { refSlot, resolveVehicle, spawnVehicle } from '../../src/traffic/vehicles';
import { rebuildRoadGraphInner } from '../../src/transport/roadGraph';
import { createWorld, type World } from '../../src/world';
import { setRoad } from '../transport/helpers';
import { DT } from './helpers';

const t = (x: number, y: number): TilePos => ({ x, y });

function world(roads: readonly TilePos[]): World {
  const w = createWorld({ mapWidth: 3, mapHeight: 3 });
  w.appState = 'InGame';
  for (const pos of roads) setRoad(w.grid, pos, { dir: 'East' });
  rebuildRoadGraphInner(w.grid, 1, w.roadGraph);
  return w;
}

/** A car trip from home (0,0) to (2,2) with the car parked at the building on (0,2). */
const carTrip = (citizen: number): TripRequested => ({
  citizen,
  from: t(0, 0),
  carParkedAt: t(0, 2),
  to: t(2, 2),
  purpose: 'Work',
  mode: 'Car',
});

describe('trip vehicles', () => {
  it('carTripSpawnsFromCitizenCarParkedAtNotFrom', () => {
    // (1,0) is beside `from`, (1,2) beside the parked car and the destination.
    const w = world([t(1, 0), t(1, 2)]);
    w.events.tripRequested.push(carTrip(1));

    spawnTripVehicles(w);

    const v = w.vehicles;
    expect(v.order.length, 'one vehicle spawned').toBe(1);
    const at = tileToWorld(w.mapConfig, t(1, 2));
    expect([v.x[v.order[0]!], v.y[v.order[0]!]], 'on the road beside the parked car').toEqual([at.x, at.y]);
  });

  it('parkedOwnedCarIsReusedForNextCarTrip', () => {
    const w = world([t(1, 2)]);
    const car = spawnVehicle(w, { route: [t(1, 2)], carOwner: 9, parkedOffset: 1 });
    w.events.tripRequested.push(carTrip(9));

    spawnTripVehicles(w);

    const v = w.vehicles;
    expect(v.order.length, 'still exactly one car').toBe(1);
    const slot = resolveVehicle(v, car);
    expect(slot, 'the same car').toBeDefined();
    expect(v.parked[slot!], 'now driving').toBe(0);
    expect(v.passengerCitizen[slot!], 'with its citizen aboard').toBe(9);
  });

  it('ownedCarIsParkedOnArrivalNotDespawned', () => {
    const w = world([t(1, 1)]);
    const tile = t(1, 1);
    const car = spawnVehicle(w, { route: [tile], progress: 1, carOwner: 7, passenger: { citizen: 7, purpose: 'Work' } });

    buildTrafficSpatialIndex(w);
    moveVehicles(w, DT);

    expect(w.events.tripFinished).toEqual([{ citizen: 7, purpose: 'Work' }]);
    const slot = resolveVehicle(w.vehicles, car);
    expect(slot, 'the car stays').toBeDefined();
    const v = w.vehicles;
    expect(v.parked[slot!], 'parked').toBe(1);
    expect(v.passengerCitizen[slot!], 'the trip is over').toBe(-1);
    expect(w.pathPool.getTile(v.pathHandle[slot!]!, v.pathCursor[slot!]!)).toEqual(tile);
    expect(v.speed[refSlot(v, car)]).toBe(0);
  });

  it('carTripsWaitWhileTheNetworkIsJammed', () => {
    const w = world([t(1, 0), t(1, 2)]);
    w.trafficIndex.maxCongestion = Math.fround(0.96);
    w.events.tripRequested.push(carTrip(1));

    spawnTripVehicles(w);
    expect(w.vehicles.order.length, 'no new car into a jam').toBe(0);

    w.trafficIndex.maxCongestion = 0;
    w.events.tripRequested.length = 0;
    spawnTripVehicles(w);
    expect(w.vehicles.order.length, 'the trip leaves once the jam clears').toBe(1);
  });

  it('tripsOverThePlanBudgetSpawnOnALaterTick', () => {
    const w = world([t(1, 0), t(1, 2)]);
    w.trafficConfig.maxRoutePlansPerTick = 1;
    w.events.tripRequested.push(carTrip(1), carTrip(2));

    spawnTripVehicles(w);
    expect(w.vehicles.order.length, 'one plan this tick').toBe(1);

    w.events.tripRequested.length = 0;
    spawnTripVehicles(w);
    expect(w.vehicles.order.length, 'the other trip is not lost').toBe(2);
  });
});
