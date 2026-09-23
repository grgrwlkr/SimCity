import { SCENARIO_PRESETS } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { RENDER_CAPACITY, SimHost } from '../src/host';
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

  it('theCatalogPresetsAreInTheMenu', () => {
    for (const preset of SCENARIO_PRESETS) expect(scenarioByQuery(preset.id)?.name, preset.id).toBe(preset.id);
  });

  it('aPresetOpensOnItsSeedWithItsMoneyAndObjectives', () => {
    const host = new SimHost(RENDER_CAPACITY);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'starter' });
    const snapshot = host.handle({ t: 'snapshot' });
    expect(snapshot.mapSeed).toBe('42');
    expect([snapshot.city.money, snapshot.city.day, snapshot.city.hour]).toEqual([1500, 1, 8]);
    expect(snapshot.scenario).toEqual({
      id: 'starter',
      name: 'Starter Town',
      objectives: [
        { kind: 'PopulationAtLeast', target: 50, current: 0, met: false },
        { kind: 'HappinessAtLeast', target: Math.fround(0.6), current: snapshot.city.happiness, met: snapshot.city.happiness >= Math.fround(0.6) },
      ],
      completed: snapshot.city.happiness >= Math.fround(0.6) ? 1 : 0,
      isCompleted: false,
    });
  });

  it('aPresetOpensOnTheSeedTheMenuGives', () => {
    const host = new SimHost(RENDER_CAPACITY);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'sandbox', seed: '987654' });
    const snapshot = host.handle({ t: 'snapshot' });
    expect(snapshot.mapSeed).toBe('987654');
    expect(snapshot.scenario).toMatchObject({ id: 'sandbox', objectives: [], isCompleted: false });
  });

  it('theOtherScenariosKeepTheirHourAndHaveNoObjectives', () => {
    const host = new SimHost(RENDER_CAPACITY);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'starter' });
    // A scenario after a preset in the same world: the preset's objectives go with it.
    host.handle({ t: 'scenario', name: 'signalizedCross' });
    const snapshot = host.handle({ t: 'snapshot' });
    expect(snapshot.scenario).toBeNull();
    const cross = new SimHost(RENDER_CAPACITY);
    cross.handle({ t: 'setState', state: 'InGame' });
    cross.handle({ t: 'scenario', name: 'signalizedCross' });
    expect(cross.handle({ t: 'snapshot' }).city.hour, 'the crossings start at midnight, as before').toBe(0);
  });
});
