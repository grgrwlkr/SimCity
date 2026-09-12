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
    money: 25_000,
    population: 0,
    happiness: Math.fround(0.65),
    lastIncome: 0,
    lastExpense: 0,
  };
}

export const MINUTES_PER_DAY = 24 * 60;

/**
 * Length of a game hour at ×1: a real minute, six hundred fixed ticks. Rust had a second, and a car took more than a
 * game day to cross town, so no citizen's day could have a morning and an evening.
 */
export const DEFAULT_GAME_HOUR_NS = 60 * SECOND_NS;
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
  // A tick carries more game time than its own when the worker cannot afford all the ticks a speed asks for.
  clock.tick(Math.round(dtNs * w.clockScale));

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
  city.minute = Math.floor((clock.elapsedNs * 60) / clock.durationNs);
}
