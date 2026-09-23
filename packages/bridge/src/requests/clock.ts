// The worker's side of `setClock` (E3): the hour written into the world, as `simcity/sim` with `hour` and `day` did in
// rust-final crates/simcity_debug/src/game/live/control.rs, so a noon frame is one call rather than half a day at speed.
import { MINUTES_PER_DAY, gameMinute, type World } from '@simcity/sim';

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
 * Stands the clock at `hour`:00 of `day`, the hour timer from its start. The clock only runs forward: citizens and the
 * region wait in buckets by game minute, and a clock set back would hold every one of them until it caught up. Without a
 * `day`, an hour already past is that hour tomorrow; a `day` and `hour` in the past are refused. Nothing that runs on the
 * hour or the day is replayed for the time skipped — this is a debugging aid for a frame or a scene, not a fast-forward.
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
  return { day: city.day, hour: city.hour, minute: city.minute, tick: w.tick };
}
