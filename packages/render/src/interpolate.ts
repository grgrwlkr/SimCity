// The sim publishes frames at 10 Hz and the display draws at its own rate: between two sim frames
// positions move linearly and headings turn the short way round.

const TAU = Math.PI * 2;

export function interpolatePositions(
  prev: Float32Array,
  next: Float32Array,
  alpha: number,
  count: number,
  out: Float32Array,
): void {
  for (let i = 0; i < count; i++) {
    const a = prev[i]!;
    out[i] = a + (next[i]! - a) * alpha;
  }
}

/** Into [-π, π). */
export function wrapAngle(angle: number): number {
  return angle - TAU * Math.floor((angle + Math.PI) / TAU);
}

export function interpolateHeading(from: number, to: number, alpha: number): number {
  return wrapAngle(from + wrapAngle(to - from) * alpha);
}
