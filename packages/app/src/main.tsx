import { RenderReader, SimClient, type WorldSnapshot } from '@simcity/bridge';
import { DebugRenderer, installViewControls } from '@simcity/render';
import { CROSS_LAYOUT, SIGNALIZED_CROSS, crossBoxSize, tileToWorld, type CrossScenarioName, type MapConfig } from '@simcity/sim';
import { Hud, useSimStore, type HudActions } from '@simcity/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installSimApi } from './simApi';
import './styles.css';

if (!crossOriginIsolated) {
  throw new Error('SharedArrayBuffer needs a cross-origin isolated page: serve with COOP/COEP headers (README).');
}

const params = new URLSearchParams(location.search);
const debug = params.get('debug') === '1';
/** `?scenario=signalized` (two lanes) or `?scenario=signalized4` (four): a lit cross with traffic, the camera on its box. */
const SCENARIOS: Readonly<Record<string, CrossScenarioName>> = { signalized: 'signalizedCross', signalized4: 'signalizedCross4' };
const scenario = SCENARIOS[params.get('scenario') ?? ''] ?? null;
/** `?scenario=city`: commuters in their own cars on a generated city, the whole map in view. */
const city = params.get('scenario') === 'city';
let focusPending = scenario !== null;
const canvas = document.getElementById('view');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('canvas#view is missing from index.html');

const worker = new Worker(new URL('../../bridge/src/worker.ts', import.meta.url), { type: 'module' });
const client = new SimClient(worker);

let mapConfig: MapConfig | null = null;
const renderer = client.ready.then(async (sab) => {
  const r = await DebugRenderer.create(canvas);
  r.attachRenderBuffer(new RenderReader(sab));
  installViewControls(canvas, r, () => mapConfig);
  return r;
});
const api = installSimApi(client, debug, renderer, () => mapConfig);

// Keeps the picture in step with the worker: the map when its edit version moves, the overlay
// (debug only) once the lanelets are built for the current graph version. One sync at a time.
let shownMapEditVersion: number | null = null;
let shownOverlayGraphVersion: number | null = null;
let sync = Promise.resolve();
function syncRender(snapshot: WorldSnapshot): void {
  sync = sync.then(async () => {
    const r = await renderer;
    if (snapshot.mapEditVersion !== shownMapEditVersion) {
      const map = await client.request({ t: 'mapLayers' });
      const first = mapConfig === null;
      mapConfig = { width: map.width, height: map.height, tileSize: map.tileSize };
      r.setMap(map);
      if (first) {
        // A page opened in a hidden pane starts with a 0×0 canvas: fit the map once it has a size.
        const cfg = mapConfig;
        void r.whenSized().then(() => r.view.fitMap(cfg));
      }
      shownMapEditVersion = map.mapEditVersion;
    }
    r.setLights(snapshot.lights);
    // The scenario's map is on screen: centre its box and show the whole cross, once the canvas has a
    // size (registered after the first fit, so it runs after it).
    if (focusPending && scenario !== null && mapConfig !== null && (shownMapEditVersion ?? 0) > 0) {
      focusPending = false;
      const cfg = mapConfig;
      // `tileToWorld` is a tile centre: the box centre lies (size − 1) / 2 tiles past its first tile.
      const toCentre = ((crossBoxSize(CROSS_LAYOUT[scenario]) - 1) / 2) * cfg.tileSize;
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

const { setSnapshot, setFps } = useSimStore.getState();
// The HUD frame rate: twice a second is enough to read and costs no re-render per frame.
void renderer.then((r) => setInterval(() => setFps(r.stats().fps), 500));
client.onFrame((snapshot) => {
  setSnapshot(snapshot);
  syncRender(snapshot);
});
void api.ready
  .then(async () => {
    if (scenario !== null) {
      await api.setState('InGame');
      await api.scenario(scenario);
    } else if (city) {
      await api.setState('InGame');
      await api.scenario('city');
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
};

const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <Hud actions={actions} />
  </StrictMode>,
);
