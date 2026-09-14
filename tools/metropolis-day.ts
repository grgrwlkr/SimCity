// `bun tools/metropolis-day.ts [size] [hourSeconds] [hours]`: the stage 3½e gate of a day of rush hours on the metropolis.
// On an hour of 360 s a tick carries a game second, the rate meso traffic runs at. Hour by hour: the car trips that set
// out, the arrivals, the walks, the cars on the road, the trips waiting to leave, the longest queue and the forced pushes;
// at the end the share of trips that got there against the thresholds set from stage 3½c.
import { MetropolisScenario, SECOND_NS, createWorld, frame, requestState, step } from '../packages/sim/src/index';

const size = Number(process.argv[2] ?? 800);
const hourSeconds = Number(process.argv[3] ?? 360);
const hours = Number(process.argv[4] ?? 24);

/**
 * Thresholds from the day of stage 3½c on the living city: every trip there arrived (the gate test asked 0.9 of those
 * that could), 438 forced pushes on 4 720 car trips, a longest queue of 41 cars on links about 42 tiles between lights;
 * the metropolis's are 84.
 */
const MIN_ARRIVED_SHARE = 0.95;
const MAX_PUSHES_PER_CAR_TRIP = 438 / 4720;
const MAX_LONGEST_QUEUE = 41 * 2;

const w = createWorld({ mapWidth: size, mapHeight: size, gameHourNs: hourSeconds * SECOND_NS });
requestState(w, 'InGame');
const built = performance.now();
new MetropolisScenario(w);
frame(w, 0);
const buildMs = performance.now() - built;
const citizensAtStart = w.citizens.count;

const ticksPerHour = Math.round((hourSeconds * 10) / 1);
const m = w.mesoTraffic;
let [carTrips, citizenCarTrips, walks, arrivals, longestQueue, busiest] = [0, 0, 0, 0, 0, 0];
const rows: Array<Record<string, number | string>> = [];
const started = performance.now();
for (let hour = 0; hour < hours; hour++) {
  const at = `${w.city.hour}:00`;
  const [trips0, arrivals0, walks0, pushes0] = [carTrips, arrivals, walks, m.stats.forcedPushes];
  let hourQueue = 0;
  const samples: number[] = [];
  for (let tick = 0; tick < ticksPerHour; tick++) {
    const t0 = performance.now();
    step(w, 1);
    samples.push(performance.now() - t0);
    for (const trip of w.events.tripRequested) {
      if (trip.mode === 'Walk') walks += 1;
      else if (trip.pocket === true) {
        carTrips += 1;
        if (trip.citizen >= 0) citizenCarTrips += 1;
      }
    }
    arrivals += w.events.tripFinished.length;
    if (tick % 60 === 0) {
      busiest = Math.max(busiest, m.carCount());
      for (let link = 0; link < m.onLink.length; link++) hourQueue = Math.max(hourQueue, m.onLink[link]!);
    }
  }
  longestQueue = Math.max(longestQueue, hourQueue);
  samples.sort((a, b) => a - b);
  rows.push({
    hour: at,
    carTrips: carTrips - trips0,
    arrivals: arrivals - arrivals0,
    walks: walks - walks0,
    onRoad: m.carCount(),
    waiting: m.pending.length,
    longestQueue: hourQueue,
    pushes: m.stats.forcedPushes - pushes0,
    tickP50Ms: Number(samples[Math.floor(samples.length / 2)]!.toFixed(3)),
    tickP99Ms: Number(samples[Math.floor(samples.length * 0.99)]!.toFixed(2)),
  });
  console.log(JSON.stringify(rows.at(-1)));
}

const couldArrive = carTrips - m.carCount() - m.pending.length;
const summary = {
  size,
  hourSeconds,
  hours,
  buildMs: Math.round(buildMs),
  wallMs: Math.round(performance.now() - started),
  citizens: [citizensAtStart, w.citizens.count],
  carTrips,
  citizenCarTrips,
  walks,
  arrivals,
  arrivedShare: Number((arrivals / couldArrive).toFixed(4)),
  stillDriving: m.carCount(),
  waiting: m.pending.length,
  dropped: m.stats.dropped,
  forcedPushes: m.stats.forcedPushes,
  pushesPerCarTrip: Number((m.stats.forcedPushes / carTrips).toFixed(4)),
  longestQueue,
  busiest,
  routeSearches: m.stats.routeSearches,
  errors: [...w.systemErrors.values()].map((e) => `${e.system} ×${e.count}: ${e.message}`),
};
const gate = {
  arrived: summary.arrivedShare >= MIN_ARRIVED_SHARE,
  pushes: summary.pushesPerCarTrip <= MAX_PUSHES_PER_CAR_TRIP,
  queue: longestQueue <= MAX_LONGEST_QUEUE,
  noErrors: summary.errors.length === 0,
};
console.log(JSON.stringify({ summary, thresholds: { MIN_ARRIVED_SHARE, MAX_PUSHES_PER_CAR_TRIP: Number(MAX_PUSHES_PER_CAR_TRIP.toFixed(4)), MAX_LONGEST_QUEUE }, gate }));
