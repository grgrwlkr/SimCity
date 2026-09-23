/**
 * Timeout of a scenario test: none. Such a test is sized in ticks, and a synchronous body cannot be interrupted, so vitest
 * 5 checks its timeout only after it has returned (`withTimeout` in vitest's `dist/chunks/run.*.js`: "if test/hook took
 * too long in microtask, setTimeout won't be triggered, but we still need to fail the test"). A timeout there never
 * stopped a hang; it only failed a run that was correct but slow because the machine was busy. `0` switches it off
 * (`withTimeout` returns the body unwrapped when `timeout <= 0`); what a tick costs is `bun run bench`'s to measure.
 */
export const SIZED_IN_TICKS = 0;
