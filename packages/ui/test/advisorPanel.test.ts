// The advisor's panel (docs/design/hud/layout.md §8, states.md). Ports the three `mod tests` cases of rust-final
// crates/simcity_frontend/src/game/hud/advisor_panel.rs under their camelCase names, plus what the web panel adds:
// a problem with a place takes the camera there, and a press or a wheel on the panel never reaches the map.
// The history comes the way the host makes it (`Notifications`), the problems in the snapshot's `advisor` shape.
import { readFileSync } from 'node:fs';
import type { AdvisorProblemView } from '@simcity/bridge';
import { DEFAULT_MAP_CONFIG, Notifications, tileToWorld, type HistoryLine, type TilePos } from '@simcity/sim';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ADVISOR_TOGGLE_ID, AdvisorPanel, focusOnOpen, AdvisorToggle, RECENT_EVENTS, type AdvisorPanelProps } from '../src/AdvisorPanel';
import { focusViewOn } from '../src/Toasts';

const advisorCss = readFileSync(new URL('../src/advisorPanel.css', import.meta.url), 'utf8');

/** The body of the one rule for `selector` in advisorPanel.css. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(advisorCss);
  if (match === null) throw new Error(`${selector} is missing from advisorPanel.css`);
  return match[1]!;
}

type Element = ReactElement<Record<string, unknown>>;

/** Every host element of a tree, in document order. */
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as Element;
  return [el, ...elements(el.props.children as ReactNode)];
}

function problem(kind: string, severity: number, text: string, at: TilePos | null = null): AdvisorProblemView {
  return { kind, severity, text, at };
}

const noop = () => {};

function props(advisor: readonly AdvisorProblemView[], history: readonly HistoryLine[] = [], open = true): AdvisorPanelProps {
  return { snapshot: { advisor, history }, open, onClose: noop, onFocus: noop };
}

/** Every line the panel shows, top to bottom, as its visible text; nothing when it is closed. */
function texts(p: AdvisorPanelProps): string[] {
  const html = renderToStaticMarkup(createElement(AdvisorPanel, p));
  return (html.match(/<(h[23]|p|li|button|span)[^>]*>[^<]+</g) ?? []).map((tag) => tag.replace(/<[^>]+>/g, '').replace(/<$/, '').trim());
}

const FOUR_PROBLEMS = [
  problem('WaterShortage', 0.9, 'Water shortage: pumps supply 5 000, the city needs 6 200'),
  problem('Unemployment', 0.5, 'Unemployment 18%: 180 residents have no job, most of them low-income'),
  problem('HousingWanted', 0.3, 'Homes wanted: residential demand is 72%'),
  problem('FireRisk', 0.2, 'Fire risk in 15% of the city: fire stations cover 30% of buildings'),
];

