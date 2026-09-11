import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RNG_SEED,
  chooseIndex,
  randomBool,
  rangeF32,
  rangeF64,
  rangeI32,
  rangeU32,
  rangeU64Inclusive,
  rangeU8Inclusive,
  shuffle,
  stdRngSeedFromU64,
  type StdRng,
} from '../src/rng';
import vectors from './fixtures/rand-0.10.1-vectors.json';

const U64_MAX = (1n << 64n) - 1n;

function f32Bits(x: number): number {
  return new Uint32Array(new Float32Array([x]).buffer)[0]!;
}

function f64Bits(x: number): bigint {
  return new BigUint64Array(new Float64Array([x]).buffer)[0]!;
}

// Same schedule as `op_for` / `run_op` in tools/rand-vectors/src/main.rs.
function runOp(rng: StdRng, i: number): string {
  switch ((i * 7 + 3) % vectors.opKinds) {
    case 0:
      return `u32:${rng.nextU32()}`;
    case 1:
      return `u64:${rng.nextU64()}`;
    case 2: {
      const len = (i % 97) + 1;
      return `usize_lt:${len}:${rangeU32(rng, 0, len)}`;
    }
    case 3:
      return `i32:3:10:${rangeI32(rng, 3, 10)}`;
    case 4:
      return `i32:0:128:${rangeI32(rng, 0, 128)}`;
    case 5:
      return `u8_incl:0:255:${rangeU8Inclusive(rng, 0, 255)}`;
    case 6:
      return `u64_incl:1:max:${rangeU64Inclusive(rng, 1n, U64_MAX)}`;
    case 7:
      return `f32:1:3:${f32Bits(rangeF32(rng, 1, 3))}`;
    case 8:
      return `f64:0:10:${f64Bits(rangeF64(rng, 0, 10))}`;
    case 9:
      return `bool:0.35:${randomBool(rng, 0.35)}`;
    case 10: {
      const n = i % 20;
      const v = Array.from({ length: n }, (_, k) => k);
      shuffle(rng, v);
      return `shuffle:${n}:${v.join(',')}`;
    }
    case 11: {
      const n = i % 5;
      const picked = chooseIndex(rng, n);
      return `choose:${n}:${picked === undefined ? 'none' : picked}`;
    }
    case 12:
      return `f32:0:1:${f32Bits(rangeF32(rng, 0, 1))}`;
    case 13:
      return `f32:0.85:1.15:${f32Bits(rangeF32(rng, Math.fround(0.85), Math.fround(1.15)))}`;
    case 14:
      return `f64:0:37.3:${f64Bits(rangeF64(rng, 0, 37.3))}`;
    case 15:
      return `bool:0.05:${randomBool(rng, 0.05)}`;
    default:
      return `bool:1:${randomBool(rng, 1)}`;
  }
}

describe('StdRng port of rand 0.10.1', () => {
  it('stdRngMatchesRustVectors', () => {
    for (const c of vectors.cases) {
      const rng = stdRngSeedFromU64(BigInt(c.seed));
      const got = c.ops.map((_, i) => runOp(rng, i));
      expect({ seed: c.seed, ops: got }).toEqual({ seed: c.seed, ops: c.ops });
    }
  });

  it('stdRngU64MatchesRustAcrossBlockBoundary', () => {
    const got = vectors.boundary.map((_, k) => {
      const rng = stdRngSeedFromU64(BigInt(vectors.boundarySeed));
      for (let j = 0; j < k; j++) rng.nextU32();
      return rng.nextU64().toString();
    });
    expect(got).toEqual(vectors.boundary);
  });
});

// Ported from crates/simcity_sim/src/game/sim.rs, mod sim_rng_tests.
describe('sim_rng_tests', () => {
  const draw = (rng: StdRng, n: number): bigint[] => Array.from({ length: n }, () => rng.nextU64());

  it('simRngDefaultIsDeterministicForSameSeed', () => {
    const a = stdRngSeedFromU64(DEFAULT_RNG_SEED);
    const b = stdRngSeedFromU64(DEFAULT_RNG_SEED);
    expect(draw(a, 32)).toEqual(draw(b, 32));
  });

  it('simRngDivergesForDifferentSeed', () => {
    const a = stdRngSeedFromU64(1n);
    const b = stdRngSeedFromU64(2n);
    expect(draw(a, 32)).not.toEqual(draw(b, 32));
  });
});
