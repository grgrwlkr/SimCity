import { RenderReader, SimClient, scenarioByQuery, type MapLayersReply, type WorldSnapshot } from '@simcity/bridge';
import { DebugRenderer, SceneRenderer, dataMapInputs, installViewControls, legendFor, panelReading, type DataMapLayer, type Renderer } from '@simcity/render';
import { SIGNALIZED_CROSS, crossBoxSize, defaultTrafficConfig, tileToWorld, toRustCommand, type MapConfig } from '@simcity/sim';
import { Hud, focusViewOn, useSimStore, useToolStore, type DataMapActions, type HudActions, type PlayerOverlay } from '@simcity/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installGamepad } from './gamepad';
import { installSimApi } from './simApi';
import './styles.css';

if (!crossOriginIsolated) {
  throw new Error('SharedArrayBuffer needs a cross-origin isolated page: serve with COOP/COEP headers (README).');
}

const params = new URLSearchParams(location.search);
const debug = params.get('debug') === '1';
/** `?scenario=<query>`: a scenario of the main menu, built on load; a lit cross opens with the camera on its box. */
const scenario = scenarioByQuery(params.get('scenario'));
/**
 * The player sees the scene. The debug renderer draws under `?debug=1` or `?renderer=debug`, and by default under
 * automation (`navigator.webdriver`): the e2e gates read tile classes back from its flat colours. `?renderer=scene`
 * forces the scene anywhere.
 */
const rendererParam = params.get('renderer');
const useScene = rendererParam === 'scene' || (rendererParam !== 'debug' && !debug && !navigator.webdriver);
let focusPending = scenario?.cross !== undefined;
const canvas = document.getElementById('view');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('canvas#view is missing from index.html');

const worker = new Worker(new URL('../../bridge/src/worker.ts', import.meta.url), { type: 'module' });
const client = new SimClient(worker);

let mapConfig: MapConfig | null = null;
const renderer = client.ready.then(async (sab) => {
  const r: Renderer = useScene ? await SceneRenderer.create(canvas) : await DebugRenderer.create(canvas);
  r.attachRenderBuffer(new RenderReader(sab));
  // The tool in hand paints the map with world commands; the same channel as every panel's.
  installViewControls(canvas, r, () => mapConfig, {
    brush: () => useToolStore.getState(),
    send: (commands) => commands.forEach((cmd) => actions.command(cmd)),
    hasTrafficLight: ({ x, y }) =>
      (useSimStore.getState().snapshot?.lights ?? []).some((l) => x >= l.minX && x <= l.maxX && y >= l.minY && y <= l.maxY),
    driveOnRight: defaultTrafficConfig().driveOnRight,
    pointerOverride: () => api.pointerOverride(),
  });
  // The frame holds only what the camera sees; at ×60 and above it carries the load of links the renderer draws.
  r.onViewChange = (view) => void client.request({ t: 'setView', view });
  r.onLinksNeeded = () => void client.request({ t: 'mesoLinks' }).then((links) => r.setLinks(links));
  return r;
});
const api = installSimApi(client, debug, renderer, () => mapConfig);
/** The renderer once it exists, and the map it drew last: the data map panel reads them synchronously. */
let shownRenderer: Renderer | null = null;
let shownMap: MapLayersReply | null = null;
void renderer.then((r) => (shownRenderer = r));
installGamepad({
  renderer,
  api,
  context: () => {
    const snapshot = useSimStore.getState().snapshot;
    return snapshot === null ? null : { appState: snapshot.appState, speed: snapshot.speed };
  },
});

// Keeps the picture in step with the worker: the map when its edit version moves, the overlay
// (debug only) once the lanelets are built for the current graph version. One sync at a time.
let shownMapEditVersion: number | null = null;
let shownOverlayGraphVersion: number | null = null;
/** A save was loaded: the next map read is another world's, fitted on screen if its size differs. */
let mapLoaded = false;
let sync = Promise.resolve();
function syncRender(snapshot: WorldSnapshot): void {
  sync = sync.then(async () => {
    const r = await renderer;
    if (snapshot.mapEditVersion !== shownMapEditVersion) {
      const map = await client.request({ t: 'mapLayers' });
      const shown = mapConfig;
      const first = shown === null;
      const resized = shown !== null && (shown.width !== map.width || shown.height !== map.height);
      mapConfig = { width: map.width, height: map.height, tileSize: map.tileSize };
      r.setMap(map);
      shownMap = map;
      const fitLoaded = mapLoaded && resized;
      mapLoaded = false;
      if (first || fitLoaded) {
        // A page opened in a hidden pane starts with a 0×0 canvas: fit the map once it has a size.
        const cfg = mapConfig;
        void r.whenSized().then(() => r.view.fitMap(cfg));
      }
      shownMapEditVersion = map.mapEditVersion;
    }
    r.setLights(snapshot.lights);
    r.setEmergencies(snapshot.services.emergencies);
    r.setClock?.(snapshot.city.hour + snapshot.city.minute / 60);
    // The scenario's map is on screen: centre its box and show the whole cross, once the canvas has a
    // size (registered after the first fit, so it runs after it).
    const cross = scenario?.cross;
    if (focusPending && cross !== undefined && mapConfig !== null && (shownMapEditVersion ?? 0) > 0) {
      focusPending = false;
      const cfg = mapConfig;
      // `tileToWorld` is a tile centre: the box centre lies (size − 1) / 2 tiles past its first tile.
      const toCentre = ((crossBoxSize(cross) - 1) / 2) * cfg.tileSize;
      void r.whenSized().then(() => {
        const { width, height } = r.view.viewport;
        const box = tileToWorld(cfg, SIGNALIZED_CROSS.box);
        r.view.centerX = box.x + toCentre;
        r.view.centerY = box.y + toCentre;
        r.view.worldPerPixel = ((SIGNALIZED_CROSS.hi - SIGNALIZED_CROSS.lo + 6) * cfg.tileSize) / Math.min(width, height);
      });
    }
    if (debug && snapshot.graphVersion !== shownOverlayGraphVersion) {
      const overlay = await client.request({ t: 'debugOverlay' });
      if (overlay.laneletsBuiltFor === overlay.graphVersion) {
        r.setOverlay(overlay);
        shownOverlayGraphVersion = overlay.graphVersion;
      }
    }
  });
}

