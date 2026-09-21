// Port of the feed in crates/simcity_sim/src/game/notifications.rs: toasts and the dated history.
// Toast lifetimes are stamped on real time. Rust did it in a render-side system; here `stampAndExpire`
// takes the clock reading as an argument, so the feed stays free of a clock and the host calls it from
// the HUD stage. No simulation system calls it, and `lastAt` is real time, so it stays out of the
// fingerprint.
import type { TilePos } from './commands';

export type NotificationKind = 'Info' | 'Warning' | 'Error' | 'Achievement';

/** How many past events the feed remembers. */
export const HISTORY_LINES = 30;

/** One past event: what happened and on which game day, a repeat in a row counted on its line. */
export interface HistoryLine {
  readonly day: number;
  readonly text: string;
  readonly kind: NotificationKind;
  count: number;
}

export interface Notification {
  readonly text: string;
  readonly kind: NotificationKind;
  count: number;
  at: TilePos | null;
  /** Real time of the latest occurrence; `null` until the feed stamps it. */
  lastAt: number | null;
  /** Seconds on screen, `f32`. */
  duration: number;
}

export class Notifications {
  private toasts: Notification[] = [];
  private readonly lines: HistoryLine[] = [];
  /** The game day new events are dated with. */
  private day = 0;
  private version = 0;

  add(text: string, kind: NotificationKind, duration: number): void {
    this.push(text, kind, duration, null);
  }

  /** Like `add`, for an event that happened somewhere on the map. */
  addAt(text: string, kind: NotificationKind, duration: number, at: TilePos): void {
    this.push(text, kind, duration, at);
  }

  messages(): readonly Notification[] {
    return this.toasts;
  }

  /** The last events, oldest first. */
  history(): readonly HistoryLine[] {
    return this.lines;
  }

  /** Bumps whenever the history changes. */
  historyVersion(): number {
    return this.version;
  }

  /** Date the events that arrive from now on with `day`. */
  setDay(day: number): void {
    this.day = day;
  }

  currentDay(): number {
    return this.day;
  }

  /**
   * Stamp lines that arrived since the last call and drop the ones whose time is up. Returns whether a
   * line was stamped or dropped, so a caller can mark the feed changed only then.
   */
  stampAndExpire(timeNow: number): boolean {
    let stamped = false;
    for (const line of this.toasts) {
      if (line.lastAt === null) {
        line.lastAt = timeNow;
        stamped = true;
      }
    }
    const before = this.toasts.length;
    this.toasts = this.toasts.filter((line) => line.lastAt !== null && timeNow - line.lastAt < line.duration);
    return stamped || this.toasts.length !== before;
  }

  /**
   * Same text and severity is the same line: it counts up, takes the newest place and moves to the end,
   * and its lifetime restarts from this occurrence.
   */
  private push(text: string, kind: NotificationKind, duration: number, at: TilePos | null): void {
    const day = this.day;
    const last = this.lines.at(-1);
    if (last !== undefined && last.kind === kind && last.text === text && last.day === day) {
      last.count += 1;
    } else {
      this.lines.push({ day, text, kind, count: 1 });
      if (this.lines.length > HISTORY_LINES) this.lines.shift();
    }
    this.version += 1;

    const index = this.toasts.findIndex((line) => line.kind === kind && line.text === text);
    const d = Math.fround(duration);
    if (index >= 0) {
      const [line] = this.toasts.splice(index, 1);
      line!.count += 1;
      line!.at = at ?? line!.at;
      line!.lastAt = null;
      line!.duration = Math.max(line!.duration, d);
      this.toasts.push(line!);
    } else {
      this.toasts.push({ text, kind, count: 1, at, lastAt: null, duration: d });
    }
  }
}
