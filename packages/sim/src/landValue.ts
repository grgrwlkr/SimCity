// `LandValueIndex` of crates/simcity_sim/src/game/land_value.rs: land value per tile, 0..1. Computed from
// stage 3b on; until then it is not laid over the map and every tile reads the middle value.
const MIDDLE = Math.fround(0.5);

export class LandValueIndex {
  values = new Float32Array(0);
  /** Bumps once per published chunk. */
  version = 0;

  get(idx: number): number {
    return idx < this.values.length ? this.values[idx]! : MIDDLE;
  }
}
