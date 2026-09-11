// Bit-exact port of `rand 0.10.1` `StdRng` (ChaCha12 from `chacha20 0.10.0`, seeded through
// `SeedableRng::seed_from_u64`) and of the samplers the Rust sim calls on it. The Rust sim's
// `SimRng` and `BuildingGrowthRng` are both this generator, so the trajectory oracle can only
// agree if every draw agrees. Reference: tools/rand-vectors → test/fixtures/rand-0.10.1-vectors.json.

const MASK64 = (1n << 64n) - 1n;
const U32_MAX = 0xffff_ffff;
// 2^64 as an exact double; written out because `**` and `Math.pow` are not allowed in sim code.
const TWO_POW_64 = 18446744073709551616;

const PCG_MUL = 0x5851_f42d_4c95_7f2dn;
const PCG_INC = 0xa176_54e4_6fbe_17f3n;

const CHACHA_CONSTANTS = [0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574] as const;
const BLOCK_WORDS = 16;
const BUF_BLOCKS = 4;
const BUFFER_SIZE = BLOCK_WORDS * BUF_BLOCKS;
/** ChaCha12: six double rounds. */
const DOUBLE_ROUNDS = 6;

/** Seed of `SimRng::default()` and `BuildingGrowthRng::default()`. */
export const DEFAULT_RNG_SEED = 1n;

function quarterRound(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  let v: number;
  s[a] = s[a]! + s[b]!;
  v = s[d]! ^ s[a]!;
  s[d] = (v << 16) | (v >>> 16);
  s[c] = s[c]! + s[d]!;
  v = s[b]! ^ s[c]!;
  s[b] = (v << 12) | (v >>> 20);
  s[a] = s[a]! + s[b]!;
  v = s[d]! ^ s[a]!;
  s[d] = (v << 8) | (v >>> 24);
  s[c] = s[c]! + s[d]!;
  v = s[b]! ^ s[c]!;
  s[b] = (v << 7) | (v >>> 25);
}

export class StdRng {
  /** ChaCha state: constants, 8 key words, 64-bit block counter (12, 13), 64-bit stream (14, 15). */
  private readonly state = new Uint32Array(BLOCK_WORDS);
  private readonly working = new Uint32Array(BLOCK_WORDS);
  private readonly results = new Uint32Array(BUFFER_SIZE);
  /** `BlockRng` cursor; `BUFFER_SIZE` means the buffer is spent. */
  private index = BUFFER_SIZE;

  constructor(key: Uint32Array) {
    this.state.set(CHACHA_CONSTANTS, 0);
    this.state.set(key, 4);
  }

  /** `RngCore::next_u32`: one buffered word. */
  nextU32(): number {
    if (this.index >= BUFFER_SIZE) {
      this.generate();
      this.index = 0;
    }
    return this.results[this.index++]!;
  }

