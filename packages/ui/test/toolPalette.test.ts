// The tool palette and its hotkeys: layout of docs/design/hud/layout.md §3, states of states.md. Ports the tests of
// rust-final crates/simcity_frontend/src/game/hud/tool_palette.rs and the hotkey and focus-gate tests of
// crates/simcity_sim/src/game/map/tests.rs under their camelCase names.
import { ZONE_DENSITIES } from '@simcity/sim';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOOL_STATE,
  PALETTE_TOOLS,
  ToolPaletteView,
  activateDensity,
  activateTool,
  buildModeHotkey,
  hotkeyFor,
  keyboardCaptured,
  toolKey,
  toggleOneWay,
  undoRedoHotkey,
  type ToolMode,
  type ToolState,
} from '../src/ToolPalette';

const noop = () => {};
type Milestones = { readonly bestPopulation: number } | null;

const palette = (state: ToolState = DEFAULT_TOOL_STATE, milestones: Milestones = null) =>
  renderToStaticMarkup(createElement(ToolPaletteView, { state, milestones, onTool: noop, onDensity: noop, onOneWay: noop }));

/** Every `<button …>…</button>` of the markup with its attributes and its text. */
function buttons(html: string): { attrs: string; inner: string; text: string }[] {
  return [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map((m) => ({ attrs: m[1]!, inner: m[2]!, text: m[2]!.replace(/<[^>]+>/g, ' ') }));
}

const buttonFor = (html: string, key: string) => {
  const found = buttons(html).filter((b) => b.attrs.includes(`data-tool="${key}"`));
  expect(found, key).toHaveLength(1);
  return found[0]!;
};

/** The text of the hotkey chips under a button. */
const hotkeyLabels = (inner: string) => [...inner.matchAll(/data-hotkey="[^"]*">([^<]*)</g)].map((m) => m[1]);

const pressed = (attrs: string) => attrs.includes('aria-pressed="true"');

const oneWayButton = (html: string) => {
  const found = buttons(html).filter((b) => b.attrs.includes('data-testid="tool-one-way"'));
  expect(found).toHaveLength(1);
  return found[0]!;
};

const key = (code: string, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}) => ({ code, ctrlKey: false, metaKey: false, ...mods });

describe('tool palette', () => {
  it('milestoneLockedToolButtonSaysWhenItUnlocksAndIsNotPicked', () => {
    const fresh = { bestPopulation: 0 };
    const html = palette(DEFAULT_TOOL_STATE, fresh);
    const school = buttonFor(html, 'School');
    expect(school.attrs).toContain('aria-disabled="true"');
    expect(school.attrs).not.toMatch(/\sdisabled(=|\s|$)/);
    expect(school.text).toContain('Откроется при 250 жителях');
    expect(school.attrs).toContain('title="Откроется при 250 жителях"');
    const park = buttonFor(html, 'Park');
    expect(park.attrs, 'a park is open from the start').not.toContain('aria-disabled');
    expect(park.text).not.toContain('Откроется');
    const inspect: ToolState = { ...DEFAULT_TOOL_STATE, tool: { kind: 'Inspect' } };
    expect(activateTool(inspect, { kind: 'School' }, fresh).tool, 'a locked tool is not picked').toEqual({ kind: 'Inspect' });

    const grown = { bestPopulation: 300 };
    const open = buttonFor(palette(DEFAULT_TOOL_STATE, grown), 'School');
    expect(open.attrs).not.toContain('aria-disabled');
    expect(open.text).not.toContain('Откроется');
    expect(activateTool(inspect, { kind: 'School' }, grown).tool).toEqual({ kind: 'School' });
  });

  it('zoneDensityButtonsPickTheDensityTheZoneToolsPaint', () => {
    for (const density of ZONE_DENSITIES.filter((d) => d !== 'Tower')) {
      const state = activateDensity(DEFAULT_TOOL_STATE, density);
      expect(state.zoneDensity).toBe(density);
      const lit = buttons(palette(state)).filter((b) => b.attrs.includes('data-density=') && pressed(b.attrs));
      expect(lit.map((b) => b.attrs.match(/data-density="(\w+)"/)![1]), `${density} lights up once chosen`).toEqual([density]);
    }
  });

  it('uiShellToolPaletteOffersEveryPlayerToolOnceUnderAGameUiRoot', () => {
    const html = palette();
    expect(html.match(/class="hud-tools"/g), 'the palette is one game-interface root').toHaveLength(1);
    expect(html.startsWith('<div class="hud-tools"')).toBe(true);
    expect(PALETTE_TOOLS).toHaveLength(18);
    for (const tool of PALETTE_TOOLS) buttonFor(html, toolKey(tool));
    const all = buttons(html);
    expect(all.filter((b) => b.attrs.includes('data-tool=')), 'no button for a tool the player does not have').toHaveLength(18);
    // Every tool, the one-way toggle and the three densities are plain buttons of the one toolbar.
    expect(all).toHaveLength(18 + 1 + 3);
    expect(html.match(/role="toolbar"/g)).toHaveLength(1);
    for (const b of all) expect(b.attrs).toContain('type="button"');
  });

  it('uiShellOneActivationOfAToolButtonSelectsTheTool', () => {
    for (const tool of PALETTE_TOOLS) {
      const from: ToolState = { ...DEFAULT_TOOL_STATE, tool: tool.kind === 'Inspect' ? { kind: 'Erase' } : { kind: 'Inspect' } };
      // Without milestones in the snapshot nothing is locked, as in Rust without the resource.
      expect(activateTool(from, tool, null).tool).toEqual(tool);
    }
  });

  it('uiShellTheOneWayToggleFlipsOneWayBuildingAndKeepsTheTool', () => {
    const commercial: ToolState = { ...DEFAULT_TOOL_STATE, tool: { kind: 'Commercial' } };
    const on = toggleOneWay(commercial);
    expect(on.oneWay).toBe(true);
    expect(on.tool, 'one-way is a modifier, not a tool').toEqual({ kind: 'Commercial' });
    expect(toggleOneWay(on).oneWay).toBe(false);
  });

  it('uiShellHotkeysPrintedOnButtonsAreTheKeysThatPickThem', () => {
    expect(hotkeyFor({ kind: 'Residential' })).toBe('Digit2');
    expect(hotkeyFor({ kind: 'Commercial' })).toBe('Digit3');
    expect(hotkeyFor({ kind: 'Industrial' })).toBe('Digit4');
    expect(hotkeyFor({ kind: 'Erase' })).toBe('Digit5');
    for (const road of ['TwoLane', 'FourLane', 'SixLane'] as const) {
      expect(hotkeyFor({ kind: 'Road', road }), '1 cycles through the road kinds, so it reaches each of them').toBe('Digit1');
    }
    expect(hotkeyFor({ kind: 'Inspect' })).toBeUndefined();
    expect(hotkeyFor({ kind: 'FireStation' })).toBeUndefined();

    const html = palette();
    const cases: [ToolMode, string[]][] = [
      [{ kind: 'Residential' }, ['2']],
      [{ kind: 'Erase' }, ['5']],
      [{ kind: 'Road', road: 'SixLane' }, ['1']],
      [{ kind: 'Inspect' }, []],
    ];
    for (const [tool, expected] of cases) expect(hotkeyLabels(buttonFor(html, toolKey(tool)).inner), toolKey(tool)).toEqual(expected);
    expect(hotkeyLabels(oneWayButton(html).inner)).toEqual(['O']);
    expect(oneWayButton(html).attrs).toContain('aria-keyshortcuts="O"');
  });

  it('uiShellTheActiveToolAndOneWayAreHighlighted', () => {
    const html = palette({ ...DEFAULT_TOOL_STATE, tool: { kind: 'Commercial' }, oneWay: true });
    for (const tool of PALETTE_TOOLS) expect(pressed(buttonFor(html, toolKey(tool)).attrs), toolKey(tool)).toBe(tool.kind === 'Commercial');
    expect(pressed(oneWayButton(html).attrs), 'one-way on reads as on').toBe(true);
    expect(pressed(oneWayButton(palette()).attrs)).toBe(false);
  });

  it('devUiGatedToolPaletteShowsNoDeveloperElement', () => {
    const shown = palette().replace(/<[^>]+>/g, ' ').toLowerCase();
    expect(shown.trim().length, 'the check needs the real palette, not an empty tree').toBeGreaterThan(0);
    for (const marker of ['seed', 'new map', 'test city', 'dump', 'debug', 'новая карта', 'тестовый город']) {
      expect(shown, `the palette shows a developer element \`${marker}\``).not.toContain(marker);
    }
  });
});

// Ф0: keyboard hotkeys stand down while a text field owns the keyboard (map/tests.rs).
describe('tool hotkeys', () => {
  it('buildModeHotkeySwitchesToolWhenKeyboardIsFree', () => {
    expect(buildModeHotkey(DEFAULT_TOOL_STATE, key('Digit2'), false).tool, 'with no widget focused, a digit must still pick its tool').toEqual({
      kind: 'Residential',
    });
    // 1 cycles the road kinds.
    const two = buildModeHotkey(DEFAULT_TOOL_STATE, key('Digit1'), false);
    expect(two.tool).toEqual({ kind: 'Road', road: 'TwoLane' });
    const four = buildModeHotkey(two, key('Digit1'), false);
    expect(four.tool).toEqual({ kind: 'Road', road: 'FourLane' });
    expect(buildModeHotkey(buildModeHotkey(four, key('Digit1'), false), key('Digit1'), false).tool).toEqual({ kind: 'Road', road: 'TwoLane' });
    // A browser shortcut on a digit is the browser's.
    expect(buildModeHotkey(DEFAULT_TOOL_STATE, key('Digit2', { metaKey: true }), false)).toBe(DEFAULT_TOOL_STATE);
  });

  it('buildModeHotkeyIsIgnoredWhileKeyboardIsCaptured', () => {
    expect(buildModeHotkey(DEFAULT_TOOL_STATE, key('Digit2'), true).tool, 'typing into a text field must not switch the active tool').toEqual(
      DEFAULT_TOOL_STATE.tool,
    );
  });

  it('oneWayHotkeyTogglesTheMode', () => {
    expect(buildModeHotkey(DEFAULT_TOOL_STATE, key('KeyO'), false).oneWay, 'one-way had full support downstream but no way to reach it from input').toBe(
      true,
    );
  });

  it('oneWayHotkeyIsIgnoredWhileKeyboardIsCaptured', () => {
    expect(buildModeHotkey(DEFAULT_TOOL_STATE, key('KeyO'), true).oneWay, 'typing the letter O into a field must not flip road direction').toBe(false);
  });

  it('undoHotkeyIsIgnoredWhileKeyboardIsCaptured', () => {
    expect(undoRedoHotkey(key('KeyZ', { ctrlKey: true }), true), 'Ctrl+Z inside a text field belongs to the field, not to the map history').toBeNull();
    expect(undoRedoHotkey(key('KeyZ', { ctrlKey: true }), false)).toBe(false);
    expect(undoRedoHotkey(key('KeyY', { ctrlKey: true }), false)).toBe(true);
    expect(undoRedoHotkey(key('KeyZ'), false), 'a bare Z is no undo').toBeNull();
  });

  it('keyboardIsCapturedByATextFieldOnly', () => {
    expect(keyboardCaptured({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(keyboardCaptured({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(keyboardCaptured({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(keyboardCaptured({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(keyboardCaptured(null)).toBe(false);
  });
});
