// The HUD bar: layout of docs/design/hud/layout.md §2. Ports rust-final crates/simcity_frontend/src/game/hud/hud_bar.rs,
// ui/dev_ui_gate.rs and ui/window_title.rs under their camelCase names.
import type { WorldSnapshot } from '@simcity/bridge';
import { defaultCity } from '@simcity/sim';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Hud, type HudActions } from '../src/Hud';
import { HudBar, formatMoney, windowTitle } from '../src/HudBar';
import { useSimStore } from '../src/store';

const actions: HudActions = { setState: () => {}, setSpeed: () => {}, scenarioHref: (s) => `?scenario=${s.query}`, command: () => {}, undoRedo: () => {}, focusTile: () => {} };

function snapshot(city: Partial<WorldSnapshot['city']> = {}, rest: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    tick: 4321,
    appState: 'InGame',
    speed: 'X3',
    realRate: 3,
    errors: [],
    mapSeed: '1',
    city: { ...defaultCity(), day: 3, hour: 9, minute: 5, second: 42, money: 37_994, population: 120, ...city },
    mapEditVersion: 1,
    graphVersion: 1,
    lights: [],
    traffic: {
      driving: 11, parked: 2, waitingAtLights: 0, stuckOverMinute: 0, avgSpeedKmh: 30, backlog: 0, avgCongestionPct: 5,
      trucks: 1, pedestrians: 3, regional: 0, citizens: 2000, travelling: 50, tripsStarted: 9, tripsDone: 4, simTickMs: 1.2,
    },
    services: { emergencies: [], vehicles: 0, vehiclesOut: 0, buses: 0, resolved: 0, failed: 0 },
    ...rest,
  } as WorldSnapshot;
}

const bar = (s: WorldSnapshot, debug: boolean, fps: number | null = 60) => renderToStaticMarkup(createElement(HudBar, { snapshot: s, fps, debug, actions, budgetOpen: false, onBudgetToggle: () => {} }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ');
const count = (html: string, needle: string) => html.split(needle).length - 1;
const DEV_IDS = ['fps', 'tick', 'sim-tick', 'citizens', 'driving', 'emergencies'];
/** `EVERY_DEV_ELEMENT` of dev_ui_gate.rs, plus the port's own tick and sim-cost rows. */
const DEV_WORDS = ['fps', 'mcp', 'seed', 'dump', 'test city', 'тик', 'сим '];

/** The whole HUD as a server render: it reads the store's initial state object (zustand 5's server snapshot). */
function renderHud(s: WorldSnapshot, debug: boolean): string {
  const initial = useSimStore.getInitialState() as { snapshot: WorldSnapshot | null; fps: number | null };
  Object.assign(initial, { snapshot: s, fps: 60 });
  try {
    return renderToStaticMarkup(createElement(Hud, { actions, debug }));
  } finally {
    Object.assign(initial, { snapshot: null, fps: null });
  }
}

describe('HUD bar', () => {
  it('uiShellMoneyReadsWithGroupedThousands', () => {
    expect(formatMoney(37_994)).toBe('$37 994');
    expect(formatMoney(1_250_000)).toBe('$1 250 000');
    expect(formatMoney(-1_234)).toBe('-$1 234');
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(999)).toBe('$999');
  });

  it('uiShellHudBarIsOneGameUiRootWithItsFourReadouts', () => {
    const html = bar(snapshot(), false);
    for (const id of ['hud', 'money', 'clock', 'population']) expect(count(html, `data-testid="${id}"`), id).toBe(1);
    // The port's ladder has six speeds, not Rust's pause and three (layout.md §2); the current one is pressed.
    const buttons = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)].map((m) => [m[2], m[1]]);
    expect(buttons).toEqual([['Стоп', 'false'], ['×1', 'false'], ['×3', 'true'], ['×10', 'false'], ['×60', 'false'], ['×360', 'false']]);
  });

  it('uiShellHudBarShowsTheCity', () => {
    const html = bar(snapshot(), false);
    expect(html).toContain('$37 994');
    expect(text(html)).toMatch(/День 3, 09:05(?!:)/);
    expect(text(html)).toMatch(/Население\s+120/);
  });

  it('negativeMoneyIsMarked', () => {
    expect(bar(snapshot({ money: -500 }), false)).toMatch(/data-negative="true"[^>]*>-\$500</);
    expect(bar(snapshot(), false)).not.toContain('data-negative="true"');
  });

  it('devUiGatedReleaseFrontendRegistersNoDeveloperPanel', () => {
    const html = bar(snapshot(), false);
    expect(html).toContain('data-testid="hud"');
    expect(html).not.toContain('hud-dev');
    for (const id of DEV_IDS) expect(html).not.toContain(`data-testid="${id}"`);
  });

  it('devUiShownUnderDebugFlag', () => {
    const html = bar(snapshot(), true);
    expect(text(html)).toMatch(/FPS 60/);
    expect(text(html)).toMatch(/тик 4321/);
    for (const id of DEV_IDS) expect(html).toContain(`data-testid="${id}"`);
  });

  it('devUiGatedComposedReleaseInterfaceCarriesNoDeveloperElement', () => {
    // In a city, then in the menu.
    const texts = [text(renderHud(snapshot(), false)), text(renderHud(snapshot({}, { appState: 'MainMenu' }), false))].map((t) => t.toLowerCase());
    // The harness must see the real interface, or an absent element proves nothing.
    for (const piece of ['$37 994', 'население', 'новая игра', 'сценарии']) expect(texts.some((t) => t.includes(piece)), piece).toBe(true);
    for (const word of DEV_WORDS) expect(texts.some((t) => t.includes(word)), word).toBe(false);
  });

  it('devUiGatedTheWindowTitleSpeaksToThePlayerNotInDebugFormatting', () => {
    const city = { ...defaultCity(), day: 7, money: 4_200, population: 90 };
    const title = windowTitle('InGame', city);
    expect(title).toBe('SimCity — День 7 — $4 200 — Население 90');
    for (const leak of ['FireStation', 'Build:', 'debug', '{']) expect(title).not.toContain(leak);
    expect(windowTitle('Paused', city)).toBe('SimCity — Пауза — День 7 — $4 200 — Население 90');
    expect(windowTitle('MainMenu', city)).toBe('SimCity');
  });
});
