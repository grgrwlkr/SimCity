// Frames per second of the draw loop over a sliding one-second window.
const WINDOW_MS = 1000;

export class FpsMeter {
  private readonly stamps: number[] = [];

  /** A frame was drawn at `nowMs`. */
  frame(nowMs: number): void {
    this.stamps.push(nowMs);
    this.trim(nowMs);
  }

  /** Time passed without a frame (a hidden tab, a zero-size canvas): old frames age out. */
  idle(nowMs: number): void {
    this.trim(nowMs);
  }

  get fps(): number {
    const n = this.stamps.length;
    if (n < 2) return 0;
    const span = this.stamps[n - 1]! - this.stamps[0]!;
    return span > 0 ? ((n - 1) * 1000) / span : 0;
  }

  private trim(nowMs: number): void {
    while (this.stamps.length > 0 && nowMs - this.stamps[0]! > WINDOW_MS) this.stamps.shift();
  }
}
