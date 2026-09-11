// The map side of `apply_game_commands_to_grid` (crates/simcity_sim/src/game/map/commands.rs).
// Stage 0 carries the part every later system depends on: `GenerateMap` sets the map seed.
// Grid generation and tile edits join here with the map stage.
import type { GameCommand } from './commands';
import type { World } from './world';

export function applyMapSeed(w: World, commands: readonly GameCommand[]): void {
  for (const cmd of commands) {
    if (cmd.kind === 'GenerateMap') w.mapSeed = BigInt.asUintN(64, cmd.seed);
  }
}
