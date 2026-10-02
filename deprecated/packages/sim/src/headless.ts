// Shared headless driving for the determinism pins, the bench and the oracle
// (Rust: crates/simcity_data/src/game/headless_sim.rs). Tick with `step` from app.ts.
import { frame } from './app';
import { stdRngSeedFromU64 } from './rng';
import { requestState } from './state';
import { createWorld, type World } from './world';

/**
 * A world driven from the main menu into a game, through the same transition a player takes.
 * Stage 0 has no map; the test city is loaded here once the map stage brings it.
 */
export function buildHeadlessGame(): World {
  const w = createWorld();
  frame(w, 0);
  requestState(w, 'InGame');
  frame(w, 0);
  return w;
}

/** Re-seed every sim-side stream: makes the seed an explicit input of a pin. */
export function reseed(w: World, seed: bigint): void {
  w.simRng = stdRngSeedFromU64(seed);
  w.growthRng = stdRngSeedFromU64(seed);
}
