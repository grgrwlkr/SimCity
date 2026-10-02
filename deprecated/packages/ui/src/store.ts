import type { WorldSnapshot } from '@simcity/bridge';
import { create } from 'zustand';

export interface SimStore {
  /** The last snapshot the worker pushed; `null` until the first one arrives. */
  readonly snapshot: WorldSnapshot | null;
  /** Frames the renderer draws per second; `null` until the renderer runs. */
  readonly fps: number | null;
  setSnapshot(snapshot: WorldSnapshot): void;
  setFps(fps: number): void;
}

export const useSimStore = create<SimStore>()((set) => ({
  snapshot: null,
  fps: null,
  setSnapshot: (snapshot) => set({ snapshot }),
  setFps: (fps) => set({ fps }),
}));

// The HUD's panels read these with `useSimStore(selectX)`. A list is empty rather than absent before the first
// snapshot, and always the same empty list, so a component re-renders only when the worker sends a new one.
const NONE: readonly never[] = [];

export const selectBudget = (s: SimStore) => s.snapshot?.budget ?? null;
export const selectTaxRates = (s: SimStore) => s.snapshot?.taxRates ?? null;
export const selectServiceFunding = (s: SimStore) => s.snapshot?.serviceFunding ?? null;
export const selectLoans = (s: SimStore): WorldSnapshot['loans'] => s.snapshot?.loans ?? NONE;
export const selectToasts = (s: SimStore): WorldSnapshot['toasts'] => s.snapshot?.toasts ?? NONE;
export const selectHistory = (s: SimStore): WorldSnapshot['history'] => s.snapshot?.history ?? NONE;
export const selectMilestones = (s: SimStore) => s.snapshot?.milestones ?? null;
export const selectAdvisor = (s: SimStore): WorldSnapshot['advisor'] => s.snapshot?.advisor ?? NONE;
export const selectScenario = (s: SimStore) => s.snapshot?.scenario ?? null;
