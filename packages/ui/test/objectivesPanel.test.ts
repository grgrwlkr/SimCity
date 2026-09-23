// The objectives panel in a running city (docs/design/hud/layout.md §10): the goals of the catalogue preset that
// runs, each with its progress and a mark once met, from the snapshot's `scenario` (P3). No goals, no panel.
import { readFileSync } from 'node:fs';
import type { ObjectiveView, ScenarioProgressView } from '@simcity/bridge';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ObjectivesPanel } from '../src/ObjectivesPanel';

const css = readFileSync(new URL('../src/objectives.css', import.meta.url), 'utf8');

const html = (scenario: ScenarioProgressView | null) => renderToStaticMarkup(createElement(ObjectivesPanel, { scenario }));

/** The rows of the list as their visible text, top to bottom. */
function rows(markup: string): string[] {
  return [...markup.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ' ').replace(/[ \t\n]+/g, ' ').trim());
}

function starter(objectives: readonly ObjectiveView[], completed: number, isCompleted = false): ScenarioProgressView {
  return { id: 'starter', name: 'Первый город', objectives, completed, isCompleted };
}

describe('objectives panel', () => {
  it('showsEveryGoalWithItsProgressAndMarksTheMetOnes', () => {
    const markup = html(
      starter(
        [
          { kind: 'PopulationAtLeast', target: 50, current: 1234, met: true },
          { kind: 'HappinessAtLeast', target: Math.fround(0.6), current: 0.554, met: false },
        ],
        1,
      ),
    );
    expect(markup).toContain('Первый город');
    expect(markup).toContain('1 из 2');
    expect(rows(markup)).toEqual(['✓ Население 1\u00a0234 из 50', 'Счастье 55\u00a0% из 60\u00a0%']);
    const met = [...markup.matchAll(/<li[^>]*data-met="(true|false)"/g)].map((m) => m[1]);
    expect(met).toEqual(['true', 'false']);
    expect(markup).not.toContain('Сценарий пройден');
  });

  it('saysSoWhenEveryGoalIsMet', () => {
    const markup = html(starter([{ kind: 'MoneyAtLeast', target: 5000, current: 7300, met: true }], 1, true));
    expect(rows(markup)).toEqual(['✓ Казна $7\u00a0300 из $5\u00a0000']);
    expect(markup).toContain('Сценарий пройден');
  });

  it('isNotShownWithoutGoals', () => {
    expect(html(null), 'a plain game or a scenario outside the catalogue').toBe('');
    expect(html({ id: 'sandbox', name: 'Песочница', objectives: [], completed: 0, isCompleted: false }), 'a preset without goals').toBe('');
  });

  // A readout: the map under it stays clickable, and it sits in the right column above the tool palette.
  it('staysOffThePointerAndInTheRightColumn', () => {
    const root = /(?:^|\n)\.hud-objectives\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(root).toMatch(/pointer-events:\s*none/);
    expect(root).toMatch(/right:\s*var\(--hud-safe-edge\)/);
    expect(root, 'above the palette').toMatch(/bottom:\s*calc\(var\(--hud-safe-edge\) \+ var\(--hud-palette-height, 182px\) \+ var\(--hud-space-8\)\)/);
  });
});
