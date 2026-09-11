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
