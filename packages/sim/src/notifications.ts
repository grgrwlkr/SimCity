// Port of the feed in crates/simcity_sim/src/game/notifications.rs: toasts and the dated history.
// Toast lifetimes are stamped on real time by a render-side system in Rust; that part arrives with
// the HUD stage, not in the simulation.
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
