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
