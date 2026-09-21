// Port of the feed in crates/simcity_sim/src/game/notifications.rs: toasts and the dated history.
// Toast lifetimes are stamped on real time. In Rust a render-side system stamped the feed's own list;
// here the feed is simulation state and enters the fingerprint, so a wall clock may not touch it:
// `stampAndExpire` is a pure function of the feed, what is already on screen and the clock reading,
// and the HUD stage keeps its result.
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
  /** Seconds on screen, `f32`. */
  duration: number;
}

export class Notifications {
  private readonly toasts: Notification[] = [];
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

  /** Same text and severity is the same line: it counts up, takes the newest place and moves to the end. */
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
      line!.duration = Math.max(line!.duration, d);
      this.toasts.push(line!);
    } else {
      this.toasts.push({ text, kind, count: 1, at, duration: d });
    }
  }
}

/** A toast on screen: a line of the feed and the real time it was stamped with. */
export interface ShownToast {
  readonly text: string;
  readonly kind: NotificationKind;
  /** Occurrences the feed had counted when this toast was last stamped. */
  readonly count: number;
  readonly at: TilePos | null;
  /** Real time of the occurrence the lifetime runs from. */
  readonly lastAt: number;
  /** Seconds on screen, `f32`. */
  readonly duration: number;
}

export interface ShownToasts {
  readonly toasts: readonly ShownToast[];
  /** Whether a toast was stamped or dropped, so a caller can repaint only then. */
  readonly changed: boolean;
}

const toastKey = (line: { readonly kind: NotificationKind; readonly text: string }): string => `${line.kind}\u0000${line.text}`;

/**
 * The toasts on screen at `timeNow`: a line the screen does not have yet, or one the feed has counted
 * again, is stamped with `timeNow`; a line whose duration has run out since its stamp is dropped.
 *
 * Pure — neither `feed` nor `shown` is touched, so nothing a wall clock decides can reach the world or
 * its fingerprint. Rust's `stamp_and_expire` mutated `Notifications::messages` in place and could,
 * because there the feed was not simulation state; here `shown` is the caller's own copy of the screen
 * and comes back on the next call.
 */
export function stampAndExpire(feed: readonly Notification[], shown: readonly ShownToast[], timeNow: number): ShownToasts {
  const up = new Map<string, ShownToast>();
  for (const toast of shown) up.set(toastKey(toast), toast);

  const toasts: ShownToast[] = [];
  let stamped = false;
  for (const line of feed) {
    const was = up.get(toastKey(line));
    // A count that grew means a fresh occurrence and the lifetime restarts from it: Rust cleared
    // `last_at` in `push` for exactly this.
    const toast: ShownToast =
      was !== undefined && was.count === line.count
        ? was
        : { text: line.text, kind: line.kind, count: line.count, at: line.at, lastAt: timeNow, duration: line.duration };
    if (toast !== was) stamped = true;
    if (timeNow - toast.lastAt < toast.duration) toasts.push(toast);
  }
  return { toasts, changed: stamped || toasts.length !== shown.length };
}
