// The toast feed: game events as one line per kind of event, newest on top, each leading to the place it happened.
// Layout of docs/design/hud/layout.md §6, states.md. Port of rust-final crates/simcity_frontend/src/game/hud/toasts.rs.
// The lines are the snapshot's `toasts`: the host already merged repeats and retired the expired ones with
// `stampAndExpire`, so this file only draws them and hands a click's tile to whoever owns the camera.
import { tileToWorld, type MapConfig, type NotificationKind, type ShownToast, type TilePos } from '@simcity/sim';
import type { ReactElement } from 'react';
import { selectToasts, useSimStore } from './store';

/** Lines the feed shows at once; older ones wait out their time unseen (`toasts.rs:17`). */
export const MAX_TOASTS = 4;

/** A line as the player reads it: the message, and how many times it happened when more than once. */
export function toastLabel(text: string, count: number): string {
  return count > 1 ? `${text} ×${count}` : text;
}

/** Puts the camera's centre on the tile, as `on_toast` set `CameraRig::focus` to `tile_to_world`. */
export function focusViewOn(view: { centerX: number; centerY: number }, cfg: MapConfig, at: TilePos): void {
  const focus = tileToWorld(cfg, at);
  view.centerX = focus.x;
  view.centerY = focus.y;
}

/** The kind icons of `docs/design/hud/assets/tools.svg` (`state-*`), inline: the shape carries the kind without colour. */
const KIND_ICON: Record<NotificationKind, ReactElement> = {
  Info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <circle className="solid" cx="12" cy="7.8" r="1.1" />
    </>
  ),
  Warning: (
    <>
      <path d="M12 3.5 21.5 20h-19z" />
      <path d="M12 10v4.5" />
      <circle className="solid" cx="12" cy="17.3" r="1.1" />
    </>
  ),
  Error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.8 8.8 6.4 6.4M15.2 8.8l-6.4 6.4" />
    </>
  ),
  Achievement: <path d="m12 3 2.6 5.4 5.9.8-4.3 4.2 1 5.9L12 16.5 6.8 19.3l1-5.9L3.5 9.2l5.9-.8z" />,
};

export interface ToastFeedProps {
  /** The lines on screen in the feed's order, oldest first, as the snapshot carries them. */
  readonly toasts: readonly ShownToast[];
  /** A click on a line with a place: the camera goes to that tile. */
  onFocus(at: TilePos): void;
}

/** The feed over the given lines. No hooks: it is a plain function of its props. */
export function ToastFeed({ toasts, onFocus }: ToastFeedProps) {
  const newest = toasts.slice(-MAX_TOASTS).reverse();
  return (
    <ol className="hud-toasts" data-testid="toasts" aria-label="События">
      {newest.map((toast) => {
        const label = toastLabel(toast.text, toast.count);
        const at = toast.at;
        return (
          <li key={`${toast.kind}\u0000${toast.text}`}>
            <button
              type="button"
              className="hud-toast"
              data-kind={toast.kind}
              data-testid="toast"
              title={label}
              aria-label={label}
              disabled={at === null}
              onClick={at === null ? undefined : () => onFocus(at)}
            >
              <svg className="hud-toast-icon" viewBox="0 0 24 24" aria-hidden="true">
                {KIND_ICON[toast.kind]}
              </svg>
              <span className="hud-toast-text">{toast.text}</span>
              {toast.count > 1 ? <span className="hud-toast-count">{`×${toast.count}`}</span> : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** The feed over the snapshot's toasts. */
export function Toasts({ onFocus }: { onFocus(at: TilePos): void }) {
  const toasts = useSimStore(selectToasts);
  return <ToastFeed toasts={toasts} onFocus={onFocus} />;
}
