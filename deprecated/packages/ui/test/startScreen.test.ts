// The start screen (docs/design/hud/layout.md §9, states.md). Ports the six `mod tests` cases of rust-final
// crates/simcity_frontend/src/game/hud/start_screen.rs and `menu_first_startup_waits_in_the_main_menu_on_an_empty_map`
// of crates/simcity_data/src/game/headless_sim.rs under their camelCase names. The Bevy app is gone: a button is a
// `<button>` found by its test id, `Activate` is its `onClick`, and what the button asks for reaches the props, which
// is where `ScenarioSelection`, `AutoStartTestCity` and `NextState` were.
import { readFileSync } from 'node:fs';
import { RENDER_CAPACITY, SCENARIOS, SimHost, type WorldSnapshot } from '@simcity/bridge';
import { SCENARIO_PRESETS, defaultCity, thousands, type AppState, type World } from '@simcity/sim';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  StartScreen,
  freshSeed,
  goalsLine,
  menuScenarios,
  type StartScreenEntry,
  type StartScreenProps,
} from '../src/StartScreen';
import { Hud, type HudActions } from '../src/Hud';
import { useSimStore } from '../src/store';

/** The whole HUD in `appState`, as a server render of the store's initial state (the way hudBar.test.ts renders it). */
function renderHud(appState: AppState): string {
  const snapshot = {
    tick: 10,
    appState,
    speed: 'X1',
    realRate: 1,
    errors: [],
    mapSeed: '1',
    city: defaultCity(),
    mapEditVersion: 1,
    graphVersion: 1,
    lights: [],
    traffic: {
      driving: 0, parked: 0, waitingAtLights: 0, stuckOverMinute: 0, avgSpeedKmh: 0, backlog: 0, avgCongestionPct: 0,
      trucks: 0, pedestrians: 0, regional: 0, citizens: 0, travelling: 0, tripsStarted: 0, tripsDone: 0, simTickMs: 0,
    },
    services: { emergencies: [], vehicles: 0, vehiclesOut: 0, buses: 0, resolved: 0, failed: 0 },
    scenario: null,
  } as unknown as WorldSnapshot;
  // Both shapes of `HudActions`, before the start screen is wired into the HUD and after.
  const actions = {
    setState: () => {}, setSpeed: () => {}, start: () => {}, demoCity: () => {}, scenarioHref: () => '',
    command: () => {}, undoRedo: () => {}, focusTile: () => {},
  } as unknown as HudActions;
  const initial = useSimStore.getInitialState() as { snapshot: WorldSnapshot | null; fps: number | null };
  Object.assign(initial, { snapshot, fps: 60 });
  try {
    return renderToStaticMarkup(createElement(Hud, { actions, debug: false }));
  } finally {
    Object.assign(initial, { snapshot: null, fps: null });
  }
}

const css = readFileSync(new URL('../src/startScreen.css', import.meta.url), 'utf8');

/** The body of the one rule for `selector` in startScreen.css. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`${selector} is missing from startScreen.css`);
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

/** The two presets of the Rust test's catalogue, `scenario("sandbox", "Sandbox")` and `scenario("starter", …)`. */
const TWO: readonly StartScreenEntry[] = [
  { name: 'sandbox', title: 'Песочница', objectives: [] },
  { name: 'starter', title: 'Первый город', objectives: [] },
];

function menu(overrides: Partial<StartScreenProps> = {}): StartScreenProps & { onStart: ReturnType<typeof vi.fn>; onDemoCity: ReturnType<typeof vi.fn> } {
  return { scenarios: TWO, onStart: vi.fn(), onDemoCity: vi.fn(), ...overrides } as never;
}

function named(props: StartScreenProps, testId: string): Element {
  const found = elements(StartScreen(props)).find((el) => el.props['data-testid'] === testId);
  if (found === undefined) throw new Error(`nothing is named ${testId}`);
  return found;
}

function activate(props: StartScreenProps, testId: string): void {
  (named(props, testId).props.onClick as () => void)();
}

/** Every line of text the screen shows, lower-cased. */
function shown(props: StartScreenProps): string[] {
  const html = renderToStaticMarkup(createElement(StartScreen, props));
  return (html.match(/>[^<]+</g) ?? []).map((text) => text.slice(1, -1).trim().toLowerCase()).filter((text) => text !== '');
}

const worldOf = (host: SimHost): World => (host as unknown as { world: World }).world;

