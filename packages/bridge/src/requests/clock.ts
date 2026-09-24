// The worker's side of `setClock` (E3): the hour written into the world, as `simcity/sim` with `hour` and `day` did in
// rust-final crates/simcity_debug/src/game/live/control.rs, so a noon frame is one call rather than half a day at speed.
import { AGENDA_STOPS, CITIZEN_STATES, MINUTES_PER_DAY, TRIP_PURPOSES, gameMinute, planRegionalTrips, type MinuteQueue, type World } from '@simcity/sim';

export interface ClockRequest {
  readonly t: 'setClock';
  /** Whole hour, 0..=23. */
  readonly hour: number;
  /** Day from 1; omitted, the next time the clock shows `hour`. */
  readonly day?: number;
}

export interface ClockReply {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly tick: number;
}

/**
 * Game minutes the moves a jump made due are spread over, one minute a slot: at most one citizen in this many wakes on
 * any minute of it, about the rate of the morning peak on the metropolis.
 */
export const CLOCK_JUMP_SPREAD_MINUTES = 120;
/** A tour this late is dropped for the day, the planner's own rule (`LATE_TOUR_MINUTES` of packages/sim citizens.ts). */
const LATE_TOUR_MINUTES = 60;
const RETURN_HOME = TRIP_PURPOSES.indexOf('ReturnHome');
const AT_HOME = CITIZEN_STATES.indexOf('AtHome');
/** `RegionalTrips.state` of an agent waiting to set out (packages/sim regional.ts). */
const REGIONAL_WAITING = 0;

/**
 * Stands the clock at `hour`:00 of `day`, the hour timer from its start. The clock only runs forward: citizens and the
 * region wait in buckets by game minute, and a clock set back would hold every one of them until it caught up. Without a
 * `day`, an hour already past is that hour tomorrow; a `day` and `hour` in the past are refused. Nothing that runs on the
 * hour or the day is replayed for the time skipped — this is a debugging aid for a frame or a scene, not a fast-forward:
 * what came due in the skipped time is re-planned by `replanSkippedTime`, never replayed at once.
 */
export function setClock(w: World, req: Omit<ClockRequest, 't'>): ClockReply {
  const { hour, day } = req;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new RangeError(`\`hour\` must be a whole hour 0..=23, got ${String(hour)}`);
  if (day !== undefined && (!Number.isInteger(day) || day < 1)) throw new RangeError(`\`day\` must be a whole day from 1, got ${String(day)}`);
  const city = w.city;
  const now = gameMinute(w) + (city.second > 0 ? 1 : 0);
  let target = ((day ?? city.day) - 1) * MINUTES_PER_DAY + hour * 60;
  if (target < now) {
    if (day !== undefined) {
      throw new RangeError(`the clock only runs forward: day ${day} ${hour}:00 is before day ${city.day} ${city.hour}:${String(city.minute).padStart(2, '0')}`);
    }
    target += MINUTES_PER_DAY;
  }
  city.day = Math.floor(target / MINUTES_PER_DAY) + 1;
  city.hour = hour;
  city.minute = 0;
  city.second = 0;
  w.clock.reset();
  w.notifications.setDay(city.day);
  replanSkippedTime(w, target);
  return { day: city.day, hour: city.hour, minute: city.minute, tick: w.tick };
}

/**
 * What came due in the skipped time takes the place the day gives it at `now`, instead of every missed move running in
 * the next tick (a jump to noon on the metropolis woke 2.2 million moves in one tick and queued 37 000 trips at once):
 * - a citizen at home whose tour is more than `LATE_TOUR_MINUTES` late misses it and stays home, as the planner drops
 *   any tour that late; the rest of their day is planned on a minute of the spread;
 * - any other due move — a stay that is over, a walk that has arrived, a tour just due, the planning of a day — comes on
 *   a minute of the spread (a drive under way is traffic's and arrives as it would);
 * - an agent of the region still waiting for a trip that late does not come; the rest move on a minute of the spread;
 * - a day the clock jumped into is planned for the region as its turn of the day would have planned it, and then the
 *   same two rules apply: at 5:00 its whole day is ahead, at noon the 6–9 commute is gone and the freight until 16–18
 *   is not.
 * Deterministic: the minute of the spread is the slot's.
 */
export function replanSkippedTime(w: World, now: number): void {
  const spread = (slot: number) => now + 1 + (slot % CLOCK_JUMP_SPREAD_MINUTES);
  const c = w.citizens;
  for (let slot = 0; slot < c.highWater; slot++) {
    const due = c.nextAt[slot]!;
    if (c.alive[slot] !== 1 || due < 0 || due >= now) continue;
    const purpose = c.nextPurpose[slot]! < 0 ? null : TRIP_PURPOSES[c.nextPurpose[slot]!]!;
    if (c.state[slot] === AT_HOME && purpose !== null && due + LATE_TOUR_MINUTES < now) {
      const base = slot * AGENDA_STOPS;
      let k = c.agendaCursor[slot]!;
      while (k < c.agendaLength[slot]! && c.agendaPurpose[base + k] !== RETURN_HOME) k++;
      c.agendaCursor[slot] = Math.min(k + 1, AGENDA_STOPS);
      c.schedule(slot, spread(slot), null);
    } else {
      c.schedule(slot, spread(slot), purpose);
    }
  }
  const r = w.regional;
  const replanRegion = () => {
    for (let slot = 0; slot < r.highWater; slot++) {
      const due = r.nextAt[slot]!;
      if (r.alive[slot] !== 1 || due < 0 || due >= now) continue;
      if (r.state[slot] === REGIONAL_WAITING && due + LATE_TOUR_MINUTES < now) r.free(slot);
      else r.schedule(slot, spread(slot));
    }
  };
  replanRegion();
  const day = Math.floor(now / MINUTES_PER_DAY) + 1;
  if (r.plannedDay !== 0 && r.plannedDay < day) {
    // The region plans a day on its first run of the day, a run the jump skipped: plan it as of the day's first minute,
    // with no through traffic or visitors for that minute, then treat what the plan put behind `now` as skipped time.
    const city = w.city;
    const hour = city.hour;
    const carried = [r.accumulators[0]!, r.accumulators[1]!];
    r.accumulators.fill(-Infinity);
    city.hour = 0;
    planRegionalTrips(w);
    city.hour = hour;
    r.accumulators.set(carried);
    replanRegion();
  }
  // The moves taken off their old minutes would each be popped and passed over on the next planner run.
  dropStale(c.queue, (ref) => {
    const slot = c.resolve(ref);
    return slot === undefined ? undefined : c.nextAt[slot];
  });
  dropStale(r.queue, (slot) => (r.alive[slot] === 1 ? r.nextAt[slot] : undefined));
}

/** Keeps only the entries still waiting for their minute, in the order they were queued. */
function dropStale(queue: MinuteQueue, minuteOf: (ref: number) => number | undefined): void {
  const entries = queue.entries();
  queue.clear();
  for (const [minute, refs] of entries) for (const ref of refs) if (minuteOf(ref) === minute) queue.push(minute, ref);
}