  /** `BlockRng::next_u64_from_u32`: low word first, including its block-edge cases. */
  nextU64(): bigint {
    const r = this.results;
    const index = this.index;
    let lo: number;
    let hi: number;
    if (index < BUFFER_SIZE - 1) {
      lo = r[index]!;
      hi = r[index + 1]!;
      this.index = index + 2;
    } else {
      lo = r[BUFFER_SIZE - 1]!;
      this.generate();
      hi = r[0]!;
      this.index = 1;
      if (index >= BUFFER_SIZE) {
        lo = hi;
        hi = r[1]!;
        this.index = 2;
      }
    }
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  /** Words that identify the stream position: key (8), block counter (lo, hi), buffer cursor. */
  stateWords(): Uint32Array {
    const out = new Uint32Array(11);
    out.set(this.state.subarray(4, 14), 0);
    out[10] = this.index;
    return out;
  }

  private generate(): void {
    const s = this.state;
    const w = this.working;
    for (let block = 0; block < BUF_BLOCKS; block++) {
      w.set(s);
      for (let round = 0; round < DOUBLE_ROUNDS; round++) {
        quarterRound(w, 0, 4, 8, 12);
        quarterRound(w, 1, 5, 9, 13);
        quarterRound(w, 2, 6, 10, 14);
        quarterRound(w, 3, 7, 11, 15);
        quarterRound(w, 0, 5, 10, 15);
        quarterRound(w, 1, 6, 11, 12);
        quarterRound(w, 2, 7, 8, 13);
        quarterRound(w, 3, 4, 9, 14);
      }
      const offset = block * BLOCK_WORDS;
      for (let i = 0; i < BLOCK_WORDS; i++) {
        this.results[offset + i] = w[i]! + s[i]!;
      }
      const counterLo = (s[12]! + 1) >>> 0;
      s[12] = counterLo;
      if (counterLo === 0) s[13] = s[13]! + 1;
    }
  }
}

/** `StdRng::seed_from_u64`: eight PCG32 outputs become the little-endian key words. */
export function stdRngSeedFromU64(seed: bigint): StdRng {
  let state = BigInt.asUintN(64, seed);
  const key = new Uint32Array(8);
  for (let i = 0; i < key.length; i++) {
    state = (state * PCG_MUL + PCG_INC) & MASK64;
    const xorshifted = Number((((state >> 18n) ^ state) >> 27n) & 0xffff_ffffn);
    const rot = Number(state >> 59n);
    key[i] = (xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31));
  }
  return new StdRng(key);
}

// Widening u32 multiply through 16-bit halves: a double holds each partial product exactly.
let wmulHi = 0;
let wmulLo = 0;
function wmul32(a: number, b: number): void {
  const aL = a & 0xffff;
  const aH = a >>> 16;
  const bL = b & 0xffff;
  const bH = b >>> 16;
  const ll = aL * bL;
  const lh = aL * bH;
  const hl = aH * bL;
  const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  wmulLo = (((mid & 0xffff) << 16) | (ll & 0xffff)) >>> 0;
  wmulHi = (aH * bH + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) >>> 0;
}

/**
 * `UniformInt::<u32>::sample_single_inclusive` with the default (biased, one-retry) algorithm.
 * Returns the offset from `low`; the caller applies the type's wrapping add.
 */
function sampleOffsetU32(rng: StdRng, range: number): number {
  wmul32(rng.nextU32(), range);
  let result = wmulHi;
  const loOrder = wmulLo;
  if (loOrder > (-range >>> 0)) {
    wmul32(rng.nextU32(), range);
    if (loOrder + wmulHi > U32_MAX) result += 1;
  }
  return result;
}

function emptyRange(): RangeError {
  return new RangeError('cannot sample empty range');
}

/** `rng.random_range(low..high)` for `u32`, and for `usize` bounds that fit in `u32`. */
export function rangeU32(rng: StdRng, low: number, high: number): number {
  if (!(low < high)) throw emptyRange();
  const range = (high - 1 - low + 1) >>> 0;
  if (range === 0) return rng.nextU32();
  return (low + sampleOffsetU32(rng, range)) >>> 0;
}

/** `rng.random_range(low..high)` for `i32`. */
export function rangeI32(rng: StdRng, low: number, high: number): number {
  if (!(low < high)) throw emptyRange();
  const range = (high - 1 - low + 1) >>> 0;
  if (range === 0) return rng.nextU32() | 0;
  return (low + (sampleOffsetU32(rng, range) | 0)) | 0;
}

/** `rng.random_range(low..=high)` for `u8`. */
export function rangeU8Inclusive(rng: StdRng, low: number, high: number): number {
  if (!(low <= high)) throw emptyRange();
  const range = (high - low + 1) & 0xff;
  if (range === 0) return rng.nextU32() & 0xff;
  return (low + sampleOffsetU32(rng, range)) & 0xff;
}

