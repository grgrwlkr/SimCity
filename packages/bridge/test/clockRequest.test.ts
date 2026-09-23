// The worker's side of `setClock` (E3): the hour written straight into the world instead of running the simulation until
// it gets there. Carries the clock half of rust-final crates/simcity_debug/src/game/live/control.rs (`simcity/sim`
// with `hour` and `day`); speed and exact stepping are `setSpeed` and `step`, which the port already had.
import { SECOND_NS, createWorld, fingerprint, requestState, step, toHex64, type World } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { setClock } from '../src/requests/clock';

/** A game hour of ten ticks, so a test runs hours in a hurry. */
const HOUR_NS = SECOND_NS;

function world(): World {
  const w = createWorld({ mapWidth: 16, mapHeight: 16, gameHourNs: HOUR_NS });
  requestState(w, 'InGame');
  step(w, 1);
  return w;
}

describe('clock request', () => {
  /** The hour is set, not waited for: a noon frame costs one call instead of half a day at speed. */
  it('aSimRequestReadsSpeedClockAndStep', () => {
    const w = world();
    const reply = setClock(w, { hour: 22, day: 7 });
    expect(reply).toEqual({ day: 7, hour: 22, minute: 0, tick: w.tick });
    expect([w.city.day, w.city.hour, w.city.minute, w.city.second]).toEqual([7, 22, 0, 0]);
  });

  it('theDayStaysWhenTheHourIsStillAhead', () => {
    const w = world();
    setClock(w, { hour: 12 });
    expect([w.city.day, w.city.hour]).toEqual([1, 12]);
  });

  /**
   * The clock only runs forward. Citizens wait in buckets by game minute: a clock set back would hold every one of them
   * until it caught up again, so an hour already past means that hour tomorrow, and an explicit moment in the past is
   * refused. (Rust wrote any hour; the TS queue makes going back a stall.)
   */
  it('anHourAlreadyPastIsThatHourTomorrow', () => {
    const w = world();
    setClock(w, { hour: 14 });
    step(w, 3);
    setClock(w, { hour: 9 });
    expect([w.city.day, w.city.hour, w.city.minute]).toEqual([2, 9, 0]);
    // The hour the clock stands on, minute zero: already there, nothing moves.
    setClock(w, { hour: 9 });
    expect([w.city.day, w.city.hour]).toEqual([2, 9]);
    expect(() => setClock(w, { hour: 12, day: 1 })).toThrow(/forward/);
    expect([w.city.day, w.city.hour], 'a refused moment leaves the clock alone').toEqual([2, 9]);
  });

  it('aSimRequestRefusesAnHourThatIsNotOnTheClock', () => {
    const w = world();
    for (const hour of [24, -1, 7.5, Number.NaN, '12' as unknown as number]) {
      expect(() => setClock(w, { hour }), String(hour)).toThrow(/`hour`/);
    }
    for (const day of [0, 1.5, 'two' as unknown as number]) {
      expect(() => setClock(w, { hour: 3, day }), String(day)).toThrow(/`day`/);
    }
    expect([w.city.day, w.city.hour], 'nothing refused reached the clock').toEqual([1, 0]);
  });

  /** From the moment set, the hour runs as it always does: the next one comes a full game hour later. */
  it('theClockRunsOnFromTheSetMoment', () => {
    const w = world();
    step(w, 4);
    setClock(w, { hour: 6 });
    step(w, 9);
    expect(w.city.hour, 'nine tenths of an hour later').toBe(6);
    step(w, 1);
    expect([w.city.hour, w.city.minute]).toEqual([7, 0]);
  });

  /** The same call on the same world is the same world: setClock is a debugging aid that must not break replays. */
  it('setClockIsDeterministic', () => {
    const run = () => {
      const w = world();
      step(w, 7);
      setClock(w, { hour: 18, day: 3 });
      step(w, 25);
      return toHex64(fingerprint(w));
    };
    expect(run()).toBe(run());
  });
});