describe('start screen', () => {
  it('uiShellStartScreenOffersANewMapTheDemoCityAndEveryScenario', () => {
    const props = menu();
    for (const id of ['menu-new-map', 'menu-demo-city', 'menu-scenario-sandbox', 'menu-scenario-starter']) {
      const button = named(props, id);
      expect(button.type, `${id} is a button`).toBe('button');
      expect(button.props.type, `${id} is a button`).toBe('button');
    }
    const tree = elements(StartScreen(props));
    const roots = tree.filter((el) => el.props['data-testid'] === 'hud-menu');
    expect(roots.length, 'one start screen').toBe(1);
    // A layout root: it centres the card, and the card takes the clicks (`Pickable::IGNORE`).
    expect(roots[0]!.props.className).toBe('hud-menu');
    expect(rule('.hud-menu')).toMatch(/pointer-events:\s*none/);
    expect(rule('.hud-menu-card')).toMatch(/pointer-events:\s*auto/);

    // Every scenario of the menu, in its order; the catalogue presets carry their goals.
    const entries = menuScenarios();
    expect(entries.map((e) => e.name)).toEqual(SCENARIOS.map((s) => s.name));
    expect(entries.map((e) => e.title)).toEqual(SCENARIOS.map((s) => s.title));
    for (const preset of SCENARIO_PRESETS) {
      expect(entries.find((e) => e.name === preset.id)?.objectives, preset.id).toEqual(preset.objectives);
    }
    const real = menu({ scenarios: entries });
    for (const s of SCENARIOS) expect(named(real, `menu-scenario-${s.name}`).type).toBe('button');
  });

  it('uiShellPickingAScenarioSelectsItAndStartsTheCity', () => {
    const props = menu();
    activate(props, 'menu-scenario-starter');
    expect(props.onStart).toHaveBeenCalledTimes(1);
    // A scenario keeps its own map: no seed at all, not an undefined one.
    expect(props.onStart.mock.calls[0]![0]).toStrictEqual({ name: 'starter' });
    expect(props.onDemoCity).not.toHaveBeenCalled();
  });

  it('uiShellANewMapStartsTheSandboxOnAFreshSeed', () => {
    const props = menu();
    activate(props, 'menu-new-map');
    activate(props, 'menu-new-map');
    expect(props.onStart).toHaveBeenCalledTimes(2);
    const [first, second] = props.onStart.mock.calls.map((call) => call[0] as { name: string; seed: string });
    expect(first!.name, 'the sandbox').toBe('sandbox');
    for (const { seed } of [first!, second!]) {
      expect(seed, 'on a seed of its own, a u64 in decimal digits').toMatch(/^\d+$/);
      expect(BigInt(seed) <= 2n ** 64n - 1n).toBe(true);
    }
    expect(second!.seed, 'every press is a new map').not.toBe(first!.seed);
    expect(freshSeed()).not.toBe(freshSeed());
  });

  it('uiShellTheDemoCityIsRequestedFromTheMenu', () => {
    const props = menu();
    activate(props, 'menu-demo-city');
    expect(props.onDemoCity).toHaveBeenCalledTimes(1);
    expect(props.onStart).not.toHaveBeenCalled();
  });

  // `show_screens_for_state`: the HUD shows the start screen in the menu and the game interface in a running city.
  // Rendered through the HUD itself, so it pins what the player gets, not a predicate beside it.
  it('uiShellTheMenuShowsOnlyTheStartScreenAndACityOnlyTheGameInterface', () => {
    const menu = renderHud('MainMenu');
    expect(menu, 'the menu shows the start screen').toContain('data-testid="hud-menu"');
    expect(menu, 'and none of the game interface').not.toContain('data-testid="hud"');
    for (const state of ['InGame', 'Paused'] as const) {
      const city = renderHud(state);
      expect(city, `${state} shows the game interface`).toContain('data-testid="hud"');
      expect(city, `${state} hides the start screen`).not.toContain('data-testid="hud-menu"');
    }
  });

  it('devUiGatedStartScreenShowsNoDeveloperElement', () => {
    const lines = shown(menu({ scenarios: menuScenarios() }));
    expect(lines.length, 'the check needs the real screen, not an empty tree').toBeGreaterThan(0);
    for (const marker of ['test city', 'seed', 'dump', 'mcp', 'fps', 'тестов', 'сид', 'дамп']) {
      expect(
        lines.filter((line) => line.includes(marker)),
        `the start screen shows a developer element \`${marker}\``,
      ).toEqual([]);
    }
  });

  // headless_sim.rs: the composed app, with no help, waits in the main menu and loads no city behind the player's back.
  it('menuFirstStartupWaitsInTheMainMenuOnAnEmptyMap', () => {
    const host = new SimHost(RENDER_CAPACITY);
    for (let frame = 0; frame < 30; frame++) host.update(frame * 100);
    expect(host.handle({ t: 'snapshot' }).appState, 'a build must wait on the main menu').toBe('MainMenu');
    expect(
      worldOf(host).grid.roadKind.some((kind) => kind !== 0),
      'a build must not load the test city behind the player\'s back',
    ).toBe(false);
  });

  it('theGoalsLineNamesEveryGoalOrFreePlay', () => {
    expect(goalsLine([])).toBe('Свободная игра');
    expect(goalsLine(SCENARIO_PRESETS.find((p) => p.id === 'starter')!.objectives)).toBe('Цели: население 50, счастье 60\u00a0%');
    expect(goalsLine([{ kind: 'MoneyAtLeast', target: 12000 }, { kind: 'PopulationAtLeast', target: 5000 }])).toBe(
      `Цели: казна $12\u00a0000, население ${thousands(5000)}`,
    );
  });

  it('anEmptyCatalogueSaysSoInTheList', () => {
    expect(shown(menu({ scenarios: [] }))).toContain('сценариев нет');
  });
});
