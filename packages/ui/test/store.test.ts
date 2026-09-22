import { RENDER_CAPACITY, SimHost } from '@simcity/bridge';
import type { World } from '@simcity/sim';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  selectAdvisor,
  selectBudget,
  selectHistory,
  selectLoans,
  selectMilestones,
  selectServiceFunding,
  selectTaxRates,
  selectToasts,
  useSimStore,
} from '../src/store';

describe('useSimStore', () => {
  beforeEach(() => useSimStore.setState({ snapshot: null }));

  // U0: the HUD's panels take the economy, the feed and the city's progress from the store, never from the worker.
  it('handsTheHudFieldsOfTheLastSnapshotToComponents', () => {
    const host = new SimHost(RENDER_CAPACITY);
    const w = (host as unknown as { world: World }).world;
    w.notifications.add('Road built', 'Info', 4);
    w.taxRates.set('Industrial', 'Low', 3);
    w.serviceFunding.set('Fire', 120);
    w.loans.take(10_000, w.budget, w.city);
    const snapshot = host.snapshot(0);
    useSimStore.getState().setSnapshot(snapshot);
    const state = useSimStore.getState();
    expect(selectBudget(state)).toBe(snapshot.budget);
    expect(selectTaxRates(state)?.Industrial.Low).toBe(3);
    expect(selectServiceFunding(state)?.Fire).toBe(120);
    expect(selectLoans(state)).toHaveLength(1);
    expect(selectToasts(state).map((t) => t.text)).toEqual(['Road built']);
    expect(selectHistory(state).map((l) => l.text)).toEqual(['Road built']);
    expect(selectMilestones(state)).toEqual({ bestPopulation: 0, next: { population: 250, unlocks: 'School' } });
    expect(selectAdvisor(state)).toEqual([]);
  });

  it('hasNothingToHandOutBeforeTheFirstSnapshot', () => {
    const state = useSimStore.getState();
    expect(selectBudget(state)).toBeNull();
    expect(selectTaxRates(state)).toBeNull();
    expect(selectServiceFunding(state)).toBeNull();
    expect(selectMilestones(state)).toBeNull();
    // Lists are empty rather than absent, so a component maps over them without a guard.
    expect(selectLoans(state)).toEqual([]);
    expect(selectToasts(state)).toEqual([]);
    expect(selectHistory(state)).toEqual([]);
    expect(selectAdvisor(state)).toEqual([]);
    // The same empty list every time: a selector that built a new one would re-render its component on every call.
    expect(selectToasts(state)).toBe(selectToasts(useSimStore.getState()));
  });
});
