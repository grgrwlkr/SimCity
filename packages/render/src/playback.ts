// Which sim time the display draws. Sim frames reach the main thread unevenly: at ×1 they land 66 to
// 133 ms apart, at ×3 every 50 ms carrying several ticks. Drawing each new frame from the moment it
// lands turns that unevenness into jumps and stalls, so the display runs its own clock instead: it
// advances at the measured ticks per millisecond, a little behind the newest frame, and is nudged
// towards that target rather than reset to it.

/** A frame after a longer silence (a pause, a step while paused, a hidden tab) is shown as is. */
const RESYNC_GAP_MS = 1000;
/** Weight of the newest arrival in the rate and gap averages. */
const SMOOTHING = 0.15;
/** How fast the clock closes the distance to its target. */
const CORRECTION_MS = 250;
const MAX_DELAY_MS = 400;

export class PlaybackClock {
  private newestTick = NaN;
  private newestMs = NaN;
  private gapMs = NaN;
  private gapDevMs = 0;
  private ticksPerArrival = NaN;
  private display = NaN;
  private displayMs = NaN;

  /**
   * A sim frame of `tick` became readable at `nowMs`. Returns true when the clock resynced to it: the
   * tick did not move forward or came after a long silence, and older frames no longer lead to it.
   */
  arrive(tick: number, nowMs: number): boolean {
    const gap = nowMs - this.newestMs;
    const resync = !(tick > this.newestTick && gap <= RESYNC_GAP_MS);
    if (resync) {
      this.display = tick;
      this.displayMs = nowMs;
    } else if (Number.isNaN(this.gapMs)) {
      this.gapMs = gap;
      this.ticksPerArrival = tick - this.newestTick;
    } else {
      this.gapDevMs += (Math.abs(gap - this.gapMs) - this.gapDevMs) * SMOOTHING;
      this.gapMs += (gap - this.gapMs) * SMOOTHING;
      this.ticksPerArrival += (tick - this.newestTick - this.ticksPerArrival) * SMOOTHING;
    }
    this.newestTick = tick;
    this.newestMs = nowMs;
    return resync;
  }

  /** The tick to draw at `nowMs`: never earlier than the last one, never past the newest frame; NaN before any frame. */
  advance(nowMs: number): number {
    if (!Number.isNaN(this.gapMs)) {
      const msPerTick = this.gapMs / this.ticksPerArrival;
      // Behind the newest frame by a typical gap and its spread, so the next frame usually lands first.
      const delayMs = Math.min(this.gapMs + 2 * this.gapDevMs, MAX_DELAY_MS);
      const target = this.newestTick + (nowMs - this.newestMs - delayMs) / msPerTick;
      const elapsed = nowMs - this.displayMs;
      const natural = this.display + elapsed / msPerTick;
      const next = natural + (target - natural) * Math.min(elapsed / CORRECTION_MS, 1);
      this.display = Math.min(Math.max(next, this.display), this.newestTick);
    }
    this.displayMs = nowMs;
    return this.display;
  }
}
