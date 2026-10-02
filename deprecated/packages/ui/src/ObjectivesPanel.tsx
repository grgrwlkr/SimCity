// The goals of the scenario that runs (docs/design/hud/layout.md §10): each with its progress and a mark once met,
// from the snapshot's `scenario`. A plain game, a scenario outside the catalogue or a preset without goals shows none.
import type { ObjectiveView, ScenarioProgressView } from '@simcity/bridge';
import { thousands } from '@simcity/sim';
import { formatMoney } from './HudBar';
const percent = (share: number) => `${Math.round(share * 100)}\u00a0%`;

/** «Население 1 234 из 50»: the city now against the goal, in the goal's own unit. */
export function objectiveLine(o: ObjectiveView): string {
  switch (o.kind) {
    case 'PopulationAtLeast':
      return `Население ${thousands(o.current)} из ${thousands(o.target)}`;
    case 'MoneyAtLeast':
      return `Казна ${formatMoney(o.current)} из ${formatMoney(o.target)}`;
    case 'HappinessAtLeast':
      return `Счастье ${percent(o.current)} из ${percent(o.target)}`;
  }
}

export function ObjectivesPanel({ scenario }: { scenario: ScenarioProgressView | null }) {
  if (scenario === null || scenario.objectives.length === 0) return null;
  return (
    <section className="hud-glass hud-objectives" data-testid="objectives" aria-label="Цели сценария">
      <h2 className="hud-objectives-title">
        {scenario.name}
        <span className="hud-objectives-count">
          {scenario.completed} из {scenario.objectives.length}
        </span>
      </h2>
      <ul className="hud-objectives-list">
        {scenario.objectives.map((o, index) => (
          <li key={index} data-met={o.met ? 'true' : 'false'}>
            {o.met && (
              <>
                <span className="hud-objectives-mark" aria-hidden="true">
                  ✓
                </span>
                <span className="hud-objectives-sr">выполнено: </span>
              </>
            )}
            {objectiveLine(o)}
          </li>
        ))}
      </ul>
      {scenario.isCompleted && <p className="hud-objectives-done">Сценарий пройден</p>}
    </section>
  );
}
