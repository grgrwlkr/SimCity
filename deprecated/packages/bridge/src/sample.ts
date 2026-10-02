// Stage 3½d: at ×60 and above a frame shows a sample of the driving cars. A car is in the sample by a hash of its render id,
// so it stays in from one frame to the next while the number of cars drifts; the road load colours show the rest.

/** Driving cars a fast frame holds at most. */
export const SAMPLE_CARS = 2000;

const HASH = 0x9e37_79b1;
const SPAN = 2 ** 32;

/** The share of the hash space a sample of `cap` cars out of `count` takes, a little under, so the cap is rarely what stops it. */
export function sampleCutoff(count: number, cap: number): number {
  return count <= cap ? SPAN : Math.floor(((0.95 * cap) / count) * SPAN);
}

export function sampled(id: number, cutoff: number): boolean {
  return cutoff >= SPAN || Math.imul(id, HASH) >>> 0 < cutoff;
}
