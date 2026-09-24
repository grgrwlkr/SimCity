// The start screen: the menu is the real way into a city — a new map, the demo city or a scenario
// (docs/design/hud/layout.md §9; `start_screen.rs` at rust-final). What a button asks for goes to the props: the app
// turns it into requests, the screen knows nothing of the worker.
import { SCENARIOS, type ScenarioName } from '@simcity/bridge';
import { SCENARIO_PRESETS, thousands, type AppState, type ScenarioObjective } from '@simcity/sim';
import { formatMoney } from './HudBar';

/** A city to start: a scenario of the menu, and for a new map the seed it is generated on (`u64` in decimal digits). */
export interface StartChoice {
  readonly name: ScenarioName;
  readonly seed?: string;
}

/** A scenario button: its menu title and the goals of its catalogue preset (none outside the catalogue). */
export interface StartScreenEntry {
  readonly name: ScenarioName;
  readonly title: string;
  readonly objectives: readonly ScenarioObjective[];
}

export interface StartScreenProps {
  readonly scenarios: readonly StartScreenEntry[];
  /** `{ name: 'sandbox', seed }` for a new map, `{ name }` for a scenario on its own map. */
  onStart(choice: StartChoice): void;
  /** The demo city (`LoadTestCity`). */
  onDemoCity(): void;
}

/** Every scenario of the menu in its order, each with the goals of its catalogue preset. */
export function menuScenarios(): StartScreenEntry[] {
  return SCENARIOS.map((s) => ({
    name: s.name,
    title: s.title,
    objectives: SCENARIO_PRESETS.find((preset) => preset.id === s.name)?.objectives ?? [],
  }));
}

/** A seed the player did not have to type: 64 random bits, new on every press. */
export function freshSeed(): string {
  return crypto.getRandomValues(new BigUint64Array(1))[0]!.toString();
}

/** A scenario's goals in a line, or what it offers when it has none (`goals_line`). */
export function goalsLine(objectives: readonly ScenarioObjective[]): string {
  if (objectives.length === 0) return 'Свободная игра';
  const goals = objectives.map((goal) => {
    switch (goal.kind) {
      case 'PopulationAtLeast':
        return `население ${thousands(goal.target)}`;
      case 'MoneyAtLeast':
        return `казна ${formatMoney(goal.target)}`;
      case 'HappinessAtLeast':
        return `счастье ${Math.round(goal.target * 100)}\u00a0%`;
    }
  });
  return `Цели: ${goals.join(', ')}`;
}

/** The start screen belongs to the menu, every other part of the game interface to a running city (`show_screens_for_state`). */
export const showsStartScreen = (state: AppState): boolean => state === 'MainMenu';

function menuButton({ testId, label, detail, onClick }: { testId: string; label: string; detail: string; onClick: () => void }) {
  return (
    <button key={testId} type="button" className="hud-menu-item" data-testid={testId} onClick={onClick}>
      <span className="hud-menu-item-label">{label}</span>
      <span className="hud-menu-item-detail">{detail}</span>
    </button>
  );
}

// A plain function of its props, no hooks: the tests call it and press the buttons it returns.
export function StartScreen({ scenarios, onStart, onDemoCity }: StartScreenProps) {
  return (
    <main className="hud-menu" data-testid="hud-menu">
      <div className="hud-glass hud-menu-card">
        <h1 className="hud-menu-title">SimCity</h1>
        <p className="hud-menu-tagline">Проложите улицы. Город построит себя.</p>
        {menuButton({
          testId: 'menu-new-map',
          label: 'Новая карта',
          detail: 'Пустая песочница на новой карте',
          onClick: () => onStart({ name: 'sandbox', seed: freshSeed() }),
        })}
        {menuButton({
          testId: 'menu-demo-city',
          label: 'Демо-город',
          detail: 'Готовый город: посмотреть и поменять',
          onClick: onDemoCity,
        })}
        <nav className="hud-menu-scenarios" aria-label="Сценарии">
          <h2 className="hud-menu-heading">Сценарии</h2>
          {scenarios.length === 0 ? (
            <p className="hud-menu-empty">Сценариев нет</p>
          ) : (
            scenarios.map((s) => (
              menuButton({
                testId: `menu-scenario-${s.name}`,
                label: s.title,
                detail: goalsLine(s.objectives),
                onClick: () => onStart({ name: s.name }),
              })
            ))
          )}
        </nav>
      </div>
    </main>
  );
}
