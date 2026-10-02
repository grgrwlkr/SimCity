import { describe, expect, it } from 'vitest';
import { SCENARIOS, scenarioByQuery } from '../src/scenarios';

describe('scenario list', () => {
  it('everyScenarioOpensByItsOwnLink', () => {
    const queries = SCENARIOS.map((s) => s.query);
    expect(new Set(queries).size, 'no two scenarios share a link').toBe(queries.length);
    expect(new Set(SCENARIOS.map((s) => s.name)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      expect(s.query).toMatch(/^[a-z0-9-]+$/);
      expect(scenarioByQuery(s.query)).toBe(s);
    }
  });

  it('theLinksAlreadyInUseStillOpenTheirScenarios', () => {
    expect(scenarioByQuery('signalized')?.name).toBe('signalizedCross');
    expect(scenarioByQuery('signalized4')?.name).toBe('signalizedCross4');
    expect(scenarioByQuery('city')?.name).toBe('city');
    expect(scenarioByQuery('nowhere')).toBeUndefined();
    expect(scenarioByQuery(null)).toBeUndefined();
  });

  it('everyScenarioIsDescribedForTheMenu', () => {
    for (const s of SCENARIOS) {
      expect(s.title.length, s.name).toBeGreaterThan(0);
      expect(s.description.length, s.name).toBeGreaterThan(0);
    }
  });
});
