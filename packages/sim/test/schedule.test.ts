import { describe, expect, it } from 'vitest';
import { frame, runFixedTick, runsThisTick } from '../src/app';
import { COMMAND_APPLY, FIXED_UPDATE, TICK_HZ, UPDATE_GRAPH } from '../src/schedule';
import { IN_GAME, applyStateTransition, requestState } from '../src/state';
import { SECOND_NS } from '../src/timer';
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
      ['UPDATE_GRAPH', UPDATE_GRAPH],
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
    expect([w.city.hour, w.city.minute, w.city.second], 'the main menu has no running clock').toEqual([0, 0, 0]);

    requestState(w, 'InGame');
    applyStateTransition(w);
    for (let i = 0; i < TICK_HZ; i++) runFixedTick(w);
    expect([w.city.hour, w.city.minute, w.city.second], 'ten fixed ticks are one game second').toEqual([0, 0, 1]);
    expect(w.tick).toBe(2 * TICK_HZ);
  });

  // TS (stage 3½): a system may run at its own rate in game time; a tick with nothing for it costs one check.
  it('systemsRunAtTheirGameRate', () => {
    const minutely = { name: 'minutely', run: () => undefined, runIn: IN_GAME, everyGameNs: 60 * SECOND_NS };
    const w = createWorld();
    let runs = 0;
    for (w.tick = 0; w.tick < 600; w.tick++) if (runsThisTick(w, minutely)) runs += 1;
    expect(runs, 'once in six hundred ticks of a real-time clock').toBe(1);

    const fast = createWorld({ gameHourNs: SECOND_NS });
    runs = 0;
    for (fast.tick = 0; fast.tick < 600; fast.tick++) if (runsThisTick(fast, minutely)) runs += 1;
    expect(runs, 'every tick when a tick carries more than a game minute').toBe(600);

    expect(FIXED_UPDATE.find((s) => s.name === 'citizenTripPlanner')?.everyGameNs, 'citizens plan once a game minute').toBe(60 * SECOND_NS);
  });

  // TS (stage 3½): the worker must not die; a system that throws is logged and skipped, and the tick goes on.
  it('aThrowingSystemDoesNotStopTheWorld', () => {
    const w = createWorld();
    requestState(w, 'InGame');
    applyStateTransition(w);
    w.debugFailSystem = 'updateTrafficIndex';
    const pollutionBefore = w.pollution.version;
    runFixedTick(w);
    runFixedTick(w);
    expect(w.tick, 'the ticks ran').toBe(2);
    expect(w.pollution.version, 'systems after the failing one ran').toBeGreaterThan(pollutionBefore);
    expect(w.systemErrors.get('updateTrafficIndex')).toMatchObject({ system: 'updateTrafficIndex', count: 2, firstTick: 0, lastTick: 1 });
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