describe('advisor panel', () => {
  // rust-final advisor_panel.rs advisor_panel_opens_from_the_hud_and_names_the_worst_problems. The HUD owns `open`
  // (as it does the budget's): the toggle hands the press to `onToggle`, the panel draws what `open` says.
  it('advisorPanelOpensFromTheHudAndNamesTheWorstProblems', () => {
    let open = false;
    const toggle = () => AdvisorToggle({ open, onToggle: () => (open = !open) }) as Element;
    expect(toggle().type, 'the HUD control is a button').toBe('button');
    expect(toggle().props.id).toBe(ADVISOR_TOGGLE_ID);
    expect(toggle().props['aria-pressed']).toBe(false);
    expect(texts(props(FOUR_PROBLEMS, [], open)), 'the advisor starts closed').toEqual([]);

    (toggle().props.onClick as () => void)();
    expect(open).toBe(true);
    expect(toggle().props['aria-pressed']).toBe(true);
    const shown = texts(props(FOUR_PROBLEMS, [], open));
    for (const expected of FOUR_PROBLEMS.slice(0, 3).map((p) => p.text)) expect(shown, expected).toContain(expected);
    expect(shown.some((text) => text.startsWith('Fire risk')), `three problems, not a wall: ${JSON.stringify(shown)}`).toBe(false);

    // layout.md §8: the worst is larger than the two after it — the whole hierarchy of the panel.
    const html = renderToStaticMarkup(createElement(AdvisorPanel, props(FOUR_PROBLEMS)));
    expect(html.match(/advisor-problem advisor-worst/g)).toHaveLength(1);
    expect(html.indexOf('advisor-worst')).toBeLessThan(html.indexOf('Water shortage'));
    expect(html.indexOf('Water shortage')).toBeLessThan(html.indexOf('Unemployment'));
    expect(rule('.advisor-worst')).toMatch(/font-size:\s*var\(--hud-size-title\)/);
    expect(rule('.advisor-problem')).toMatch(/font-size:\s*var\(--hud-size-body\)/);

    (toggle().props.onClick as () => void)();
    expect(open).toBe(false);
    expect(texts(props(FOUR_PROBLEMS, [], open))).toEqual([]);
  });

  // rust-final advisor_panel.rs advisor_panel_lists_recent_events_with_their_day. The port says «День N» (layout.md §8).
  it('advisorPanelListsRecentEventsWithTheirDay', () => {
    const feed = new Notifications();
    feed.setDay(3);
    feed.add('250 residents: School unlocked', 'Achievement', 12);
    feed.setDay(5);
    feed.add('Fire emergency responded', 'Info', 3);
    feed.add('Fire emergency responded', 'Info', 3);
    const shown = texts(props([], feed.history()));
    for (const expected of ['Последние события', 'День 3: 250 residents: School unlocked', 'День 5: Fire emergency responded ×2']) {
      expect(shown, expected).toContain(expected);
    }
    // Newest first.
    expect(shown.indexOf('День 5: Fire emergency responded ×2')).toBeLessThan(shown.indexOf('День 3: 250 residents: School unlocked'));

    const busy = new Notifications();
    for (let day = 1; day <= 8; day += 1) {
      busy.setDay(day);
      busy.add(`event ${day}`, 'Info', 3);
    }
    expect(RECENT_EVENTS).toBe(5);
    expect(texts(props([], busy.history())).filter((text) => text.startsWith('День'))).toEqual(
      ['День 8: event 8', 'День 7: event 7', 'День 6: event 6', 'День 5: event 5', 'День 4: event 4'],
    );
  });

  // rust-final advisor_panel.rs advisor_panel_says_when_nothing_needs_attention; states.md: a healthy city is one
  // line, and the events block shows only when the history is not empty.
  it('advisorPanelSaysWhenNothingNeedsAttention', () => {
    const shown = texts(props([]));
    expect(shown).toContain('Ничего не требует внимания');
    expect(shown).not.toContain('Последние события');
    expect(renderToStaticMarkup(createElement(AdvisorPanel, props([])))).toContain('class="advisor-problem advisor-worst"');
  });

  // The web panel's own: a problem with a place is a button that takes the camera there, as a toast does.
  it('advisorPanelProblemWithAPlaceTakesTheCameraThere', () => {
    const focused: TilePos[] = [];
    const tree = AdvisorPanel({
      ...props([problem('Crime', 0.8, 'Crime is up in the east', { x: 41, y: 17 }), problem('HousingWanted', 0.3, 'Homes wanted')]),
      onFocus: (at) => focused.push(at),
    });
    const buttons = elements(tree).filter((el) => el.type === 'button' && el.props['data-testid'] === 'advisor-problem');
    expect(buttons, 'only the problem with a place is a control').toHaveLength(1);
    expect(buttons[0]!.props.title).toBe('Crime is up in the east');
    (buttons[0]!.props.onClick as () => void)();
    expect(focused).toEqual([{ x: 41, y: 17 }]);
    const view = { centerX: 0, centerY: 0 };
    focusViewOn(view, DEFAULT_MAP_CONFIG, focused[0]!);
    const expected = tileToWorld(DEFAULT_MAP_CONFIG, { x: 41, y: 17 });
    expect([view.centerX, view.centerY]).toEqual([expected.x, expected.y]);
    // states.md «Длинный текст»: a problem wraps by words, up to three lines.
    expect(rule('.advisor-problem')).toMatch(/-webkit-line-clamp:\s*3/);
  });

  // states.md «Правило клика сквозь HUD»: a press or a wheel on the panel is the panel's; Esc closes it.
  it('advisorPanelKeepsItsClicksOffTheMapAndClosesOnEscape', () => {
    let closed = 0;
    const root = AdvisorPanel({ ...props([]), onClose: () => (closed += 1) }) as Element;
    expect(root.props['data-testid']).toBe('advisor');
    expect(root.props.tabIndex, 'a click on the panel focuses it, so Esc lands here').toBe(-1);
    for (const name of ['onPointerDown', 'onWheel']) {
      let stopped = false;
      (root.props[name] as (e: { stopPropagation(): void }) => void)({ stopPropagation: () => (stopped = true) });
      expect(stopped, name).toBe(true);
    }
    type Key = { key: string; target: { tagName?: string }; stopPropagation(): void };
    const onKeyDown = root.props.onKeyDown as (e: Key) => void;
    const press = (key: string, tagName: string) => {
      let stopped = false;
      onKeyDown({ key, target: { tagName }, stopPropagation: () => (stopped = true) });
      return stopped;
    };
    expect([press('a', 'SECTION'), closed], 'other keys pass to the game').toEqual([false, 0]);
    // Non-modal: the tool and digit hotkeys still reach the game with a problem focused.
    expect(press('1', 'BUTTON'), 'a digit on a focused problem is a hotkey').toBe(false);
    // Space and Enter on a focused problem press it rather than pausing the game (rev-advisor-panel, finding 2).
    expect(press(' ', 'BUTTON'), 'Space presses the problem').toBe(true);
    expect(press('Enter', 'BUTTON'), 'Enter presses the problem').toBe(true);
    expect(press(' ', 'SECTION'), 'Space on the panel itself still pauses').toBe(false);
    expect(closed).toBe(0);
    expect(press('Escape', 'SECTION'), 'Esc closes the panel, not the game').toBe(true);
    expect(closed).toBe(1);
    // layout.md §8: left column under the data maps, 420 px wide, on the panels' layer.
    expect(rule('.advisor-panel')).toMatch(/top:\s*352px/);
    expect(rule('.advisor-panel')).toMatch(/width:\s*420px/);
    expect(rule('.advisor-panel')).toMatch(/z-index:\s*var\(--hud-z-panel\)/);
    expect(rule('.advisor-panel')).toMatch(/pointer-events:\s*auto/);
  });

  // rev-advisor-panel, finding 1: opening from the toggle puts focus in the panel, so the next Esc closes it rather
  // than taking the game to the menu. `focusOnOpen` is one function for the panel's life: React calls it on mount only.
  it('advisorPanelTakesFocusWhenItOpens', () => {
    const root = AdvisorPanel(props([])) as Element & { props: { ref?: unknown } };
    expect(root.props.ref, 'the panel focuses itself on mount').toBe(focusOnOpen);
    expect((AdvisorPanel(props([])) as Element & { props: { ref?: unknown } }).props.ref, 'the same ref every render').toBe(focusOnOpen);
    const calls: unknown[] = [];
    focusOnOpen({ focus: (options?: unknown) => calls.push(options) } as unknown as HTMLElement);
    focusOnOpen(null);
    expect(calls).toEqual([{ preventScroll: true }]);
    // states.md: the panel stops above the palette and scrolls rather than covering it.
    expect(rule('.advisor-panel')).toMatch(/max-height:/);
    expect(rule('.advisor-panel')).toMatch(/overflow-y:\s*auto/);
  });
});
