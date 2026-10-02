// Port of bevy_time 0.19.1 `Timer` on integer nanoseconds (Rust `Duration`). Every clock in the
// Rust sim is one of these, so their finish counts must agree tick for tick.

export const SECOND_NS = 1_000_000_000;
const U32_MAX = 0xffff_ffff;

export type TimerMode = 'Once' | 'Repeating';

export class Timer {
  durationNs: number;
  mode: TimerMode;
  elapsedNs = 0;
  finished = false;
  timesFinishedThisTick = 0;
  paused = false;

  constructor(durationNs: number, mode: TimerMode) {
    this.durationNs = durationNs;
    this.mode = mode;
  }

  /** Switching a finished `Once` timer to `Repeating` restarts it. */
  setMode(mode: TimerMode): void {
    if (this.mode !== 'Repeating' && mode === 'Repeating' && this.finished) {
      this.elapsedNs = 0;
      this.finished = this.timesFinishedThisTick > 0;
    }
    this.mode = mode;
  }

  tick(deltaNs: number): void {
    if (this.paused) {
      this.timesFinishedThisTick = 0;
      if (this.mode === 'Repeating') this.finished = false;
      return;
    }
    if (this.mode !== 'Repeating' && this.finished) {
      this.timesFinishedThisTick = 0;
      return;
    }

    this.elapsedNs += deltaNs;
    this.finished = this.elapsedNs >= this.durationNs;

    if (!this.finished) {
      this.timesFinishedThisTick = 0;
    } else if (this.mode === 'Repeating') {
      if (this.durationNs === 0) {
        // `checked_div` / `checked_rem` by zero: u32::MAX finishes, elapsed back to zero.
        this.timesFinishedThisTick = U32_MAX;
        this.elapsedNs = 0;
      } else {
        // `as u32` truncates modulo 2^32, which `>>> 0` reproduces.
        this.timesFinishedThisTick = Math.floor(this.elapsedNs / this.durationNs) >>> 0;
        this.elapsedNs %= this.durationNs;
      }
    } else {
      this.timesFinishedThisTick = 1;
      this.elapsedNs = this.durationNs;
    }
  }

  reset(): void {
    this.elapsedNs = 0;
    this.finished = false;
    this.timesFinishedThisTick = 0;
  }
}