// The data map on screen (U4): the overlay picked in the panel and the worker's numbers for it, asked for again while
// it is open. Requests are numbered: a reply overtaken by a newer pick or refresh is dropped, so a slow reply for the
// previous map never paints over the current one.
/** How often an open data map asks for fresh numbers: land value moves a chunk a tick, a second is enough to read. */
const DATA_MAP_REFRESH_MS = 1000;
let dataMapOverlay: PlayerOverlay = 'None';
let dataMapLayer: DataMapLayer | null = null;
let dataMapAsked = 0;
let dataMapInFlight = false;
let dataMapAskedAtMs = 0;
function refreshDataMap(): void {
  const overlay = dataMapOverlay;
  const asked = ++dataMapAsked;
  dataMapAskedAtMs = performance.now();
  dataMapInFlight = overlay !== 'None';
  void renderer
    .then(async (r) => {
      const layer = overlay === 'None' ? null : await client.request({ t: 'dataMap', overlay });
      if (asked !== dataMapAsked) return;
      dataMapLayer = layer;
      r.setDataMap(overlay, layer);
    })
    // A failed request leaves the map as it was and is asked again on the next refresh.
    .catch((error: unknown) => console.warn('data map request failed', error))
    .finally(() => {
      if (asked === dataMapAsked) dataMapInFlight = false;
    });
}
const dataMap: DataMapActions = {
  select: (overlay) => {
    dataMapOverlay = overlay;
    refreshDataMap();
  },
  legend: legendFor,
  read: () =>
    panelReading(dataMapOverlay, shownRenderer?.hovered ?? null, shownMap === null ? null : dataMapInputs(shownMap, dataMapLayer)),
};

// A loaded world may carry the edit version of the map on screen (P1, decision (c)): its map and size are read again
// whatever the version says, and an open data map asks for the loaded world's numbers.
function reloadMap<T>(reply: T): T {
  mapLoaded = true;
  shownMapEditVersion = null;
  shownOverlayGraphVersion = null;
  void api.snapshot().then(syncRender);
  if (dataMapOverlay !== 'None') refreshDataMap();
  return reply;
}
const loadSlot = api.load;
api.load = (slot) => loadSlot(slot).then(reloadMap);
const importSave = api.importSave;
api.importSave = (bytes) => importSave(bytes).then(reloadMap);

const { setSnapshot, setFps } = useSimStore.getState();
// The HUD frame rate: twice a second is enough to read and costs no re-render per frame.
void renderer.then((r) => setInterval(() => setFps(r.stats().fps), 500));
client.onFrame((snapshot) => {
  setSnapshot(snapshot);
  syncRender(snapshot);
  if (dataMapOverlay !== 'None' && !dataMapInFlight && performance.now() - dataMapAskedAtMs >= DATA_MAP_REFRESH_MS) refreshDataMap();
});
void api.ready
  .then(async () => {
    if (scenario !== undefined) {
      await api.setState('InGame');
      // `&size=<tiles>` builds a scenario of its own map on another size.
      const size = params.get('size');
      await api.scenario(scenario.name, size === null ? undefined : Number(size));
    }
    return api.snapshot();
  })
  .then((snapshot) => {
    setSnapshot(snapshot);
    syncRender(snapshot);
  });

const actions: HudActions = {
  setState: (state) => void api.setState(state),
  setSpeed: (speed) => void api.setSpeed(speed),
  scenarioHref: (s) => {
    const query = new URLSearchParams({ scenario: s.query });
    if (debug) query.set('debug', '1');
    if (rendererParam !== null) query.set('renderer', rendererParam);
    return `?${query.toString()}`;
  },
  command: (cmd) => void api.cmd(toRustCommand(cmd)),
  undoRedo: (redo) => void api.undoRedo(redo),
  focusTile: (at) =>
    void renderer.then((r) => {
      if (mapConfig !== null) focusViewOn(r.view, mapConfig, at);
    }),
};

const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <Hud actions={actions} dataMap={dataMap} />
  </StrictMode>,
);