/** `rng.random_range(low..=high)` for `u64`. */
export function rangeU64Inclusive(rng: StdRng, low: bigint, high: bigint): bigint {
  if (!(low <= high)) throw emptyRange();
  const range = (high - low + 1n) & MASK64;
  if (range === 0n) return rng.nextU64();
  const product = rng.nextU64() * range;
  let result = product >> 64n;
  const loOrder = product & MASK64;
  if (loOrder > (-range & MASK64)) {
    const newHi = (rng.nextU64() * range) >> 64n;
    if (loOrder + newHi > MASK64) result += 1n;
  }
  return (low + result) & MASK64;
}

const f32Scratch = new Float32Array(1);
const f32Bits = new Uint32Array(f32Scratch.buffer);
const f64Scratch = new Float64Array(1);
const f64Bits = new BigUint64Array(f64Scratch.buffer);

/** `rng.random_range(low..high)` for `f32`: every intermediate is rounded to f32 as Rust does. */
export function rangeF32(rng: StdRng, low: number, high: number): number {
  const lo = Math.fround(low);
  const hi = Math.fround(high);
  if (!(lo <= hi)) throw emptyRange();
  const scale = Math.fround(hi - lo);
  if (!Number.isFinite(scale)) throw new RangeError('non-finite range');
  // 23 random mantissa bits with exponent 0: a value in [1, 2).
  f32Bits[0] = (rng.nextU32() >>> 9) | 0x3f80_0000;
  const value01 = Math.fround(f32Scratch[0]! - 1);
  return Math.fround(Math.fround(value01 * scale) + lo);
}

/** `rng.random_range(low..high)` for `f64`. */
export function rangeF64(rng: StdRng, low: number, high: number): number {
  if (!(low <= high)) throw emptyRange();
  const scale = high - low;
  if (!Number.isFinite(scale)) throw new RangeError('non-finite range');
  // 52 random mantissa bits with exponent 0: a value in [1, 2).
  f64Bits[0] = (rng.nextU64() >> 12n) | (1023n << 52n);
  const value01 = f64Scratch[0]! - 1;
  return value01 * scale + low;
}

/** `rng.random_bool(p)` through `Bernoulli::new(p)`; `p == 1` draws nothing. */
export function randomBool(rng: StdRng, p: number): boolean {
  if (!(p >= 0 && p < 1)) {
    if (p === 1) return true;
    throw new RangeError(`p=${p} is outside range [0.0, 1.0]`);
  }
  const pInt = BigInt(Math.trunc(p * TWO_POW_64));
  return rng.nextU64() < pInt;
}

/** Index picked by `slice.choose(rng)`, or `undefined` for an empty slice. */
export function chooseIndex(rng: StdRng, len: number): number | undefined {
  return len === 0 ? undefined : rangeU32(rng, 0, len);
}

function calculateBoundU32(m: number): readonly [bound: number, count: number] {
  let product = m;
  let current = m + 1;
  for (;;) {
    const next = product * current;
    if (next > U32_MAX) return [product, current - m];
    product = next;
    current += 1;
  }
}

/** `slice.shuffle(rng)`: `partial_shuffle(len)` driven by `IncreasingUniform`. */
export function shuffle<T>(rng: StdRng, items: T[]): void {
  const len = items.length;
  if (len <= 1) return;
  let n = 0;
  let chunk = 0;
  // `IncreasingUniform::new(rng, 0)`: the first index is always 0 and needs no draw.
  let chunkRemaining = 1;
  for (let i = 0; i < len; i++) {
    const nextN = n + 1;
    let nextChunkRemaining: number;
    if (chunkRemaining === 0) {
      const [bound, count] = calculateBoundU32(nextN);
      chunk = rangeU32(rng, 0, bound);
      nextChunkRemaining = count - 1;
    } else {
      nextChunkRemaining = chunkRemaining - 1;
    }
    let index: number;
    if (nextChunkRemaining === 0) {
      index = chunk;
    } else {
      index = chunk % nextN;
      chunk = Math.floor(chunk / nextN);
    }
    chunkRemaining = nextChunkRemaining;
    n = nextN;
    const tmp = items[i]!;
    items[i] = items[index]!;
    items[index] = tmp;
  }
}
