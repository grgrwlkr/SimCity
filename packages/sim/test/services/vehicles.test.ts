// Stage 4, not a Rust test: the vehicles of a station are what `sync_service_stations_from_buildings` attached in Rust —
// `vehicle_capacity` of them, parked by the station's road — and they go with the station.
import { describe, expect, it } from 'vitest';
import { vehicleCapacity } from '../../src/buildings/building';
import { applyGameCommandsToGrid } from '../../src/map/apply';
import { syncServiceStations } from '../../src/services/vehicles';
import { place, street, t } from './helpers';

describe('service vehicles', () => {
  it('aStationKeepsItsVehiclesAndTheyGoWithIt', () => {
    expect([vehicleCapacity('FireStation'), vehicleCapacity('PoliceStation'), vehicleCapacity('Hospital'), vehicleCapacity('School')]).toEqual([3, 4, 2, 0]);
    const w = street();
    const fire = place(w, 'FireStation', t(10, 9));
    const hospital = place(w, 'Hospital', t(30, 9));
    syncServiceStations(w);
    const services = w.fleet.services;
    expect(services.filter((v) => v.station === fire.id).map((v) => [v.kind, v.state])).toEqual([
      ['Fire', 'AtStation'],
      ['Fire', 'AtStation'],
      ['Fire', 'AtStation'],
    ]);
    expect(services.filter((v) => v.station === hospital.id)).toHaveLength(2);
    const road = services.find((v) => v.station === fire.id)!.homeRoad;
    expect(w.grid.get(road)!.road.kind, 'they stand by a road of the station').not.toBe('None');

    syncServiceStations(w);
    expect(w.fleet.services, 'a station is given its vehicles once').toHaveLength(5);

    applyGameCommandsToGrid(w, [{ kind: 'EraseTile', pos: t(10, 9) }]);
    syncServiceStations(w);
    expect(w.fleet.services.map((v) => v.station), 'the vehicles at a station that is gone go with it').toEqual([hospital.id, hospital.id]);
  });
});
