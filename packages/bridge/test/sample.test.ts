// Stage 3½d: at ×60 and above a frame holds a sample of the driving cars, the same cars from one frame to the next.
import { describe, expect, it } from 'vitest';
import { SAMPLE_CARS, sampleCutoff, sampled } from '../src/sample';

/** The ids a publish of `ids` keeps: those the hash lets through, no more than the cap. */
function take(ids: readonly number[]): Set<number> {
  const cutoff = sampleCutoff(ids.length, SAMPLE_CARS);
  const kept = new Set<number>();
  for (const id of ids) {
    if (kept.size >= SAMPLE_CARS) break;
    if (sampled(id, cutoff)) kept.add(id);
  }
  return kept;
}

describe('car sample', () => {
  it('aSampleKeepsItsCarsAsTheCountDrifts', () => {
    const ids = Array.from({ length: 10_500 }, (_, i) => 4096 + 3 * i);
    const before = take(ids.slice(0, 10_000));
    expect(before.size, 'close to the cap').toBeGreaterThan(0.9 * SAMPLE_CARS);
    expect(before.size).toBeLessThanOrEqual(SAMPLE_CARS);
    const after = take(ids);
    const stayed = [...before].filter((id) => after.has(id)).length;
    expect(stayed / before.size, `${stayed} of ${before.size} stayed`).toBeGreaterThanOrEqual(0.9);
  });

  it('fewerCarsThanTheCapAreAllKept', () => {
    const ids = Array.from({ length: 1500 }, (_, i) => i * 7);
    expect(take(ids).size).toBe(1500);
  });
});
