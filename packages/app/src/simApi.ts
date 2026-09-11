// `window.__sim`: everything the Rust build exposed over BRP, reachable from DevTools and Playwright.
import {
  RenderReader,
  type FingerprintReply,
  type SimClient,
  type SimSpeed,
  type WorldSnapshot,
} from '@simcity/bridge';
import type { AppState } from '@simcity/sim';

export interface RenderFrameSummary {
  readonly tick: number;
  readonly count: number;
}

export interface SimApi {
  /** `?debug=1`. */
  readonly debug: boolean;
  readonly ready: Promise<void>;
  snapshot(): Promise<WorldSnapshot>;
  /** Manual stepping, one fixed tick per frame; pause the speed first for an exact tick count. */
  step(ticks: number): Promise<FingerprintReply>;
  fingerprint(): Promise<FingerprintReply>;
  /** A `GameCommand` in its serde-JSON form, e.g. `{ GenerateMap: { seed: 7 } }`. */
  cmd(json: unknown): Promise<null>;
  setState(state: AppState): Promise<null>;
  setSpeed(speed: SimSpeed): Promise<null>;
  rngProbe(seed: string, draws: number): Promise<string>;
  /** The frame the main thread reads from the shared render buffer. */
  renderFrame(): Promise<RenderFrameSummary>;
}

declare global {
  interface Window {
    __sim: SimApi;
  }
}

export function installSimApi(client: SimClient, debug: boolean): SimApi {
  const reader = client.ready.then((render) => {
    const r = new RenderReader(render);
    return { reader: r, frame: r.allocate() };
  });
  const api: SimApi = {
    debug,
    ready: client.ready.then(() => undefined),
    snapshot: () => client.request({ t: 'snapshot' }),
    step: (ticks) => client.request({ t: 'step', ticks }),
    fingerprint: () => client.request({ t: 'fingerprint' }),
    cmd: (cmd) => client.request({ t: 'cmd', cmd }),
    setState: (state) => client.request({ t: 'setState', state }),
    setSpeed: (speed) => client.request({ t: 'setSpeed', speed }),
    rngProbe: (seed, draws) => client.request({ t: 'rngProbe', seed, draws }),
    renderFrame: async () => {
      const { reader: r, frame } = await reader;
      r.readInto(frame);
      return { tick: frame.tick, count: frame.count };
    },
  };
  window.__sim = api;
  return api;
}
