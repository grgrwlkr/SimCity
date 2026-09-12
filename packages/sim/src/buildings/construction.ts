// Port of crates/simcity_sim/src/game/buildings/construction.rs: a building under construction opens after its days (GDD 10.3.3).
import type { World } from '../world';

/** `update_construction_progress`, once per advanced day. */
export function updateConstructionProgress(w: World): void {
  for (let day = 0; day < w.events.dayAdvanced.length; day++) {
    for (const b of w.buildings.all()) {
      if (b.phase.kind !== 'UnderConstruction') continue;
      const left = Math.max(b.phase.daysRemaining - 1, 0);
      b.phase = left === 0 ? { kind: 'Operational' } : { kind: 'UnderConstruction', daysRemaining: left };
    }
  }
}
