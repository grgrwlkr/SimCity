import { applyStateTransition, createWorld, requestState, type World } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { FixedStepDriver, MAX_DELTA_MS } from '../src/driver';

function inGame(): World {
  const w = createWorld();
  requestState(w, 'InGame');
  applyStateTransition(w);
  return w;
}

function run(driver: FixedStepDriver, fromMs: number, toMs: number, stepMs: number): number {
  let ticks = 0;
  for (let t = fromMs; t <= toMs; t += stepMs) ticks += driver.update(t);
  return ticks;
}

describe('FixedStepDriver', () => {
  it('runsNoTicksOutsideTheGame', () => {
    const w = createWorld();
    const driver = new FixedStepDriver(w);
    expect(run(driver, 0, 2_000, 16)).toBe(0);
    expect(w.tick).toBe(0);
  });

  it('x1RunsTenTicksPerSecondOfRealTime', () => {
    const w = inGame();
    const driver = new FixedStepDriver(w);
    expect(run(driver, 0, 1_000, 10)).toBe(10);
    expect([w.city.hour, w.city.minute], 'one real second at x1 is one game minute').toEqual([0, 1]);
  });

  // TS: ×2 and ×3 are ten and thirty game minutes a real second (Rust: two and six times ×1), so the speed changes
  // radically.
  it('x2AndX3AreTenAndThirtyGameMinutesASecond', () => {
    for (const [speed, ticks, minutes] of [
      ['X1', 10, 1],
      ['X2', 100, 10],
      ['X3', 300, 30],
    ] as const) {
      const w = inGame();
      const driver = new FixedStepDriver(w);
      driver.speed = speed;
      expect(run(driver, 0, 1_000, 10), `${speed}: ticks in a second`).toBe(ticks);
      expect(w.city.hour * 60 + w.city.minute, `${speed}: game minutes in a second`).toBe(minutes);
      expect(driver.gameMinutesPerSecond(), `${speed}: the rate the HUD shows`).toBe(minutes);
    }
  });

  it('aTickTooDearForTheSpeedTradesTicksForClockTimeButKeepsTheGameRate', () => {
    const w = inGame();
    const driver = new FixedStepDriver(w);
    driver.speed = 'X3';
    // Ten milliseconds a tick: eighty ticks fill the worker's budget of a second.
    driver.tickCostMs = 10;
    expect(run(driver, 0, 1_000, 10), 'as many ticks as the budget affords').toBe(80);
    expect(w.city.hour * 60 + w.city.minute, 'and still thirty game minutes').toBe(30);
    expect(driver.gameMinutesPerSecond()).toBe(30);

    driver.speed = 'X1';
    run(driver, 1_010, 2_000, 10);
    expect(w.clockScale, 'a speed the budget affords runs the clock at its own pace').toBe(1);
  });

  it('realDeltaIsCappedSoAStallIsNotReplayed', () => {
    const driver = new FixedStepDriver(inGame());
    driver.update(0);
    expect(driver.update(60_000), `a 60 s stall counts as ${MAX_DELTA_MS} ms`).toBe(2);
    expect(driver.update(60_050), 'the 50 ms remainder is kept').toBe(1);
  });

  it('pausedSpeedStopsTicksAndKeepsTheRemainder', () => {
    const driver = new FixedStepDriver(inGame());
    driver.update(0);
    expect(driver.update(150)).toBe(1);
    driver.speed = 'Paused';
    expect(run(driver, 166, 2_000, 16)).toBe(0);
    driver.speed = 'X1';
    driver.update(2_016);
    expect(driver.update(2_066), 'the remainder from before the pause still counts').toBe(1);
  });

  it('theStateDecidesAtTheStartOfTheFrame', () => {
    const w = createWorld();
    const driver = new FixedStepDriver(w);
    driver.update(0);
    requestState(w, 'InGame');
    // Virtual time is synced before the transition, so the frame that enters the game runs no tick.
    expect(driver.update(200)).toBe(0);
    expect(w.appState).toBe('InGame');
    expect(driver.update(400)).toBe(2);
  });
});
