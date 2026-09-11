// `bun run bench`: cost of one fixed tick on the headless game, p50 / p99 / max over 3000 ticks.
// Stage 0 has no test city yet, so this measures the empty map; the number goes into the stage plan.
import { buildHeadlessGame, step } from '../packages/sim/src/index';

const WARMUP_TICKS = 300;
const TICKS = 3_000;

const w = buildHeadlessGame();
step(w, WARMUP_TICKS);

const samples = new Float64Array(TICKS);
for (let i = 0; i < TICKS; i++) {
  const start = performance.now();
  step(w, 1);
  samples[i] = performance.now() - start;
}
samples.sort();

const at = (q: number) => samples[Math.min(TICKS - 1, Math.floor(q * (TICKS - 1)))]!;
console.log(
  JSON.stringify({
    ticks: TICKS,
    world: 'empty map (stage 0)',
    p50Ms: Number(at(0.5).toFixed(4)),
    p99Ms: Number(at(0.99).toFixed(4)),
    maxMs: Number(samples[TICKS - 1]!.toFixed(4)),
  }),
);
