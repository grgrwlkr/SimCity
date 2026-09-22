import { SCENARIOS, type Scenario, type SimSpeed } from '@simcity/bridge';
import type { AppState } from '@simcity/sim';
import { useEffect } from 'react';
import { HudBar, windowTitle } from './HudBar';
import { useSimStore } from './store';

export interface HudActions {
  setState(state: AppState): void;
  setSpeed(speed: SimSpeed): void;
  /** The link that opens a scenario: a fresh page, so nothing of the current world carries over. */
  scenarioHref(scenario: Scenario): string;
}

/** `handle_state_hotkeys` (sim.rs): Escape to the menu, Enter starts from the menu, Space pauses and resumes. */
function useStateHotkeys(appState: AppState | undefined, actions: HudActions): void {
  useEffect(() => {
    if (appState === undefined) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.code === 'Escape') {
        actions.setState('MainMenu');
      } else if (event.code === 'Enter' && appState === 'MainMenu') {
        actions.setState('InGame');
      } else if (event.code === 'Space' && appState !== 'MainMenu') {
        event.preventDefault();
        actions.setState(appState === 'InGame' ? 'Paused' : 'InGame');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [appState, actions]);
}

/** `?debug=1` on the page: the dev elements of the HUD show only then (`dev_ui_gate.rs`). */
function debugFlag(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('debug') === '1';
}

export function Hud({ actions, debug = debugFlag() }: { actions: HudActions; debug?: boolean }) {
  const snapshot = useSimStore((s) => s.snapshot);
  const fps = useSimStore((s) => s.fps);
  useStateHotkeys(snapshot?.appState, actions);
  const title = snapshot === null ? null : windowTitle(snapshot.appState, snapshot.city);
  useEffect(() => {
    if (title !== null && document.title !== title) document.title = title;
  }, [title]);

  if (snapshot === null) {
    return <p className="hud-status">Запуск симуляции…</p>;
  }

  if (snapshot.appState === 'MainMenu') {
    return (
      <main className="menu">
        <h1>SimCity</h1>
        <button type="button" data-testid="start" onClick={() => actions.setState('InGame')}>
          Новая игра
        </button>
        <p className="hint">Enter — начать</p>
        <nav className="scenarios" aria-label="Сценарии">
          <h2>Сценарии</h2>
          {SCENARIOS.map((scenario) => (
            <a key={scenario.name} className="scenario" href={actions.scenarioHref(scenario)}>
              <strong>{scenario.title}</strong>
              <span>{scenario.description}</span>
            </a>
          ))}
        </nav>
      </main>
    );
  }

  return <HudBar snapshot={snapshot} fps={fps} debug={debug} actions={actions} />;
}
