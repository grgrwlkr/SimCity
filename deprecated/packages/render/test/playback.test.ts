import { describe, expect, it } from 'vitest';
import { PlaybackClock } from '../src/playback';

const FRAME_MS = 1000 / 60;

type Arrival = readonly [ms: number, tick: number];

/** Drives the clock the way the renderer does: a sim frame is noticed on the first display frame after it lands. */
function play(arrivals: readonly Arrival[], untilMs: number): Array<{ ms: number; tick: number; newest: number }> {
  const clock = new PlaybackClock();
  const samples: Array<{ ms: number; tick: number; newest: number }> = [];
  let next = 0;
  let newest = NaN;
  for (let frame = 0; frame * FRAME_MS <= untilMs; frame++) {
    const ms = frame * FRAME_MS;
    while (next < arrivals.length && arrivals[next]![0] <= ms) {
      newest = arrivals[next]![1];
      clock.arrive(newest, ms);
      next += 1;
    }
    samples.push({ ms, tick: clock.advance(ms), newest });
  }
  return samples;
}

/** Ticks the display moved per frame from `fromMs` on. */
function steps(samples: ReturnType<typeof play>, fromMs: number): number[] {
  const s = samples.filter((x) => x.ms >= fromMs);
  return s.slice(1).map((x, i) => x.tick - s[i]!.tick);
}

function expectSteadyPace(stepsPerFrame: number[], expected: number): void {
  const worst = stepsPerFrame.reduce((w, s) => Math.max(w, Math.abs(s / expected - 1)), 0);
  expect(worst, `the pace strays ${(worst * 100).toFixed(0)}% from ${expected.toFixed(3)} ticks a frame`).toBeLessThan(0.4);
}

describe('playback clock', () => {
  it('theFirstFrameIsShownAtOnce', () => {
    const clock = new PlaybackClock();
    expect(clock.advance(0)).toBeNaN();
    clock.arrive(42, 5);
    expect(clock.advance(5)).toBe(42);
  });

  it('aSteadyStreamPlaysAtItsOwnPaceJustBehindTheNewestFrame', () => {
    const samples = play(Array.from({ length: 50 }, (_, k) => [k * 100, k] as const), 4900);
    expectSteadyPace(steps(samples, 1500), FRAME_MS / 100);
    for (const s of samples.filter((x) => x.ms >= 1500)) {
      expect(s.tick).toBeLessThanOrEqual(s.newest);
      expect(s.newest - s.tick).toBeLessThan(3);
    }
  });

  it('jitteryArrivalsStillPlayAtASteadyPace', () => {
    // ×1 in the city: frames land 66 or 133 ms apart, one tick each.
    const arrivals: Arrival[] = [];
    for (let k = 0, ms = 0; k < 50; k++, ms += k % 2 === 0 ? 66 : 133) arrivals.push([ms, k]);
    const samples = play(arrivals, arrivals.at(-1)![0]);
    const pace = steps(samples, 1500);
    expect(Math.min(...pace), 'never runs backwards or stalls').toBeGreaterThan(0);
    expectSteadyPace(pace, FRAME_MS / 99.5);
  });

  it('burstsOfSeveralTicksPlayEvenly', () => {
    // ×3: a frame every 50 ms carrying three 16.7 ms ticks, so the display owes one tick a frame.
    const samples = play(Array.from({ length: 100 }, (_, k) => [k * 50, k * 3] as const), 4950);
    expectSteadyPace(steps(samples, 1500), 1);
  });

  it('speedingUpCatchesUpWithinASecond', () => {
    const arrivals: Arrival[] = Array.from({ length: 20 }, (_, k) => [k * 100, k] as const);
    for (let k = 1; k <= 60; k++) arrivals.push([1900 + k * 50, 19 + k * 3]);
    const samples = play(arrivals, 4900);
    for (const s of samples.filter((x) => x.ms >= 3000)) expect(s.newest - s.tick).toBeLessThan(8);
    expectSteadyPace(steps(samples, 3200), 1);
  });

  it('withoutNewFramesTheNewestIsHeld', () => {
    const samples = play(Array.from({ length: 21 }, (_, k) => [k * 100, k] as const), 4000);
    for (const s of samples.filter((x) => x.ms >= 2600)) expect(s.tick).toBe(20);
  });

  it('aRepublishedTickOrAFrameAfterALongPauseIsShownAtOnce', () => {
    const clock = new PlaybackClock();
    for (let k = 0; k <= 20; k++) {
      clock.arrive(k, k * 100);
      clock.advance(k * 100);
    }
    // Debug placement republishes the same tick with other vehicles: nothing to play towards.
    expect(clock.arrive(20, 2010)).toBe(true);
    expect(clock.advance(2010)).toBe(20);
    // A step while paused lands long after the last frame.
    expect(clock.arrive(21, 6000)).toBe(true);
    expect(clock.advance(6000)).toBe(21);
    expect(clock.arrive(22, 6100)).toBe(false);
  });
});
