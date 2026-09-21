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
/** A toast the screen remembers: a line of the feed and the real time it was stamped with. */
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
  /** False once its time ran out. It is remembered so the clock alone can never put it back up. */
  readonly visible: boolean;
}

export interface ShownToasts {
  /** Every line the screen remembers, the retired ones included; the caller passes this back. */
  readonly shown: readonly ShownToast[];
  /** The lines to draw, in the feed's order. */
  readonly visible: readonly ShownToast[];
  /** Whether a toast was stamped or retired, so a caller can repaint only then. */
  readonly changed: boolean;
}

const toastKey = (line: { readonly kind: NotificationKind; readonly text: string }): string => `${line.kind}\u0000${line.text}`;

/**
 * The screen at `timeNow`: a line the screen has never seen, and one the feed has counted again since
 * it was last stamped, is stamped with `timeNow`; a line whose duration has run out since its stamp
 * retires. A retired line stays in `shown` and off `visible` until a new occurrence bumps the feed's
 * count for it — the clock alone may never put it back, and Rust's rule that only a `push` clears
 * `last_at` is what that keeps.
 *
 * Pure — neither `feed` nor `shown` is touched, so nothing a wall clock decides can reach the world or
 * its fingerprint. Rust's `stamp_and_expire` mutated `Notifications::messages` in place and could,
 * because there the feed was not simulation state; here `shown` is the caller's own memory of the
 * screen and comes back on the next call.
 */
export function stampAndExpire(feed: readonly Notification[], shown: readonly ShownToast[], timeNow: number): ShownToasts {
  const remembered = new Map<string, ShownToast>();
  for (const toast of shown) remembered.set(toastKey(toast), toast);

  const next: ShownToast[] = [];
  const visible: ShownToast[] = [];
  let changed = false;
  for (const line of feed) {
    const was = remembered.get(toastKey(line));
    // A count past the one it was stamped with is a fresh occurrence, and the lifetime restarts from
    // it: Rust cleared `last_at` in `push` for exactly this. Anything else leaves the stamp alone,
    // so a line the player already watched retire stays retired.
    const fresh = was === undefined || line.count > was.count;
    // A retired line keeps the stamp it retired with, so the clock only ever carries it further past
    // its duration: nothing but a fresh occurrence can put it back up.
    const stamp = fresh ? timeNow : was.lastAt;
    const up = timeNow - stamp < line.duration;
    if (fresh || up !== was.visible) changed = true;
    const toast: ShownToast =
      !fresh && up === was.visible
        ? was
        : { text: line.text, kind: line.kind, count: line.count, at: line.at, lastAt: stamp, duration: line.duration, visible: up };
    next.push(toast);
    if (up) visible.push(toast);
  }
  return { shown: next, visible, changed };
}
