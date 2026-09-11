// Port of `City`, `SimClock` and `sim_tick` from crates/simcity_sim/src/game/sim.rs.
import { SECOND_NS, Timer } from './timer';
import type { World } from './world';

const U32_MAX = 0xffff_ffff;

export interface City {
  day: number;
  /** Current game hour, 0..=23. */
  hour: number;
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
    money: 25_000,
    population: 0,
    happiness: Math.fround(0.65),
    lastIncome: 0,
    lastExpense: 0,
  };
}

/** Length of one game hour at x1 speed: ten fixed ticks. */
export const GAME_HOUR_NS = SECOND_NS;
/** At most one game day per tick, so a huge delta cannot turn into a catch-up storm. */
export const MAX_HOURS_PER_TICK = 24;

/** `SimClock::default()`: fires every game hour. */
export function createSimClock(): Timer {
  return new Timer(GAME_HOUR_NS, 'Repeating');
}

/** `SimStep::Tick`: advances the hour and day and emits `HourAdvanced` / `DayAdvanced`. */
export function simTick(w: World, dtNs: number): void {
  const clock = w.clock;
  clock.durationNs = GAME_HOUR_NS;
  clock.setMode('Repeating');
  clock.tick(dtNs);

  const finished = clock.timesFinishedThisTick;
  if (finished === 0) return;

  const city = w.city;
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
