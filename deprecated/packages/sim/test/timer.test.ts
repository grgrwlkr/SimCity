// Semantics of bevy_time 0.19.1 `Timer::tick` / `reset`, which the Rust sim clocks run on.
import { describe, expect, it } from 'vitest';
import { SECOND_NS, Timer } from '../src/timer';

const MS = 1_000_000;

describe('Timer', () => {
  it('repeatingTimerFinishesOnceWhenElapsedReachesDuration', () => {
    const t = new Timer(SECOND_NS, 'Repeating');
    for (let i = 0; i < 9; i++) {
      t.tick(100 * MS);
      expect(t.timesFinishedThisTick).toBe(0);
    }
    t.tick(100 * MS);
    expect(t.timesFinishedThisTick).toBe(1);
    expect(t.elapsedNs).toBe(0);
    expect(t.finished).toBe(true);
  });

  it('repeatingTimerCountsEveryDurationInOneTickAndKeepsTheRemainder', () => {
    const t = new Timer(SECOND_NS, 'Repeating');
    t.tick(2_500 * MS);
    expect(t.timesFinishedThisTick).toBe(2);
    expect(t.elapsedNs).toBe(500 * MS);
    t.tick(100 * MS);
    expect(t.timesFinishedThisTick).toBe(0);
    expect(t.finished).toBe(false);
  });

  it('onceTimerClampsToDurationAndStopsCounting', () => {
    const t = new Timer(SECOND_NS, 'Once');
    t.tick(1_700 * MS);
    expect(t.timesFinishedThisTick).toBe(1);
    expect(t.elapsedNs).toBe(SECOND_NS);
    t.tick(100 * MS);
    expect(t.timesFinishedThisTick).toBe(0);
    expect(t.finished).toBe(true);
  });

  it('resetClearsElapsedAndFinished', () => {
    const t = new Timer(SECOND_NS, 'Once');
    t.tick(SECOND_NS);
    t.reset();
    expect(t.elapsedNs).toBe(0);
    expect(t.finished).toBe(false);
    expect(t.timesFinishedThisTick).toBe(0);
  });

  it('pausedTimerDoesNotAdvance', () => {
    const t = new Timer(SECOND_NS, 'Repeating');
    t.tick(300 * MS);
    t.paused = true;
    t.tick(SECOND_NS);
    expect(t.elapsedNs).toBe(300 * MS);
    expect(t.timesFinishedThisTick).toBe(0);
  });
});
