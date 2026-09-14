// Gamepad input: the Gamepad API polled once a frame and mapped onto the commands the keyboard, the
// mouse and the HUD already send. Nothing runs until a pad connects.
import type { SimSpeed } from '@simcity/bridge';
import type { DebugRenderer, OrthoView } from '@simcity/render';
import type { AppState } from '@simcity/sim';
import type { SimApi } from './simApi';

/** Button indices of the W3C "standard" gamepad mapping. */
export const PAD = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  back: 8,
  start: 9,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const;

/** The part of a `Gamepad` the mapping reads. */
export interface PadState {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
}

/** What the time buttons need to know; `null` before the first snapshot. */
export interface PadContext {
  readonly appState: AppState;
  readonly speed: SimSpeed;
}

export type PadAction =
  /** Arguments of `OrthoView.panBy`: a drag by screen pixels. */
  | { readonly kind: 'pan'; readonly dxPx: number; readonly dyPx: number }
  /** Argument of `OrthoView.zoomAt` around the viewport centre; below 1 zooms in. */
  | { readonly kind: 'zoom'; readonly factor: number }
  | { readonly kind: 'fitMap' }
  | { readonly kind: 'setState'; readonly state: AppState }
  | { readonly kind: 'setSpeed'; readonly speed: SimSpeed };

/** The HUD's speed buttons, left to right. */
const SPEED_LADDER: readonly SimSpeed[] = ['Paused', 'X1', 'X3', 'X10', 'X60', 'X360'];
const STICK_DEAD_ZONE = 0.2;
const TRIGGER_DEAD_ZONE = 0.05;
/** Screen pixels a second at full tilt. */
const PAN_PX_PER_SEC = 900;
/** The view scales by e^rate a second at full pull: about ×4.5. */
const ZOOM_RATE_PER_SEC = 1.5;

/** A stick axis past the dead zone, rescaled so the edge of the zone is 0 and full tilt is 1. */
function stick(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= STICK_DEAD_ZONE) return 0;
  return (Math.sign(value) * (Math.min(magnitude, 1) - STICK_DEAD_ZONE)) / (1 - STICK_DEAD_ZONE);
}

function trigger(value: number): number {
  return value <= TRIGGER_DEAD_ZONE ? 0 : Math.min(value, 1);
}

/**
 * The actions one poll of a pad asks for. Buttons act on their press edge against `previous`; the
 * sticks, the d-pad and the triggers act for as long as they are held, scaled by `dtSec`.
 */
export function mapGamepad(pad: PadState, previous: readonly boolean[], context: PadContext | null, dtSec: number): PadAction[] {
  const held = (i: number) => pad.buttons[i]?.pressed === true;
  const pressed = (i: number) => held(i) && previous[i] !== true;
  const value = (i: number) => pad.buttons[i]?.value ?? 0;
  const actions: PadAction[] = [];

  if (context !== null) {
    const { appState, speed } = context;
    if (appState === 'MainMenu') {
      if (pressed(PAD.start) || pressed(PAD.a)) actions.push({ kind: 'setState', state: 'InGame' });
    } else {
      if (pressed(PAD.start)) actions.push({ kind: 'setState', state: appState === 'InGame' ? 'Paused' : 'InGame' });
      if (pressed(PAD.back)) actions.push({ kind: 'setState', state: 'MainMenu' });
    }
    const rung = SPEED_LADDER.indexOf(speed);
    if (pressed(PAD.rb) && rung < SPEED_LADDER.length - 1) actions.push({ kind: 'setSpeed', speed: SPEED_LADDER[rung + 1]! });
    if (pressed(PAD.lb) && rung > 0) actions.push({ kind: 'setSpeed', speed: SPEED_LADDER[rung - 1]! });
  }
  if (pressed(PAD.y)) actions.push({ kind: 'fitMap' });

  const dpadX = (held(PAD.right) ? 1 : 0) - (held(PAD.left) ? 1 : 0);
  const dpadY = (held(PAD.down) ? 1 : 0) - (held(PAD.up) ? 1 : 0);
  const panX = Math.max(-1, Math.min(1, stick(pad.axes[0] ?? 0) + dpadX));
  const panY = Math.max(-1, Math.min(1, stick(pad.axes[1] ?? 0) + dpadY));
  if (panX !== 0 || panY !== 0) {
    // `panBy` is a drag: the ground follows the hand, so looking east drags the ground west.
    const step = PAN_PX_PER_SEC * dtSec;
    actions.push({ kind: 'pan', dxPx: -panX * step, dyPx: -panY * step });
  }

  // Positive pulls out: the left trigger and the right stick down.
  const zoom = trigger(value(PAD.lt)) - trigger(value(PAD.rt)) + stick(pad.axes[3] ?? 0);
  if (zoom !== 0) actions.push({ kind: 'zoom', factor: Math.exp(ZOOM_RATE_PER_SEC * zoom * dtSec) });
  return actions;
}

/** A camera action on the view; the other kinds are not the camera's and are ignored. */
export function applyCameraAction(view: OrthoView, action: PadAction): void {
  if (action.kind === 'pan') view.panBy(action.dxPx, action.dyPx);
  else if (action.kind === 'zoom') view.zoomAt(view.viewport.width / 2, view.viewport.height / 2, action.factor);
}

export interface GamepadTarget {
  readonly renderer: Promise<DebugRenderer>;
  readonly api: Pick<SimApi, 'setState' | 'setSpeed' | 'fitMap'>;
  readonly context: () => PadContext | null;
}

/** Polls the first connected pad once a frame while any pad is connected. Returns the uninstaller. */
export function installGamepad(target: GamepadTarget): () => void {
  if (typeof navigator.getGamepads !== 'function') return () => {};
  let frame: number | null = null;
  let last: number | null = null;
  let previous: boolean[] = [];

  const poll = (now: number) => {
    frame = null;
    const pad = navigator.getGamepads().find((p) => p !== null && p.connected) ?? null;
    if (pad === null) {
      last = null;
      previous = [];
      return;
    }
    // A long gap (a hidden window) is not a long tilt.
    const dtSec = last === null ? 0 : Math.min((now - last) / 1000, 0.1);
    last = now;
    const actions = mapGamepad(pad, previous, target.context(), dtSec);
    previous = pad.buttons.map((b) => b.pressed);
    if (actions.length > 0) {
      void target.renderer.then((r) => {
        for (const action of actions) {
          if (action.kind === 'setState') void target.api.setState(action.state);
          else if (action.kind === 'setSpeed') void target.api.setSpeed(action.speed);
          else if (action.kind === 'fitMap') void target.api.fitMap();
          else applyCameraAction(r.view, action);
        }
      });
    }
    frame = requestAnimationFrame(poll);
  };
  const start = () => {
    if (frame === null) frame = requestAnimationFrame(poll);
  };

  window.addEventListener('gamepadconnected', start);
  // A pad connected before the page loaded shows up only on its first button press, as a connect event.
  start();
  return () => {
    window.removeEventListener('gamepadconnected', start);
    if (frame !== null) cancelAnimationFrame(frame);
  };
}
