// The game's API: everything the Rust build exposed over BRP. main.tsx drives the game through it; `window.__sim`
// (exposeSimApi.ts) hands it to DevTools and Playwright only in a build with `__SIM_API__`.
import {
  RenderReader,
  type DebugVehicle,
  type FingerprintReply,
  type GridLayerName,
  type GridLayers,
  type ScenarioName,
  type SimClient,
  type SimSpeed,
  type TickStatsReply,
  type WorldSnapshot,
} from '@simcity/bridge';
import type { RenderStats, Renderer } from '@simcity/render';
import type { AppState, EmergencyKind, MapCell, MapConfig, TilePos } from '@simcity/sim';
import type { ClockReply } from '../../bridge/src/requests/clock';
import type { ObserveParams, ObserveReply } from '../../bridge/src/requests/observe';
import { createWorkerSaveStore, type SaveSlotInfo, type SaveStore } from './saves/saveStore';

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
  scenario(name: ScenarioName, size?: number, seed?: string): Promise<null>;
  /** Make a system throw on every call (`null` stops it): the HUD reports it and the world goes on. */
  failSystem(system: string | null): Promise<null>;
  /** An emergency of `kind` breaks out at the tile, with its notification, as one that broke out by itself (stage 4). */
  debugEmergency(kind: EmergencyKind, x: number, y: number): Promise<null>;
  /** p50, p99 and the longest of the last ticks the worker ran, and how many since the reset. */
  tickStats(): Promise<TickStatsReply>;
  resetTickStats(): Promise<null>;
  /** Hover a tile from inside the game without moving the pointer (`PointerOverride`); `null` hands it back to the pointer. */
  hoverTile(tile: TilePos | null): Promise<TilePos | null>;
  /** The tile `hoverTile` holds; `null` while the pointer leads. */
  pointerOverride(): TilePos | null;
  /** The world into save slot `slot` (save v1, packages/sim/src/save). */
  save(slot: string): Promise<SaveSlotInfo>;
  /** The world saved in `slot` in place of this one; rejects on an empty slot or a broken file, the world as it was. */
  load(slot: string): Promise<FingerprintReply>;
  /** The world as a save file's bytes, moved out of the worker: what a store outside it (E1's files) writes. */
  exportSave(): Promise<ArrayBuffer>;
  /** A save file's bytes in place of the world; rejects on a broken file, the world as it was. */
  importSave(bytes: ArrayBuffer): Promise<FingerprintReply>;
  /** The sections of the city a live check judges a run by, read from one tick (E3; e2e/helpers/live.ts). */
  observe(params: ObserveParams): Promise<ObserveReply>;
  /** The clock stood at `hour`:00 of `day`, or of the next day that shows `hour`; forward only (E3). */
  setClock(hour: number, day?: number): Promise<ClockReply>;
}

/**
 * Every method of `window.__sim`, in the order of `SimApi`: the catalogue the live skill and CLAUDE.md list; a unit test holds
 * it equal to the object's methods.
 */
export const SIM_API_METHODS = [
  'snapshot',
  'step',
  'fingerprint',
  'cmd',
  'setState',
  'setSpeed',
  'rngProbe',
  'undoRedo',
  'tile',
  'renderFrame',
  'loadGridHex',
  'debugVehicles',
  'camera',
  'setCamera',
  'fitMap',
  'pickTile',
  'renderStats',
  'scenario',
  'failSystem',
  'debugEmergency',
  'tickStats',
  'resetTickStats',
  'hoverTile',
  'pointerOverride',
  'save',
  'load',
  'exportSave',
  'importSave',
  'observe',
  'setClock',
] as const satisfies ReadonlyArray<keyof SimApi>;

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

export function createSimApi(
  client: SimClient,
  debug: boolean,
  renderer: Promise<Renderer>,
  mapConfig: () => MapConfig | null,
  saves: SaveStore = createWorkerSaveStore(client),
): SimApi {
  const reader = client.ready.then((render) => {
    const r = new RenderReader(render);
    return { reader: r, frame: r.allocate() };
  });
  const cameraOf = (r: Renderer): CameraState => ({
    centerX: r.view.centerX,
    centerY: r.view.centerY,
    worldPerPixel: r.view.worldPerPixel,
    width: r.view.viewport.width,
    height: r.view.viewport.height,
  });
  let pointerOverride: TilePos | null = null;
  // `observe` and `setClock` join `Request` in protocol.ts at integration (dev-live handoff); until then they go out
  // through this untyped door, which stays correct after.
  const live = client as unknown as { request(req: { readonly t: string; readonly [key: string]: unknown }): Promise<unknown> };
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
    scenario: (name, size, seed) =>
      client.request({ t: 'scenario', name, ...(size === undefined ? {} : { size }), ...(seed === undefined ? {} : { seed }) }),
    failSystem: (system) => client.request({ t: 'debugFailSystem', system }),
    debugEmergency: (kind, x, y) => client.request({ t: 'debugEmergency', kind, x, y }),
    tickStats: () => client.request({ t: 'tickStats' }),
    resetTickStats: () => client.request({ t: 'resetTickStats' }),
    hoverTile: async (tile) => {
      // The pointer can never rest off the map, so neither may the override; `__sim` takes any JSON, so a tile is checked
      // for two whole numbers first (the rule of observe's `at`).
      if (tile !== null) {
        if (!Number.isInteger(tile.x) || !Number.isInteger(tile.y)) throw new TypeError(`a tile is { x, y } of whole numbers, got ${JSON.stringify(tile)}`);
        const cfg = mapConfig();
        if (cfg === null) throw new RangeError('there is no map yet, so no tile to hover');
        if (tile.x < 0 || tile.y < 0 || tile.x >= cfg.width || tile.y >= cfg.height) {
          throw new RangeError(`tile (${tile.x}, ${tile.y}) is off the map, where the pointer can never rest`);
        }
      }
      pointerOverride = tile;
      const r = await renderer;
      r.hovered = tile;
      return tile;
    },
    pointerOverride: () => pointerOverride,
    save: (slot) => saves.save(slot),
    load: (slot) => saves.load(slot),
    exportSave: () => client.request({ t: 'save' }),
    importSave: (bytes) => client.request({ t: 'load', bytes }),
    observe: (params) => live.request({ t: 'observe', ...params }) as Promise<ObserveReply>,
    setClock: (hour, day) => live.request(day === undefined ? { t: 'setClock', hour } : { t: 'setClock', hour, day }) as Promise<ClockReply>,
  };
  return api;
}
