// Traffic teardown: `cleanup_traffic_entities`, `reset_traffic_aggregates` and
// `reset_intersection_reservations` on entering the main menu, `clear_vehicles` on GenerateMap.
import type { GameCommand } from '../commands';
import type { World } from '../world';
import { emptyTrafficIndex } from './occupancy';
import { despawnVehicle, vehicleRef } from './vehicles';

function despawnAllVehicles(w: World): void {
  const v = w.vehicles;
  for (const slot of [...v.order]) despawnVehicle(w, vehicleRef(v, slot));
}

function resetTrafficAggregates(w: World): void {
  const occ = w.trafficOccupancy;
  occ.perTickVehicles = new Uint16Array(0);
  occ.touched = [];
  occ.emaScaled = new Float32Array(0);
  occ.emaGlobal = 1;
  occ.maxScaled = 0;
  Object.assign(w.trafficIndex, emptyTrafficIndex());
}

/** OnEnter(MainMenu), TrafficPlugin. */
export function teardownTraffic(w: World): void {
  despawnAllVehicles(w);
  resetTrafficAggregates(w);
  w.reservations.reset();
}

/** `clear_vehicles` (CommandApply): a regenerated map starts without traffic. */
export function clearVehicles(w: World, commands: readonly GameCommand[]): void {
  for (const cmd of commands) {
    if (cmd.kind !== 'GenerateMap') continue;
    despawnAllVehicles(w);
    resetTrafficAggregates(w);
    // Full reset: ledger holders are released only through dropped rows, so leftovers would keep
    // despawned vehicles' mask bits refusing conflicting maneuvers until the next graph version.
    w.reservations.reset();
  }
}
