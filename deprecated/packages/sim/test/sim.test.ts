// Ported from crates/simcity_sim/src/game/sim.rs (mods sim_rng_tests and pause_preserves_game_tests).
// The two pure stream tests of sim_rng_tests live in rng.test.ts.
import { describe, expect, it } from 'vitest';
import { frame } from '../src/app';
import { simTick } from '../src/city';
import { stdRngSeedFromU64, type StdRng } from '../src/rng';
import { applyStateTransition, requestState, type AppState } from '../src/state';
import { SECOND_NS } from '../src/timer';
import { createWorld, type World } from '../src/world';

const draw = (rng: StdRng, n: number): bigint[] => Array.from({ length: n }, () => rng.nextU64());

function go(w: World, next: AppState): void {
  requestState(w, next);
  applyStateTransition(w);
}

describe('sim_rng_tests', () => {
  it('seedSimRngFromMapUsesMapSeed', () => {
    const w = createWorld();
    w.mapSeed = 424242n;
    go(w, 'InGame');

    const expected = draw(stdRngSeedFromU64(424242n), 16);
    expect(draw(w.simRng, 16), 'entering a game must re-seed from the map seed').toEqual(expected);
  });

  it('resetSimRngOnNewMapReseeds', () => {
    const w = createWorld();
    w.mapSeed = 7n;
    go(w, 'InGame');

    // Burn the stream, then fire GenerateMap to force a re-seed.
    w.simRng.nextU64();
    w.commands.push({ kind: 'GenerateMap', seed: 7n });
    frame(w, 0);

    expect(w.simRng.nextU64()).toBe(stdRngSeedFromU64(7n).nextU64());
  });
});

// TS (stage 3½): a game second is a real second at ×1, so a car at 40 km/h covers 40 km in a real hour; the speed ladder
// runs more ticks, never more game time a tick. A test world may run a faster clock.
describe('game clock', () => {
  const TICK_NS = SECOND_NS / 10;

  it('x1IsRealTime', () => {
    const w = createWorld();
    expect(w.gameHourNs, 'a game hour is a real hour').toBe(3600 * SECOND_NS);
    for (let i = 0; i < 10; i++) simTick(w, TICK_NS);
    expect([w.city.hour, w.city.minute, w.city.second], 'ten ticks are a game second').toEqual([0, 0, 1]);
    for (let i = 10; i < 600; i++) simTick(w, TICK_NS);
    expect([w.city.hour, w.city.minute, w.city.second], 'six hundred ticks are a minute').toEqual([0, 1, 0]);
    for (let i = 600; i < 36_000; i++) simTick(w, TICK_NS);
    expect([w.city.hour, w.city.minute, w.city.second], 'thirty-six thousand ticks are an hour').toEqual([1, 0, 0]);
    expect(w.events.hourAdvanced).toEqual([{ hour: 1, day: 1 }]);
  });

  it('aWorldMayRunAFasterClock', () => {
    const w = createWorld({ gameHourNs: SECOND_NS });
    for (let i = 0; i < 10; i++) simTick(w, TICK_NS);
    expect([w.city.hour, w.city.minute, w.city.second]).toEqual([1, 0, 0]);
  });
});

/**
 * Pause must not be a new game. `Paused` exits `InGame`, so anything hung on entering `InGame`
 * would re-run on resume and hand the player a fresh treasury, a rewound calendar and a
 * restarted random stream.
 */
describe('pause_preserves_game_tests', () => {
  const SEED = 7n;

  function startedGame(): World {
    const w = createWorld();
    w.mapSeed = SEED;
    go(w, 'InGame');
    return w;
  }

  it('pauseRoundTripKeepsCity', () => {
    const w = startedGame();
    w.city.money = 1_234;
    w.city.day = 9;
    w.city.hour = 15;
    w.city.population = 42;
    w.city.happiness = 0.75;

    go(w, 'Paused');
    go(w, 'InGame');

    expect(w.city.money, 'pause must not refund the treasury').toBe(1_234);
    expect(w.city.day, 'pause must not rewind the calendar').toBe(9);
    expect(w.city.hour, 'pause must not rewind the clock').toBe(15);
    expect(w.city.population, 'pause must not erase the population').toBe(42);
    expect(w.city.happiness, 'pause must not reset happiness').toBe(0.75);
  });

  it('pauseRoundTripDoesNotRestartRandomStreams', () => {
    const w = startedGame();
    const simBefore = draw(w.simRng, 4);
    const growthBefore = draw(w.growthRng, 4);

    go(w, 'Paused');
    go(w, 'InGame');

    const simAfter = draw(w.simRng, 4);
    const growthAfter = draw(w.growthRng, 4);
    const expected = draw(stdRngSeedFromU64(SEED), 8);

    expect(simBefore, 'entering a game must seed the sim stream from the map seed').toEqual(expected.slice(0, 4));
    expect(simAfter, 'pause must not restart the sim random stream').toEqual(expected.slice(4));
    expect(growthBefore, 'entering a game must seed the growth stream from the map seed').toEqual(expected.slice(0, 4));
    expect(growthAfter, 'pause must not restart the building growth stream').toEqual(expected.slice(4));
  });

  /** The feed dates an event with the day the clock has reached, even when the day turned inside the same update. */
  it('advisorFeedFollowsTheClockAcrossADayInOneUpdate', () => {
    const w = createWorld();
    w.city.day = 3;
    w.city.hour = 23;

    simTick(w, w.gameHourNs);
    expect(w.city.day, 'the clock crossed midnight').toBe(4);

    w.notifications.add('Fire emergency', 'Warning', 5);
    expect(w.notifications.history().at(-1)?.day).toBe(4);
  });

  it('pauseRoundTripKeepsBuildingUpgradeClock', () => {
    const w = startedGame();
    w.buildingUpgradeClock.tick(500_000_000);
    const elapsed = w.buildingUpgradeClock.elapsedNs;
    expect(elapsed, 'test setup must advance the clock').toBeGreaterThan(0);

    go(w, 'Paused');
    go(w, 'InGame');

    expect(w.buildingUpgradeClock.elapsedNs, 'pause must not rewind the building upgrade clock').toBe(elapsed);
  });
});
