// Port of `City`, `SimClock` and `sim_tick` from crates/simcity_sim/src/game/sim.rs.
import { SECOND_NS, Timer } from './timer';
import type { World } from './world';

const U32_MAX = 0xffff_ffff;

export interface City {
  day: number;
  /** Current game hour, 0..=23. */
  hour: number;
  /** Minutes into the current hour, 0..=59. */
  minute: number;
  /** Seconds into the current minute, 0..=59. */
  second: number;
  /** `i64` in Rust; kept inside the safe-integer range. */
  money: number;
  population: number;
  /** `f32`. */
  happiness: number;
  lastIncome: number;
  lastExpense: number;
}

export function defaultCity(): City {
  return {
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    money: 25_000,
    population: 0,
    happiness: Math.fround(0.65),
    lastIncome: 0,
    lastExpense: 0,
  };
}

export const MINUTES_PER_DAY = 24 * 60;

/**
 * Length of a game hour at ×1: a real hour, 36 000 fixed ticks, so a car at 40 km/h covers 40 km in it and a trip ends
 * when it would in life. The speed ladder runs more ticks, never more game time a tick (TS stage 3½; Rust had a second
 * an hour, and a car took more than a game day to cross town).
 */
export const DEFAULT_GAME_HOUR_NS = 3600 * SECOND_NS;
/** At most one game day per tick, so a huge delta cannot turn into a catch-up storm. */
export const MAX_HOURS_PER_TICK = 24;

/** `SimClock`: fires every game hour. */
export function createSimClock(hourNs: number = DEFAULT_GAME_HOUR_NS): Timer {
  return new Timer(hourNs, 'Repeating');
}

/** Game minutes since day 1, 00:00. */
export function gameMinute(w: World): number {
  return (w.city.day - 1) * MINUTES_PER_DAY + w.city.hour * 60 + w.city.minute;
}

/** `SimStep::Tick`: advances the hour and day, emits `HourAdvanced` / `DayAdvanced`, and keeps the minute. */
export function simTick(w: World, dtNs: number): void {
  const clock = w.clock;
  clock.durationNs = w.gameHourNs;
  clock.setMode('Repeating');
  clock.tick(dtNs);

  const city = w.city;
  const finished = clock.timesFinishedThisTick;
  if (finished > 0) {
    const hours = Math.min(finished, MAX_HOURS_PER_TICK);
    for (let i = 0; i < hours; i++) {
      city.hour = (city.hour + 1) % 24;
      w.events.hourAdvanced.push({ hour: city.hour, day: city.day });
      if (city.hour === 0) {
        city.day = Math.min(city.day + 1, U32_MAX);
        w.events.dayAdvanced.push(city.day);
      }
    }

    // Events from here on happen on the day the clock has reached, even when many ticks run in one frame.
    w.notifications.setDay(city.day);

    // Past the clamp, drop the backlog instead of carrying it into the next tick.
    if (finished > MAX_HOURS_PER_TICK) clock.reset();
  }
  // In integers: at a real-time hour, elapsed nanoseconds times 3 600 are past what a double holds exactly.
  const secondsIntoHour = Number((BigInt(Math.round(clock.elapsedNs)) * 3600n) / BigInt(clock.durationNs));
  city.minute = Math.floor(secondsIntoHour / 60);
  city.second = secondsIntoHour % 60;
}
