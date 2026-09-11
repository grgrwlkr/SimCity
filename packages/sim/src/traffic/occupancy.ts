// The part of `TrafficOccupancy` (crates/simcity_sim/src/game/traffic/occupancy.rs) that routing
// reads: vehicles per tile this tick. The occupancy build and the heat EMA arrive with the traffic stage.

export class TrafficOccupancy {
  perTickVehicles = new Uint16Array(0);

  ensureLen(len: number): void {
    if (this.perTickVehicles.length !== len) this.perTickVehicles = new Uint16Array(len);
  }
}
