// Port of crates/simcity_sim/src/game/traffic/vehicle_seq.rs: every vehicle gets a number in the
// order it entered the city; ties between vehicles are broken on it, never on the slot.
import type { World } from '../world';

/** `assign_vehicle_seq` (`Added<Vehicle>`): numbers the vehicles spawned since the last run that have none. */
export function assignVehicleSeq(w: World): void {
  const v = w.vehicles;
  for (const slot of v.order) {
    if (v.seqPending[slot] === 0) continue;
    v.seqPending[slot] = 0;
    if (v.seq[slot] !== 0) continue;
    w.vehicleSeq += 1;
    v.seq[slot] = w.vehicleSeq;
  }
}
