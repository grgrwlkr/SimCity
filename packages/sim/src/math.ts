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

/** `x.powf(n)` for a whole `n >= 1`, as successive f32 products (engine-independent, unlike `Math.pow`). */
export function powIntF32(x: number, n: number): number {
  let r = Math.fround(x);
  for (let i = 1; i < n; i++) r = Math.fround(r * x);
  return r;
}
