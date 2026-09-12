// TS (stage 3½): a capacity never throws. With every vehicle slot taken, a trip that needs a new car waits in the
// backlog; before, `spawnVehicle` threw and the worker loop died with the city frozen on screen.
import { describe, expect, it } from 'vitest';
import type { TripRequested } from '../../src/events';
import { MapGrid } from '../../src/map/grid';
import { spawnTripVehicles } from '../../src/traffic/spawn';
import { refSlot, spawnVehicle } from '../../src/traffic/vehicles';
import { t, worldOn } from '../buildings/helpers';

describe('trip spawn capacity', () => {
  it('aTripWaitsWhenVehicleSlotsAreFull', () => {
    const w = worldOn(new MapGrid(16, 16));
    const v = w.vehicles;
    // Every slot holds a parked car of somebody else, so the trip needs a new one and the active cap is not the limit.
    while (v.free.length > 0) v.parked[refSlot(v, spawnVehicle(w, { route: [t(0, 0)], carOwner: 999 }))] = 1;
    const trip: TripRequested = { citizen: 1, from: t(1, 1), carParkedAt: t(1, 1), to: t(9, 9), purpose: 'Work', mode: 'Car' };
    w.events.tripRequested.push(trip);

    expect(() => spawnTripVehicles(w)).not.toThrow();
    expect(w.tripBacklog, 'the trip waits for a slot').toEqual([trip]);
  });
});
