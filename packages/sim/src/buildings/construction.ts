// Port of crates/simcity_sim/src/game/buildings/construction.rs: a building under construction opens after its time
// (GDD 10.3.3), counted in game hours from stage 3½ on (Rust: days).
import type { World } from '../world';

/** `update_construction_progress`, once per advanced hour. */
export function updateConstructionProgress(w: World): void {
  for (let hour = 0; hour < w.events.hourAdvanced.length; hour++) {
    for (const b of w.buildings.all()) {
      if (b.phase.kind !== 'UnderConstruction') continue;
      const left = Math.max(b.phase.hoursRemaining - 1, 0);
      b.phase = left === 0 ? { kind: 'Operational' } : { kind: 'UnderConstruction', hoursRemaining: left };
    }
  }
}
