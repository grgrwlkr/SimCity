import type { World } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { RENDER_CAPACITY, SimHost } from '../src/host';

const worldOf = (host: SimHost): World => (host as unknown as { world: World }).world;

describe('advisor in the snapshot', () => {
  // S3: the HUD reads the advisor's first three problems, worst first, from the snapshot.
  it('snapshotCarriesTheFirstThreeProblemsOfTheAdvisor', () => {
    const host = new SimHost(RENDER_CAPACITY);
    expect(host.handle({ t: 'snapshot' }).advisor, 'nothing assessed yet').toEqual([]);

    host.handle({ t: 'setState', state: 'InGame' });
    const w = worldOf(host);
    w.city.money = -3000;
    w.rciDemand = { residential: 0.9, commercial: 0.8, industrial: 0.1 };
    w.employmentStats = { ...w.employmentStats, employed: 700, unemployed: 300, unemployedByClass: { Low: 200, Middle: 80, High: 20 } };
    host.handle({ t: 'step', ticks: 1 });

    expect(w.advisor.problems.map((problem) => problem.kind)).toEqual(['EmptyTreasury', 'Unemployment', 'HousingWanted', 'JobsWanted']);
    const advisor = host.handle({ t: 'snapshot' }).advisor;
    expect(advisor.map((problem) => problem.kind)).toEqual(['EmptyTreasury', 'Unemployment', 'HousingWanted']);
    expect(advisor[0]).toEqual({ kind: 'EmptyTreasury', severity: 1, text: 'The treasury is empty: $3 000 in debt', at: null });
    expect(advisor[1]?.text).toBe('Unemployment 30%: 300 residents have no job, most of them low-income');
  });

  // Review S3 #1: the first-tick assessment reads employment, demand and coverage before their first minute has run;
  // the advice of the first hour must not stay on those empty stats.
  it('theFirstMinuteOfStatsReachesTheAdviceWithinTheFirstHour', () => {
    const host = new SimHost(RENDER_CAPACITY);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'city' });
    const w = worldOf(host);
    host.handle({ t: 'step', ticks: 1 });
    expect(w.advisor.problems.map((problem) => problem.kind), 'the first tick has no demand yet').not.toContain('HousingWanted');
    host.handle({ t: 'step', ticks: 600 });
    expect(w.city.hour, 'still the first hour').toBe(0);
    expect(host.handle({ t: 'snapshot' }).advisor.map((problem) => problem.kind)).toContain('HousingWanted');
  }, 300_000);

  // Review S3 #2: a scenario loaded into a world of the same size starts its advice afresh.
  it('aScenarioLoadedIntoTheSameWorldDropsTheOldAdvice', () => {
    const host = new SimHost(RENDER_CAPACITY);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'scenario', name: 'livingCity' });
    const w = worldOf(host);
    host.handle({ t: 'step', ticks: 1 });
    // The advice of a city played for a while, standing until its next hour.
    w.advisor.problems = [{ kind: 'EmptyTreasury', severity: 1, text: 'The treasury is empty: $3 000 in debt', at: null }];
    w.advisor.version = 7;
    expect(host.handle({ t: 'snapshot' }).advisor.map((problem) => problem.kind)).toEqual(['EmptyTreasury']);

    host.handle({ t: 'scenario', name: 'livingCity' });
    expect(worldOf(host), 'the same world').toBe(w);
    expect(w.advisor.version).toBe(0);
    expect(host.handle({ t: 'snapshot' }).advisor).toEqual([]);
    host.handle({ t: 'step', ticks: 1 });
    expect(w.advisor.version).toBe(1);
  }, 300_000);
});
