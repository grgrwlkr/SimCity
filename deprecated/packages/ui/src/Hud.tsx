import type { SimSpeed } from '@simcity/bridge';
import type { AppState, GameCommand, TilePos } from '@simcity/sim';
import { useEffect, useState } from 'react';
import { ObjectivesPanel } from './ObjectivesPanel';
import { StartScreen, menuScenarios, showsStartScreen, type StartChoice } from './StartScreen';
import { AdvisorPanel } from './AdvisorPanel';
import { BudgetPanel } from './BudgetPanel';
import { DataMapPanelLive, type DataMapLegend, type DataMapReading, type PlayerOverlay } from './DataMapPanel';
import { HudBar, windowTitle } from './HudBar';
import { useSimStore } from './store';
import { TileTooltipLive } from './TileTooltip';
import { Toasts } from './Toasts';
import { ToolPalette } from './ToolPalette';

// The brush in packages/app reads the tool in hand from here.
export { useToolStore, type ToolMode, type ToolState } from './ToolPalette';

/** The data map panel's side of the page (U4): main.tsx paints the pick and reads the tile under the cursor. */
export interface DataMapActions {
  /** The map picked in the panel, `None` closing it: the renderer paints it from the worker's numbers. */
  select(overlay: PlayerOverlay): void;
  /** The legend of `overlay`: the render package's `legendFor`. */
  legend(overlay: PlayerOverlay): DataMapLegend | null;
  /** The line under the legend for the tile under the cursor: the render package's `panelReading`. */
  read(): DataMapReading | null;
}

export interface HudActions {
  setState(state: AppState): void;
  setSpeed(speed: SimSpeed): void;
  /** Start a city from the menu on a fresh page, so nothing of the current world carries over. */
  start(choice: StartChoice): void;
  /** The demo city (`LoadTestCity`), on a fresh page too. */
  demoCity(): void;
  /** A structural edit of the world, applied with the next tick's commands. */
  command(cmd: GameCommand): void;
  /** Undo (`false`) or redo (`true`) the last map edit. */
  undoRedo(redo: boolean): void;
  /** A toast line with a place: the camera goes to that tile. */
  focusTile(at: TilePos): void;
}

/**
 * `handle_state_hotkeys` (sim.rs): Escape to the menu, Space pauses and resumes. Enter is not a way out of the menu:
 * the start screen has no city without a choice, and a focused menu button takes Enter itself.
 */
function useStateHotkeys(appState: AppState | undefined, actions: HudActions): void {
  useEffect(() => {
    if (appState === undefined) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.code === 'Escape') {
        actions.setState('MainMenu');
      } else if (event.code === 'Space' && appState !== 'MainMenu') {
        event.preventDefault();
        actions.setState(appState === 'InGame' ? 'Paused' : 'InGame');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [appState, actions]);
}

const MENU_SCENARIOS = menuScenarios();

/** `?debug=1` on the page: the dev elements of the HUD show only then (`dev_ui_gate.rs`). */
function debugFlag(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('debug') === '1';
}

export function Hud({ actions, dataMap, debug = debugFlag() }: { actions: HudActions; dataMap?: DataMapActions; debug?: boolean }) {
  const [overlay, setOverlay] = useState<PlayerOverlay>('None');
  const snapshot = useSimStore((s) => s.snapshot);
  const fps = useSimStore((s) => s.fps);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [advisorOpen, setAdvisorOpen] = useState(false);
  // The data maps and the advisor share the left column one at a time (states.md «Левая колонка»): opening the advisor
  // folds the data maps to their header, unfolding them closes the advisor. The picked map stays painted either way.
  const [dataMapExpanded, setDataMapExpanded] = useState(false);
  useStateHotkeys(snapshot?.appState, actions);
  const title = snapshot === null ? null : windowTitle(snapshot.appState, snapshot.city);
  useEffect(() => {
    if (title !== null && document.title !== title) document.title = title;
  }, [title]);

  if (snapshot === null) {
    return <p className="hud-status">Запуск симуляции…</p>;
  }

  if (showsStartScreen(snapshot.appState)) {
    return <StartScreen scenarios={MENU_SCENARIOS} onStart={actions.start} onDemoCity={actions.demoCity} />;
  }

  return (
    <>
      <HudBar
        snapshot={snapshot}
        fps={fps}
        debug={debug}
        actions={actions}
        budgetOpen={budgetOpen}
        onBudgetToggle={() => setBudgetOpen((open) => !open)}
        advisorOpen={advisorOpen}
        onAdvisorToggle={() => {
          if (!advisorOpen) setDataMapExpanded(false);
          setAdvisorOpen(!advisorOpen);
        }}
      />
      <ToolPalette onUndoRedo={actions.undoRedo} />
      <BudgetPanel snapshot={snapshot} open={budgetOpen} onClose={() => setBudgetOpen(false)} command={actions.command} />
      <AdvisorPanel snapshot={snapshot} open={advisorOpen} onClose={() => setAdvisorOpen(false)} onFocus={actions.focusTile} />
      <Toasts onFocus={actions.focusTile} />
      <ObjectivesPanel scenario={snapshot.scenario} />
      <TileTooltipLive />
      {dataMap !== undefined && (
        <DataMapPanelLive
          overlay={overlay}
          legend={dataMap.legend(overlay)}
          read={dataMap.read}
          expanded={dataMapExpanded}
          onToggle={(expand) => {
            setDataMapExpanded(expand);
            if (expand) setAdvisorOpen(false);
          }}
          onSelect={(next) => {
            setOverlay(next);
            dataMap.select(next);
          }}
        />
      )}
    </>
  );
}
