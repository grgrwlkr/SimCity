import { describe, expect, it } from 'vitest';
import { frame, runFixedTick } from '../src/app';
import { COMMAND_APPLY, FIXED_UPDATE, TICK_HZ } from '../src/schedule';
import { applyStateTransition, requestState } from '../src/state';
import { createWorld } from '../src/world';

describe('schedule', () => {
  // Replaces the Bevy ambiguity pins `composed_fixed_update_has_no_ambiguous_system_pairs`
  // (crates/simcity_data/src/game/determinism.rs) and `fixed_update_has_no_ambiguous_system_pairs`
  // (simcity_sim): an array is a total order by construction; what can still break it is a
  // system listed twice.
  it('scheduleIsTotalOrder', () => {
    for (const [label, entries] of [
      ['FIXED_UPDATE', FIXED_UPDATE],
      ['COMMAND_APPLY', COMMAND_APPLY],
    ] as const) {
      const names = entries.map((e) => e.name);
      const runs = entries.map((e) => e.run);
      expect(entries.length, `${label} is empty`).toBeGreaterThan(0);
      expect(new Set(names).size, `${label}: every system name exactly once`).toBe(names.length);
      expect(new Set(runs).size, `${label}: every system function exactly once`).toBe(runs.length);
    }
  });

  it('clockAdvancesOnlyInGame', () => {
    const w = createWorld();
    for (let i = 0; i < TICK_HZ; i++) runFixedTick(w);
    expect(w.city.hour, 'the main menu has no running clock').toBe(0);

    requestState(w, 'InGame');
    applyStateTransition(w);
    for (let i = 0; i < TICK_HZ; i++) runFixedTick(w);
    expect(w.city.hour, 'ten fixed ticks are one game hour').toBe(1);
    expect(w.tick).toBe(2 * TICK_HZ);
  });

  it('startOfGameDayAdvancedIsVisibleToTheFirstTickOnly', () => {
    const w = createWorld();
    requestState(w, 'InGame');
    frame(w, 1);
    expect(w.events.dayAdvanced).toEqual([1]);

    frame(w, 1);
    expect(w.events.dayAdvanced).toEqual([]);
  });

  it('commandsAreDroppedOutsideTheGame', () => {
    const w = createWorld();
    w.commands.push({ kind: 'GenerateMap', seed: 99n });
    frame(w, 0);
    expect(w.mapSeed, 'CommandApply runs only in game or paused').toBe(1n);
    expect(w.commands).toEqual([]);
  });
});
