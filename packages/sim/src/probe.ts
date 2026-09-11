// Diagnostics that stay cheap enough to run as pins: where two runs first part, and whether an
// engine computes the RNG samplers the way Node does.
import { step } from './app';
import { Fnv64, fingerprintSections, toHex64 } from './fingerprint';
import {
  chooseIndex,
  randomBool,
  rangeF32,
  rangeF64,
  rangeI32,
  rangeU32,
  rangeU64Inclusive,
  shuffle,
  stdRngSeedFromU64,
} from './rng';
import type { World } from './world';

export interface Divergence {
  readonly tick: number;
  readonly sections: readonly string[];
}

/**
 * Steps both worlds one frame at a time and reports the first tick whose fingerprint sections
 * differ (Rust: `probe_first_divergence_tick`). `perturb` runs before each tick, for pinning the probe itself.
 */
export function firstDivergence(
  a: World,
  b: World,
  ticks: number,
  perturb?: (tick: number, a: World, b: World) => void,
): Divergence | null {
  for (let tick = 0; tick < ticks; tick++) {
    perturb?.(tick, a, b);
    step(a, 1);
    step(b, 1);
    const left = fingerprintSections(a);
    const right = fingerprintSections(b);
    const sections = left.filter((s, i) => s.digest !== right[i]!.digest).map((s) => s.name);
    if (sections.length > 0) return { tick, sections };
  }
  return null;
}

const U64_MAX = (1n << 64n) - 1n;
const F32_085 = Math.fround(0.85);
const F32_115 = Math.fround(1.15);

/** Digest of `draws` sampler calls of every shape; equal across engines iff their integer and float arithmetic agree. */
export function rngProbeDigest(seed: bigint, draws: number): string {
  const rng = stdRngSeedFromU64(seed);
  const h = new Fnv64();
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let i = 0; i < draws; i++) {
    switch (i % 10) {
      case 0:
        h.u32(rng.nextU32());
        break;
      case 1:
        h.u64(rng.nextU64());
        break;
      case 2:
        h.u32(rangeU32(rng, 0, (i % 97) + 1));
        break;
      case 3:
        h.i32(rangeI32(rng, -1000, 1000));
        break;
      case 4:
        h.u64(rangeU64Inclusive(rng, 1n, U64_MAX));
        break;
      case 5:
        h.f32(rangeF32(rng, F32_085, F32_115));
        break;
      case 6:
        h.f64(rangeF64(rng, 0, 37.3));
        break;
      case 7:
        h.bool(randomBool(rng, 0.35));
        break;
      case 8:
        shuffle(rng, items);
        for (const v of items) h.byte(v);
        break;
      default:
        h.u32(chooseIndex(rng, 5) ?? 0xffff_ffff);
    }
  }
  return toHex64(h.digest());
}
