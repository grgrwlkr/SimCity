// `bun run bench`: cost of one fixed tick, p50 / p99 / max over 3000 ticks, on the empty map and on
// the Rust test city (loaded from the stage 1 fixture). The numbers go into the stage plan.
import { buildHeadlessGame, step, type World } from '../packages/sim/src/index';
import { loadTestCity } from '../packages/sim/test/testCity';

const WARMUP_TICKS = 300;
const TICKS = 3_000;

function bench(label: string, w: World): void {
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
      world: label,
      p50Ms: Number(at(0.5).toFixed(4)),
      p99Ms: Number(at(0.99).toFixed(4)),
      maxMs: Number(samples[TICKS - 1]!.toFixed(4)),
    }),
  );
}

bench('empty map', buildHeadlessGame());
bench('Rust test city (graphs and lanelets built, no vehicles before stage 2)', loadTestCity());
