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
});
