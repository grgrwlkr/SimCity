// `bun run bench`: cost of one fixed tick, p50 / p99 / max over 3000 ticks, on the empty map and on
// the Rust test city (loaded from the stage 1 fixture); and the systems that scale with citizens on the living city
// with 100 000 more of them (stage 3½b). The numbers go into the stage plan.
import {
  LivingCityScenario,
  SHIFT_MINUTES,
  WORK_START_WINDOW,
  assignJobs,
  buildHeadlessGame,
  citizenTripPlanner,
  createWorld,
  emptyEvents,
  frame,
  giveCar,
  newCitizen,
  rangeU32,
  requestState,
  step,
  stdRngSeedFromU64,
  type World,
} from '../packages/sim/src/index';
import { loadTestCity } from '../packages/sim/test/testCity';

const WARMUP_TICKS = 300;
const TICKS = 3_000;

const round = (ms: number) => Number(ms.toFixed(4));

function percentiles(samples: readonly number[]): { p50Ms: number; p99Ms: number; maxMs: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? 0;
  return { p50Ms: round(at(0.5)), p99Ms: round(at(0.99)), maxMs: round(sorted.at(-1) ?? 0) };
}

function bench(label: string, w: World): void {
  step(w, WARMUP_TICKS);
  const samples: number[] = [];
  for (let i = 0; i < TICKS; i++) {
    const start = performance.now();
    step(w, 1);
    samples.push(performance.now() - start);
  }
  console.log(JSON.stringify({ ticks: TICKS, world: label, ...percentiles(samples) }));
}

/**
 * The living city with `total` more citizens spread over its homes, every other one with a car: job assignment call by
 * call until everyone is placed, then the planner minute by minute through the morning. Each call is one tick's work.
 */
function benchCitizens(total: number): void {
  const w = createWorld();
  requestState(w, 'InGame');
  frame(w, 0);
  new LivingCityScenario(w);
  // The graphs, then the district times, a few rows a tick.
  step(w, 30);
  const homes = w.buildings.all().filter((b) => b.kind === 'Residential');
  const works = w.buildings.all().filter((b) => b.kind === 'Commercial' || b.kind === 'Industrial');
  for (const b of homes) {
    b.capacityResidents += Math.ceil(total / homes.length);
    b.occupancyResidents = b.capacityResidents;
    b.targetOccupancyResidents = b.capacityResidents;
  }
  for (const b of works) b.capacityJobs += Math.ceil((total * 1.1) / works.length);

  const rng = stdRngSeedFromU64(5n);
  const added = performance.now();
  for (let i = 0; i < total; i++) {
    const home = homes[i % homes.length]!;
    const workStart = rangeU32(rng, WORK_START_WINDOW[0], WORK_START_WINDOW[1]);
    const shiftMinutes = rangeU32(rng, SHIFT_MINUTES[0], SHIFT_MINUTES[1] + 1);
    const ref = w.citizens.add(newCitizen(home, { workStart, shiftMinutes }));
    if (i % 2 === 0) giveCar(w, ref);
  }
  const addMs = performance.now() - added;

  const assign: number[] = [];
  for (let call = 0; call < 20_000 && w.citizens.jobSeekers.length > 0; call++) {
    const start = performance.now();
    assignJobs(w);
    assign.push(performance.now() - start);
    if (w.employmentStats.assignedLastTick === 0) break;
  }

  const plan: number[] = [];
  let trips = 0;
  for (let minute = 6 * 60; minute <= 9 * 60 + 30; minute++) {
    w.city.hour = Math.floor(minute / 60);
    w.city.minute = minute % 60;
    w.events = emptyEvents();
    const start = performance.now();
    citizenTripPlanner(w);
    plan.push(performance.now() - start);
    trips += w.events.tripRequested.length;
  }

  console.log(
    JSON.stringify({
      world: `living city + ${total} citizens`,
      citizens: w.citizens.count,
      addAndParkMs: round(addMs),
      jobSeekersLeft: w.citizens.jobSeekers.length,
      assignJobs: { calls: assign.length, ...percentiles(assign) },
      plannerFirstRunMs: round(plan[0] ?? 0),
      planner: { minutes: plan.length - 1, trips, ...percentiles(plan.slice(1)) },
    }),
  );
}

bench('empty map', buildHeadlessGame());
bench('Rust test city (graphs and lanelets built, no vehicles before stage 2)', loadTestCity());
benchCitizens(100_000);
