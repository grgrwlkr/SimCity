// The HUD bar: layout of docs/design/hud/layout.md §2, the dev gate of rust-final
// crates/simcity_frontend/src/game/ui/dev_ui_gate.rs and hud/hud_bar.rs (money format, no dev element).
import type { WorldSnapshot } from '@simcity/bridge';
import { defaultCity } from '@simcity/sim';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Hud, type HudActions } from '../src/Hud';
import { HudBar, formatMoney } from '../src/HudBar';
import { useSimStore } from '../src/store';

const actions: HudActions = { setState: () => {}, setSpeed: () => {}, scenarioHref: (s) => `?scenario=${s.query}` };

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

const bar = (s: WorldSnapshot, debug: boolean, fps: number | null = 60) => renderToStaticMarkup(createElement(HudBar, { snapshot: s, fps, debug, actions }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ');
const DEV_IDS = ['fps', 'tick', 'sim-tick', 'citizens', 'driving', 'emergencies'];

describe('HUD bar', () => {
  it('hudBarFormatsMoneyWithGroupedDigits', () => {
    expect(formatMoney(37_994)).toBe('$37\u00a0994');
    expect(formatMoney(1_234_567)).toBe('$1\u00a0234\u00a0567');
    expect(formatMoney(-1234)).toBe('-$1\u00a0234');
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(999)).toBe('$999');
  });

  it('hudBarShowsMoneyDayHourAndPopulation', () => {
    const html = bar(snapshot(), false);
    expect(html).toContain('$37\u00a0994');
    expect(text(html)).toMatch(/День 3, 09:05(?!:)/);
    expect(text(html)).toMatch(/Население\s+120/);
  });

  it('negativeMoneyIsMarked', () => {
    expect(bar(snapshot({ money: -500 }), false)).toMatch(/data-negative="true"[^>]*>-\$500</);
    expect(bar(snapshot(), false)).not.toContain('data-negative="true"');
  });

  it('eachSpeedIsOneButtonAndTheCurrentOneIsPressed', () => {
    const html = bar(snapshot(), false);
    const buttons = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)].map((m) => [m[2], m[1]]);
    expect(buttons).toEqual([['Стоп', 'false'], ['×1', 'false'], ['×3', 'true'], ['×10', 'false'], ['×60', 'false'], ['×360', 'false']]);
  });

  it('devUiGatedWithoutDebugFlag', () => {
    const html = bar(snapshot(), false);
    expect(text(html)).not.toMatch(/FPS|тик|сим \d/);
    for (const id of DEV_IDS) expect(html).not.toContain(`data-testid="${id}"`);
  });

  it('devUiShownUnderDebugFlag', () => {
    const html = bar(snapshot(), true);
    expect(text(html)).toMatch(/FPS 60/);
    expect(text(html)).toMatch(/тик 4321/);
    for (const id of DEV_IDS) expect(html).toContain(`data-testid="${id}"`);
  });

  it('devUiGatedGameInterfaceShowsNoDeveloperElement', () => {
    // A server render reads the store's initial state object (useSyncExternalStore's server snapshot, zustand 5).
    const initial = useSimStore.getInitialState() as { snapshot: WorldSnapshot | null; fps: number | null };
    Object.assign(initial, { snapshot: snapshot({}, { appState: 'MainMenu' }), fps: 60 });
    let html: string;
    try {
      html = renderToStaticMarkup(createElement(Hud, { actions, debug: true }));
    } finally {
      Object.assign(initial, { snapshot: null, fps: null });
    }
    expect(html).toContain('data-testid="start"');
    expect(text(html)).not.toMatch(/FPS|тик/);
  });
});
