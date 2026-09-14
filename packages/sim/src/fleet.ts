// Stage 4: the city's own vehicles — the fire engines, police cars and ambulances of its stations. Rust drove them as
// micro vehicles; here each drive is a car trip of meso traffic, under an id below the ids of the region's agents, so an
// arrival finds its way back to the vehicle.
import type { ServiceVehicle } from './services/vehicles';

/** A vehicle `id` drives in meso traffic as `-(FLEET_ID_BASE + id + 1)`; the region's agents stay above `-FLEET_ID_BASE`. */
export const FLEET_ID_BASE = 1 << 30;

export const fleetTripId = (id: number): number => -(FLEET_ID_BASE + id + 1);

/** The vehicle a trip id belongs to, -1 for a trip of a citizen or of the region. */
export const fleetIdOfTrip = (trip: number): number => (trip <= -(FLEET_ID_BASE + 1) ? -trip - FLEET_ID_BASE - 1 : -1);

export class Fleet {
  /** The id the next vehicle takes. */
  nextId = 0;
  /** The vehicles of the service stations, in the order they were given. */
  services: ServiceVehicle[] = [];
  /** The buildings, the map edit and the game minute the stations were last looked at for. */
  stationsKey = '';

  takeId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  service(id: number): ServiceVehicle | undefined {
    return this.services.find((v) => v.id === id);
  }
}
