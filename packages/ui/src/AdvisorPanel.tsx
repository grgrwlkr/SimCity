import type { WorldSnapshot } from '@simcity/bridge';
import type { HistoryLine, TilePos } from '@simcity/sim';
import type { KeyboardEvent } from 'react';
import { toastLabel } from './Toasts';

// The advisor's panel: the worst problem first, two more under it, the latest events with their day.
// docs/design/hud/layout.md §8 and states.md; port of rust-final crates/simcity_frontend/src/game/hud/advisor_panel.rs.
// Not modal: the city lives on and the player builds with it open. No hooks: the HUD owns `open`.

/** How many problems the panel names under the worst one (`MORE_PROBLEMS`, advisor_panel.rs:17). */
export const MORE_PROBLEMS = 2;

/** How many past events the panel lists, newest first (`RECENT_EVENTS`, advisor_panel.rs:20). */
export const RECENT_EVENTS = 5;

/** The `id` of the bar's «Советник» button: Esc in the panel hands focus back to it. */
export const ADVISOR_TOGGLE_ID = 'hud-advisor-toggle';

export interface AdvisorToggleProps {
  readonly open: boolean;
  readonly onToggle: () => void;
}

/** The HUD control that opens and closes the advisor (`spawn_advisor_toggle`). */
export function AdvisorToggle({ open, onToggle }: AdvisorToggleProps) {
  return (
    <button type="button" id={ADVISOR_TOGGLE_ID} data-testid="advisor-toggle" aria-pressed={open} aria-controls="hud-advisor" onClick={onToggle}>
      Советник
    </button>
  );
}

export interface AdvisorPanelProps {
  /** `advisor`: the first three problems, worst first; `history`: the feed's last events, oldest first. */
  readonly snapshot: Pick<WorldSnapshot, 'advisor' | 'history'>;
  readonly open: boolean;
  readonly onClose: () => void;
  /** A click on a problem with a place: the camera goes to that tile (as a toast's `onFocus`). */
  readonly onFocus: (at: TilePos) => void;
}

/** A past event as the panel reads it: «День N: text ×K». */
export function eventLine(line: HistoryLine): string {
  return `День ${line.day}: ${toastLabel(line.text, line.count)}`;
}

/** A press or a wheel on the panel is the panel's: it never reaches the map (states.md, «Правило клика сквозь HUD»). */
const keepOffTheMap = (event: { stopPropagation(): void }) => event.stopPropagation();

/** The advisor's panel; `null` while closed. */
export function AdvisorPanel({ snapshot, open, onClose, onFocus }: AdvisorPanelProps) {
  if (!open) return null;
  const problems = snapshot.advisor.slice(0, 1 + MORE_PROBLEMS);
  const events = snapshot.history.slice(-RECENT_EVENTS).reverse();
  // Esc closes the open panel before it can take the game to the menu (states.md, «Клавиатура»).
  const onKeyDown = (event: Pick<KeyboardEvent, 'key' | 'stopPropagation'>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onClose();
    if (typeof document !== 'undefined') document.getElementById(ADVISOR_TOGGLE_ID)?.focus();
  };

  return (
    <section
      id="hud-advisor"
      className="advisor-panel hud-glass"
      data-testid="advisor"
      aria-labelledby="advisor-title"
      // A click anywhere on the panel puts focus in it, so Esc reaches `onKeyDown` rather than the game's hotkeys.
      tabIndex={-1}
      onPointerDown={keepOffTheMap}
      onWheel={keepOffTheMap}
      onKeyDown={onKeyDown}
    >
      <h2 id="advisor-title" className="advisor-caption">
        Советник
      </h2>
      {problems.length === 0 ? (
        <p className="advisor-problem advisor-worst">Ничего не требует внимания</p>
      ) : (
        <ol className="advisor-problems">
          {problems.map((problem, index) => {
            const className = index === 0 ? 'advisor-problem advisor-worst' : 'advisor-problem';
            const at = problem.at;
            return (
              <li key={problem.kind}>
                {at === null ? (
                  <p className={className}>{problem.text}</p>
                ) : (
                  <button type="button" className="advisor-go" data-testid="advisor-problem" title={problem.text} onClick={() => onFocus(at)}>
                    <span className={className}>{problem.text}</span>
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {events.length === 0 ? null : (
        <>
          <h3 className="advisor-caption">Последние события</h3>
          <ol className="advisor-events">
            {events.map((line, index) => (
              <li key={`${line.day}\u0000${line.text}\u0000${index}`}>{eventLine(line)}</li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
