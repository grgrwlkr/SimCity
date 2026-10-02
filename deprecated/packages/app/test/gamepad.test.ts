// The gamepad reaches the same camera and time commands as the keyboard, the mouse and the HUD.
import { OrthoView } from '@simcity/render';
import { describe, expect, it } from 'vitest';
import { applyCameraAction, mapGamepad, PAD, type PadAction, type PadContext, type PadState } from '../src/gamepad';

const inGame: PadContext = { appState: 'InGame', speed: 'X1' };

function pad(opts: { axes?: number[]; pressed?: number[]; values?: Record<number, number> } = {}): PadState {
  const buttons = Array.from({ length: 17 }, (_, i) => {
    const value = opts.values?.[i] ?? (opts.pressed?.includes(i) ? 1 : 0);
    return { pressed: value > 0.5, value };
  });
  return { axes: opts.axes ?? [0, 0, 0, 0], buttons };
}

const idle: readonly boolean[] = pad().buttons.map((b) => b.pressed);
const kinds = (actions: PadAction[]) => actions.map((a) => a.kind);

describe('gamepad buttons', () => {
  it('startTogglesPauseLikeSpace', () => {
    expect(mapGamepad(pad({ pressed: [PAD.start] }), idle, inGame, 0.016)).toEqual([{ kind: 'setState', state: 'Paused' }]);
    expect(mapGamepad(pad({ pressed: [PAD.start] }), idle, { appState: 'Paused', speed: 'X1' }, 0.016)).toEqual([
      { kind: 'setState', state: 'InGame' },
    ]);
  });

  it('startOrAStartsTheGameFromTheMenuLikeEnter', () => {
    const menu: PadContext = { appState: 'MainMenu', speed: 'X1' };
    expect(mapGamepad(pad({ pressed: [PAD.start] }), idle, menu, 0.016)).toEqual([{ kind: 'setState', state: 'InGame' }]);
    expect(mapGamepad(pad({ pressed: [PAD.a] }), idle, menu, 0.016)).toEqual([{ kind: 'setState', state: 'InGame' }]);
    expect(mapGamepad(pad({ pressed: [PAD.a] }), idle, inGame, 0.016)).toEqual([]);
  });

  it('backGoesToTheMenuLikeEscape', () => {
    expect(mapGamepad(pad({ pressed: [PAD.back] }), idle, inGame, 0.016)).toEqual([{ kind: 'setState', state: 'MainMenu' }]);
    expect(mapGamepad(pad({ pressed: [PAD.back] }), idle, { appState: 'MainMenu', speed: 'X1' }, 0.016)).toEqual([]);
  });

  it('bumpersStepTheSpeedLadderAndStopAtItsEnds', () => {
    const at = (speed: PadContext['speed']): PadContext => ({ appState: 'InGame', speed });
    expect(mapGamepad(pad({ pressed: [PAD.rb] }), idle, at('X1'), 0.016)).toEqual([{ kind: 'setSpeed', speed: 'X3' }]);
    expect(mapGamepad(pad({ pressed: [PAD.lb] }), idle, at('X1'), 0.016)).toEqual([{ kind: 'setSpeed', speed: 'Paused' }]);
    expect(mapGamepad(pad({ pressed: [PAD.rb] }), idle, at('X360'), 0.016)).toEqual([]);
    expect(mapGamepad(pad({ pressed: [PAD.lb] }), idle, at('Paused'), 0.016)).toEqual([]);
  });

  it('yFitsTheMap', () => {
    expect(mapGamepad(pad({ pressed: [PAD.y] }), idle, inGame, 0.016)).toEqual([{ kind: 'fitMap' }]);
  });

  it('aHeldButtonActsOnceOnItsPress', () => {
    const held = pad({ pressed: [PAD.start, PAD.rb] });
    const previous = held.buttons.map((b) => b.pressed);
    expect(mapGamepad(held, previous, inGame, 0.016)).toEqual([]);
  });

  it('menuAndSpeedButtonsDoNothingBeforeTheFirstSnapshot', () => {
    expect(mapGamepad(pad({ pressed: [PAD.start, PAD.rb, PAD.back] }), idle, null, 0.016)).toEqual([]);
  });
});

describe('gamepad camera', () => {
  const view = () => {
    const v = new OrthoView({ width: 800, height: 600 });
    v.worldPerPixel = 2;
    return v;
  };

  it('aStickInsideTheDeadZoneDoesNotMoveTheCamera', () => {
    expect(mapGamepad(pad({ axes: [0.1, -0.1, 0.05, 0.1] }), idle, inGame, 0.016)).toEqual([]);
  });

  it('leftStickRightAndUpMovesTheViewEastAndNorth', () => {
    const v = view();
    for (const action of mapGamepad(pad({ axes: [1, -1, 0, 0] }), idle, inGame, 0.5)) applyCameraAction(v, action);
    expect(v.centerX).toBeGreaterThan(0);
    expect(v.centerY).toBeGreaterThan(0);
  });

  it('panSpeedIsScreenPixelsPerSecondWhateverTheFrameLength', () => {
    const one = view();
    const two = view();
    for (const a of mapGamepad(pad({ axes: [1, 0, 0, 0] }), idle, inGame, 0.2)) applyCameraAction(one, a);
    for (let i = 0; i < 2; i++) for (const a of mapGamepad(pad({ axes: [1, 0, 0, 0] }), idle, inGame, 0.1)) applyCameraAction(two, a);
    expect(one.centerX).toBeCloseTo(two.centerX, 6);
  });

  it('dPadPansLikeAFullyTiltedStick', () => {
    const stick = view();
    const dpad = view();
    for (const a of mapGamepad(pad({ axes: [-1, 0, 0, 0] }), idle, inGame, 0.1)) applyCameraAction(stick, a);
    for (const a of mapGamepad(pad({ pressed: [PAD.left] }), idle, inGame, 0.1)) applyCameraAction(dpad, a);
    expect(dpad.centerX).toBeLessThan(0);
    expect(dpad.centerX).toBeCloseTo(stick.centerX, 6);
  });

  it('rightTriggerZoomsInAndLeftTriggerZoomsOutAroundTheCentre', () => {
    const zin = view();
    const zout = view();
    for (const a of mapGamepad(pad({ values: { [PAD.rt]: 1 } }), idle, inGame, 0.25)) applyCameraAction(zin, a);
    for (const a of mapGamepad(pad({ values: { [PAD.lt]: 1 } }), idle, inGame, 0.25)) applyCameraAction(zout, a);
    expect(zin.worldPerPixel).toBeLessThan(2);
    expect(zout.worldPerPixel).toBeGreaterThan(2);
    expect([zin.centerX, zin.centerY, zout.centerX, zout.centerY]).toEqual([0, 0, 0, 0]);
  });

  it('rightStickUpZoomsIn', () => {
    const v = view();
    for (const a of mapGamepad(pad({ axes: [0, 0, 0, -1] }), idle, inGame, 0.25)) applyCameraAction(v, a);
    expect(v.worldPerPixel).toBeLessThan(2);
  });

  it('theCameraMovesInPauseAndInTheMenuToo', () => {
    expect(kinds(mapGamepad(pad({ axes: [1, 0, 0, 0] }), idle, { appState: 'Paused', speed: 'X1' }, 0.016))).toEqual(['pan']);
    expect(kinds(mapGamepad(pad({ axes: [1, 0, 0, 0] }), idle, null, 0.016))).toEqual(['pan']);
  });
});
