// `window.__sim`: everything the Rust build exposed over BRP, reachable from DevTools and Playwright.
import {
  RenderReader,
  type DebugVehicle,
  type FingerprintReply,
  type GridLayerName,
  type GridLayers,
  type SimClient,
  type SimSpeed,
  type WorldSnapshot,
} from '@simcity/bridge';
import type { DebugRenderer, RenderStats } from '@simcity/render';
import type { AppState, MapCell, MapConfig, TilePos } from '@simcity/sim';

export interface RenderFrameSummary {
  readonly tick: number;
  readonly count: number;
}

export interface CameraState {
  readonly centerX: number;
  readonly centerY: number;
  /** World units per CSS pixel. */
  readonly worldPerPixel: number;
  readonly width: number;
  readonly height: number;
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
  /** Undo (`false`) or redo (`true`) the last map edit, applied with the next frame's commands. */
  undoRedo(redo: boolean): Promise<null>;
  /** One map cell; `null` outside the map. */
  tile(x: number, y: number): Promise<MapCell | null>;
  /** The frame the main thread reads from the shared render buffer. */
  renderFrame(): Promise<RenderFrameSummary>;
  /** Replace every grid layer, each given as hex (two digits a tile), e.g. the test city fixture. */
  loadGridHex(layers: Record<GridLayerName, string>): Promise<null>;
  /** Put vehicles into the render layer by hand (world coordinates) until traffic exists. */
  debugVehicles(vehicles: DebugVehicle[]): Promise<null>;
  camera(): Promise<CameraState>;
  setCamera(state: Partial<Pick<CameraState, 'centerX' | 'centerY' | 'worldPerPixel'>>): Promise<CameraState>;
  /** The whole map in view, north up. */
  fitMap(): Promise<CameraState>;
  /** The tile under a point in canvas CSS pixels; `null` off the map. */
  pickTile(x: number, y: number): Promise<TilePos | null>;
  renderStats(): Promise<RenderStats>;
  /** Build a scenario into the running world (`?scenario=signalized` does this on load). */
  scenario(name: 'signalizedCross' | 'signalizedCross4' | 'city'): Promise<null>;
}

declare global {
  interface Window {
    __sim: SimApi;
  }
}

function hexToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function installSimApi(
  client: SimClient,
  debug: boolean,
  renderer: Promise<DebugRenderer>,
  mapConfig: () => MapConfig | null,
): SimApi {
  const reader = client.ready.then((render) => {
    const r = new RenderReader(render);
    return { reader: r, frame: r.allocate() };
  });
  const cameraOf = (r: DebugRenderer): CameraState => ({
    centerX: r.view.centerX,
    centerY: r.view.centerY,
    worldPerPixel: r.view.worldPerPixel,
    width: r.view.viewport.width,
    height: r.view.viewport.height,
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
    undoRedo: (redo) => client.request({ t: 'undoRedo', redo }),
    tile: (x, y) => client.request({ t: 'tile', pos: { x, y } }),
    renderFrame: async () => {
      const { reader: r, frame } = await reader;
      r.readInto(frame);
      return { tick: frame.tick, count: frame.count };
    },
    loadGridHex: (layers) => {
      const bytes = Object.fromEntries(Object.entries(layers).map(([name, hex]) => [name, hexToBytes(hex)]));
      return client.request({ t: 'loadGrid', layers: bytes as GridLayers });
    },
    debugVehicles: (vehicles) => client.request({ t: 'debugVehicles', vehicles }),
    camera: async () => cameraOf(await renderer),
    setCamera: async (state) => {
      const r = await renderer;
      if (state.centerX !== undefined) r.view.centerX = state.centerX;
      if (state.centerY !== undefined) r.view.centerY = state.centerY;
      if (state.worldPerPixel !== undefined) r.view.worldPerPixel = state.worldPerPixel;
      return cameraOf(r);
    },
    fitMap: async () => {
      const r = await renderer;
      const cfg = mapConfig();
      if (cfg !== null) r.view.fitMap(cfg);
      return cameraOf(r);
    },
    pickTile: async (x, y) => {
      const r = await renderer;
      const cfg = mapConfig();
      return cfg === null ? null : (r.view.pickTile(cfg, x, y) ?? null);
    },
    renderStats: async () => (await renderer).stats(),
    scenario: (name) => client.request({ t: 'scenario', name }),
  };
  window.__sim = api;
  return api;
}
