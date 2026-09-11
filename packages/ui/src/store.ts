import type { WorldSnapshot } from '@simcity/bridge';
import { create } from 'zustand';

export interface SimStore {
  /** The last snapshot the worker pushed; `null` until the first one arrives. */
  readonly snapshot: WorldSnapshot | null;
  setSnapshot(snapshot: WorldSnapshot): void;
}

export const useSimStore = create<SimStore>()((set) => ({
  snapshot: null,
  setSnapshot: (snapshot) => set({ snapshot }),
}));
