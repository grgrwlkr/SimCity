// `bun run bench`: cost of one fixed tick, p50 / p99 / max over 3000 ticks, on the empty map and on
// the Rust test city (loaded from the stage 1 fixture); and the systems that scale with citizens on the living city
// with 100 000 more of them (stage 3½b). The numbers go into the stage plan.
import {
  FIXED_UPDATE,
  LivingCityScenario,
  METROPOLIS_SIZE,
  MetropolisScenario,
  TICK_DT_NS,
  applyCommands,
  applyStateTransition,
  recordSystemError,
  runUpdateGraph,
  runsThisTick,
  SECOND_NS,
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

/** The world of the stage 4 gate: the living city with every system of the stage, on an hour of 60 s. */
function livingCityOnTheGateClock(): World {
  const w = createWorld({ gameHourNs: 60 * SECOND_NS });
  requestState(w, 'InGame');
  frame(w, 0);
  new LivingCityScenario(w);
  return w;
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

/**
 * The metropolis of stage 3½e: how long it takes to build and move into, the heap it holds, then `ticks` fixed ticks from
 * six in the morning with the cost of every system, as `frame` runs them.
 */
function benchMetropolis(size: number, ticks: number): void {
  const heap = () => Math.round(process.memoryUsage().heapUsed / 1e6);
  const before = heap();
  const w = createWorld({ mapWidth: size, mapHeight: size });
  requestState(w, 'InGame');
  frame(w, 0);
  const started = performance.now();
  new MetropolisScenario(w);
  const buildMs = performance.now() - started;
  const bySystem = new Map<string, { total: number; max: number; calls: number }>();
  const samples: number[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    const tickStart = performance.now();
    applyStateTransition(w);
    for (const system of FIXED_UPDATE) {
      if (!system.runIn.includes(w.appState) || !runsThisTick(w, system)) continue;
      const t0 = performance.now();
      try {
        system.run(w, TICK_DT_NS);
      } catch (error) {
        recordSystemError(w, system.name, error);
      }
      const ms = performance.now() - t0;
      const entry = bySystem.get(system.name) ?? { total: 0, max: 0, calls: 0 };
      entry.total += ms;
      entry.max = Math.max(entry.max, ms);
      entry.calls += 1;
      bySystem.set(system.name, entry);
    }
    w.tick += 1;
    applyCommands(w);
    runUpdateGraph(w);
    samples.push(performance.now() - tickStart);
  }
  const systems = [...bySystem]
    .sort(([, a], [, b]) => b.total - a.total)
    .slice(0, 15)
    .map(([name, e]) => ({ name, totalMs: round(e.total), meanMs: round(e.total / e.calls), maxMs: round(e.max), calls: e.calls }));
  console.log(
    JSON.stringify({
      world: `metropolis ${size}×${size}`,
      citizens: w.citizens.count,
      buildings: w.buildings.all().length,
      links: w.meso.linkCount,
      buildMs: round(buildMs),
      heapMb: heap() - before,
      ticks,
      clock: `${w.city.hour}:${w.city.minute}`,
      errors: [...w.systemErrors.keys()],
      tick: percentiles(samples.slice(1)),
      firstTickMs: round(samples[0] ?? 0),
    }),
  );
  console.log(JSON.stringify(systems));
}

const only = process.argv[2];
if (only === undefined || only === 'small') {
  bench('empty map', buildHeadlessGame());
  bench('Rust test city (graphs and lanelets built, no vehicles before stage 2)', loadTestCity());
  bench('living city, an hour of 60 s (stage 4 gate)', livingCityOnTheGateClock());
  benchCitizens(100_000);
}
if (only === undefined || only === 'metropolis') benchMetropolis(Number(process.argv[3] ?? METROPOLIS_SIZE), Number(process.argv[4] ?? 3000));
