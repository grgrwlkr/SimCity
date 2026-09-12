// The one float function the simulation allows beyond exact arithmetic.

/**
 * `f32::sqrt`. IEEE 754 requires a correctly rounded square root, and every JS engine takes it
 * from the processor's instruction, so it is identical across engines; the cross-engine
 * fingerprint gate checks that on every CI run.
 */
export function sqrtF32(x: number): number {
  // eslint-disable-next-line no-restricted-properties -- correctly rounded by IEEE 754, see above
  return Math.fround(Math.sqrt(x));
}

const LN2 = 0.6931471805599453;
/** Terms of the series: |r| ≤ ln 2 / 2 leaves the 25th below 1e-40. */
const EXP_TERMS = 24;

/**
 * `e^x` on + − × ÷ only, identical in every engine, unlike `Math.exp` (implementation-approximated):
 * x = k·ln 2 + r with |r| about ln 2 / 2 at most, a fixed Taylor series of e^r, then k exact doublings
 * or halvings. Within round-off of a correctly rounded result.
 */
export function expF64(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x > 709.8) return Infinity;
  if (x < -745.2) return 0;
  const k = Math.round(x / LN2);
  const r = x - k * LN2;
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= EXP_TERMS; n++) {
    term = (term * r) / n;
    sum += term;
  }
  const step = k > 0 ? 2 : 0.5;
  let scaled = sum;
  for (let i = Math.abs(k); i > 0; i--) scaled *= step;
  return scaled;
}

/**
 * `x.powf(n)` for a whole `n >= 1`. libm returns the power rounded once to f32; successive f32
 * products round at every step and drift by an ULP (seen on the platoon gate). The products run in
 * f64 instead — `x²` of an f32 is exact there — and round to f32 once at the end. Engine-independent,
 * unlike `Math.pow`.
 */
export function powIntF32(x: number, n: number): number {
  const base = Math.fround(x);
  let r = base;
  for (let i = 1; i < n; i++) r *= base;
  return Math.fround(r);
}
