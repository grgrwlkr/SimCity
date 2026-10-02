// The worker's side of `setClock` (E3): the hour written straight into the world instead of running the simulation until
// it gets there. Carries the clock half of rust-final crates/simcity_debug/src/game/live/control.rs (`simcity/sim`
// with `hour` and `day`); speed and exact stepping are `setSpeed` and `step`, which the port already had.
import { CITIZEN_STATES, MetropolisScenario, SECOND_NS, TRIP_PURPOSES, createWorld, fingerprint, frame, gameMinute, requestState, step, toHex64, type World } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { CLOCK_JUMP_SPREAD_MINUTES, setClock } from '../src/requests/clock';

/** A game hour of ten ticks, so a test runs hours in a hurry. */
const HOUR_NS = SECOND_NS;

function world(): World {
  const w = createWorld({ mapWidth: 16, mapHeight: 16, gameHourNs: HOUR_NS });
  requestState(w, 'InGame');
  step(w, 1);
  return w;
}

/** A lived-in metropolis at 6:05, the morning under way. */
function cityAtSix(): World {
  const w = createWorld({ mapWidth: 160, mapHeight: 160 });
  requestState(w, 'InGame');
  new MetropolisScenario(w);
  frame(w, 0);
  step(w, 3000);
  return w;
}

/** The same metropolis with a game hour of a real minute, so a test lives two game hours in 1 200 ticks. */
function shortCityAtSix(): World {
  const w = createWorld({ mapWidth: 160, mapHeight: 160, gameHourNs: 60 * SECOND_NS });
  requestState(w, 'InGame');
  new MetropolisScenario(w);
  frame(w, 0);
  step(w, 50);
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

  /**
   * A jump does not replay the skipped time in one tick: on the metropolis a jump from 6:05 to noon woke 2.2 million moves
   * in the next tick. What came due is re-planned from the new time instead — nothing is left due in the past, a tour
   * missed by more than an hour is dropped (the citizen stays home), and the rest wake no faster than the morning did.
   */
  it('aJumpReplansTheSkippedTimeInsteadOfReplayingIt', () => {
    const plain = cityAtSix();
    const jumped = cityAtSix();
    const c = jumped.citizens;
    const missed = [...Array(c.highWater).keys()].find(
      (s) => c.alive[s] === 1 && c.state[s] === CITIZEN_STATES.indexOf('AtHome') && c.nextPurpose[s] === TRIP_PURPOSES.indexOf('Work'),
    )!;
    expect(missed, 'a commuter still at home at 6:05').toBeDefined();
    setClock(jumped, { hour: 12 });
    const now = gameMinute(jumped);
    for (let s = 0; s < c.highWater; s++) if (c.alive[s] === 1 && c.nextAt[s]! >= 0) expect(c.nextAt[s]!, `citizen ${s}`).toBeGreaterThanOrEqual(now);
    const r = jumped.regional;
    for (let s = 0; s < r.highWater; s++) if (r.alive[s] === 1 && r.nextAt[s]! >= 0) expect(r.nextAt[s]!, `regional ${s}`).toBeGreaterThanOrEqual(now);
    expect(c.state[missed], 'the missed commute: at home').toBe(CITIZEN_STATES.indexOf('AtHome'));
    expect(c.nextPurpose[missed], 'the day re-planned, not the tour replayed').toBe(-1);
    expect(c.nextAt[missed]!).toBeLessThanOrEqual(now + CLOCK_JUMP_SPREAD_MINUTES);

    const run = (w: World) => {
      let woken = 0;
      for (let i = 0; i < 1800; i++) {
        step(w, 1);
        woken = Math.max(woken, w.citizens.plannerWoken);
      }
      return { woken, pending: w.mesoTraffic.pending.length, onRoad: w.mesoTraffic.carCount() };
    };
    const [before, after] = [run(plain), run(jumped)];
    expect(after.woken, `woken a minute: ${after.woken} after the jump, ${before.woken} at 6:05`).toBeLessThanOrEqual(2 * before.woken);
    expect(after.pending + after.onRoad, `trips: ${JSON.stringify(after)} against ${JSON.stringify(before)}`).toBeLessThanOrEqual(2 * (before.pending + before.onRoad) + 50);
  }, 120_000);

  /**
   * A jump into the next day plans that day from the new time: before dawn the region's whole day is ahead (commuters
   * 6–9, trucks 6–16, shipments 8–18, packages/sim regional.ts), at noon the commuters' window is gone and the freight's
   * is not. Citizens whose day moved plan the new day's agenda.
   */
  it('aJumpIntoTheNextDayPlansThatDayFromTheNewTime', () => {
    const kinds = (w: World) => {
      const r = w.regional;
      const n = [0, 0, 0, 0, 0, 0];
      for (let s = 0; s < r.highWater; s++) if (r.alive[s] === 1) n[r.kind[s]!]! += 1;
      return { commuters: n[0]!, deliveries: n[3]!, supply: n[4]!, shipments: n[5]! };
    };
    const dawn = shortCityAtSix();
    const dayOne = kinds(dawn);
    const c = dawn.citizens;
    const home = [...Array(c.highWater).keys()].find((s) => c.alive[s] === 1 && c.agendaDay[s] === 1 && c.state[s] === CITIZEN_STATES.indexOf('AtHome'))!;
    expect(home, 'a citizen at home with the agenda of day 1').toBeDefined();
    setClock(dawn, { hour: 5 });
    step(dawn, 10);
    expect([dawn.city.day, dawn.city.hour]).toEqual([2, 5]);
    const beforeDawn = kinds(dawn);
    expect(beforeDawn.commuters, `day 2 at 5:00 ${JSON.stringify(beforeDawn)}, day 1 ${JSON.stringify(dayOne)}`).toBeGreaterThan(dayOne.commuters / 2);
    for (const kind of ['deliveries', 'supply', 'shipments'] as const) expect(beforeDawn[kind], kind).toBeGreaterThan(0);
    step(dawn, 1300);
    expect(c.agendaDay[home], 'the moved day re-plans its agenda').toBe(2);

    const noon = shortCityAtSix();
    setClock(noon, { hour: 12, day: 2 });
    step(noon, 10);
    const atNoon = kinds(noon);
    expect(atNoon.commuters, `the 6–9 commute is past at noon: ${JSON.stringify(atNoon)}`).toBeLessThan(beforeDawn.commuters / 4);
    expect(atNoon.shipments, 'shipments leave until 18').toBeGreaterThan(0);
    const r = noon.regional;
    const now = gameMinute(noon);
    for (let s = 0; s < r.highWater; s++) if (r.alive[s] === 1 && r.nextAt[s]! >= 0) expect(r.nextAt[s]!, `regional ${s}`).toBeGreaterThanOrEqual(now);
  }, 120_000);

  /** The same call on the same lived-in world is the same world: setClock is a debugging aid that must not break replays. */
  it('setClockIsDeterministic', () => {
    const run = () => {
      const w = cityAtSix();
      setClock(w, { hour: 18, day: 2 });
      step(w, 1200);
      return toHex64(fingerprint(w));
    };
    expect(run()).toBe(run());
  }, 120_000);
});
