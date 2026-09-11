// Per-game random streams. Rust: `seed_sim_rng_from_map` / `reset_sim_rng_on_new_map` (sim.rs) and
// `seed_growth_rng_from_map` / `reset_growth_rng_on_new_map` (buildings/growth.rs). Both streams are
// independent `StdRng`s seeded with the same map seed.
import type { GameCommand } from './commands';
import { stdRngSeedFromU64 } from './rng';
import type { World } from './world';

export function seedSimRngFromMap(w: World): void {
  w.simRng = stdRngSeedFromU64(w.mapSeed);
}

export function seedGrowthRngFromMap(w: World): void {
  w.growthRng = stdRngSeedFromU64(w.mapSeed);
}

/** Re-seed the sim stream for every `GenerateMap` in the frame, from the seed `applyMapSeed` wrote. */
export function resetSimRngOnNewMap(w: World, commands: readonly GameCommand[]): void {
  for (const cmd of commands) {
    if (cmd.kind === 'GenerateMap') seedSimRngFromMap(w);
  }
}

export function resetGrowthRngOnNewMap(w: World, commands: readonly GameCommand[]): void {
  for (const cmd of commands) {
    if (cmd.kind === 'GenerateMap') seedGrowthRngFromMap(w);
  }
}
