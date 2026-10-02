// The vehicles of the service stations, after `sync_service_stations_from_buildings` and `park_returned_service_vehicles`
// of crates/simcity_sim/src/game/services/systems.rs. A station keeps `vehicleCapacity` vehicles by its road. A vehicle
// sent to an emergency drives there in meso traffic, stands on the scene while the emergency is resolved, and drives
// back; Rust drove it tile by tile at a speed of its own, here it drives at the speed of the roads.
import { vehicleCapacity } from '../buildings/building';
import { gameMinute } from '../city';
import type { TilePos } from '../commands';
import { fleetIdOfTrip, fleetTripId } from '../fleet';
import { adjacentRoadTowardsFootprint } from '../transport/anchors';
import type { World } from '../world';
import { serviceStations, type ServiceKind } from './stations';

export const SERVICE_VEHICLE_STATES = ['AtStation', 'EnRoute', 'OnScene', 'Returning'] as const;
export type ServiceVehicleState = (typeof SERVICE_VEHICLE_STATES)[number];

export interface ServiceVehicle {
  readonly id: number;
  readonly kind: ServiceKind;
  /** The building of its station; -1 once the station is gone, and the vehicle goes when it is back. */
  station: number;
  /** The road tile it stands on at its station. */
  readonly homeRoad: TilePos;
  state: ServiceVehicleState;
  /** The emergency it is sent to, -1 for none. */
  mission: number;
  /** The road tile it stands on or last set out for. */
  at: TilePos;
}

const TRIP_VEHICLE = { Fire: 'Fire', Police: 'Police', Medical: 'Ambulance' } as const;

/** `v` sets out in meso traffic from where it is to `to`, queued there directly: a drive back may start after traffic ran. */
export function driveService(w: World, v: ServiceVehicle, to: TilePos): void {
  w.mesoTraffic.pending.push({ citizen: fleetTripId(v.id), from: v.at, carParkedAt: v.at, to, purpose: 'Service', mode: 'Car', pocket: true, vehicle: TRIP_VEHICLE[v.kind] });
  v.at = to;
}

/** `v` drives back to its station. */
export function returnToStation(w: World, v: ServiceVehicle): void {
  v.state = 'Returning';
  driveService(w, v, v.homeRoad);
}

function parkAtStation(w: World, v: ServiceVehicle): void {
  if (v.station < 0) {
    w.fleet.services = w.fleet.services.filter((x) => x !== v);
    return;
  }
  v.state = 'AtStation';
  v.mission = -1;
  v.at = v.homeRoad;
}

/**
 * `SimStep::Services`, before the emergencies: a station that opened beside a road gets its vehicles, the vehicles
 * standing at a station that is gone go with it, and a vehicle on the scene of an emergency that is over drives back.
 * Looked at when the buildings or the map change, and once a game minute for a station that opened or lost its road.
 */
export function syncServiceStations(w: World): void {
  const fleet = w.fleet;
  const key = `${w.buildings.version}|${w.mapEditVersion}|${gameMinute(w)}`;
  if (fleet.stationsKey !== key) {
    fleet.stationsKey = key;
    const stations = serviceStations(w);
    const open = new Set(stations.map((s) => s.buildingId));
    fleet.services = fleet.services.filter((v) => {
      if (v.station < 0 || open.has(v.station)) return true;
      if (v.state === 'AtStation') return false;
      v.station = -1;
      return true;
    });
    const equipped = new Set(fleet.services.map((v) => v.station));
    for (const station of stations) {
      if (equipped.has(station.buildingId)) continue;
      const b = w.buildings.get(station.buildingId)!;
      const road = adjacentRoadTowardsFootprint(w.grid, b.anchor, b.width, b.length, b.anchor);
      if (road === undefined) continue;
      for (let i = 0; i < vehicleCapacity(b.kind); i++) {
        fleet.services.push({ id: fleet.takeId(), kind: station.kind, station: b.id, homeRoad: road, state: 'AtStation', mission: -1, at: road });
      }
    }
  }
  for (const v of fleet.services) {
    if (v.state === 'OnScene' && !w.emergencies.active.some((e) => e.id === v.mission)) returnToStation(w, v);
  }
}

/**
 * After traffic, beside `handleRegionalArrivals`: a vehicle that reached an emergency stands on its scene; one that
 * found no way there is back at its station and its station is not asked again; one back from a mission is parked.
 */
export function handleServiceArrivals(w: World): void {
  const events = w.events;
  if (events.tripFinished.length === 0 && events.tripDropped.length === 0) return;
  const settle = (trip: number, reached: boolean) => {
    const id = fleetIdOfTrip(trip);
    const v = id < 0 ? undefined : w.fleet.service(id);
    if (v === undefined) return;
    if (v.state === 'Returning') {
      parkAtStation(w, v);
      return;
    }
    if (v.state !== 'EnRoute') return;
    const emergency = w.emergencies.active.find((e) => e.id === v.mission && !e.resolved && !e.failed);
    if (!reached) {
      if (emergency !== undefined) {
        emergency.triedStations.push(v.station);
        emergency.assignedVehicle = -1;
      }
      parkAtStation(w, v);
      return;
    }
    if (emergency === undefined) {
      returnToStation(w, v);
      return;
    }
    v.state = 'OnScene';
    emergency.responded = true;
    w.notifications.addAt(`${emergency.kind} emergency responded`, 'Info', 3, emergency.pos);
  };
  for (const arrival of events.tripFinished) settle(arrival.citizen, true);
  for (const trip of events.tripDropped) settle(trip, false);
}
