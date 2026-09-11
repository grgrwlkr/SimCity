import { RenderReader, SimClient, type WorldSnapshot } from '@simcity/bridge';
import { DebugRenderer, installViewControls } from '@simcity/render';
import { SIGNALIZED_CROSS, tileToWorld, type MapConfig } from '@simcity/sim';
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
/** `?scenario=signalized`: the lit cross with traffic, the camera on its box. */
const scenario = params.get('scenario') === 'signalized' ? 'signalizedCross' : null;
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
      if (first) r.view.fitMap(mapConfig);
      if (focusPending && map.mapEditVersion > 0) {
        // The scenario's map is on screen: centre its box and show the whole cross.
        const box = tileToWorld(mapConfig, SIGNALIZED_CROSS.box);
        r.view.centerX = box.x + map.tileSize / 2;
        r.view.centerY = box.y + map.tileSize / 2;
        const span = (SIGNALIZED_CROSS.hi - SIGNALIZED_CROSS.lo + 6) * map.tileSize;
        r.view.worldPerPixel = span / Math.max(Math.min(r.view.viewport.width, r.view.viewport.height), 1);
        focusPending = false;
      }
      shownMapEditVersion = map.mapEditVersion;
    }
    r.setLights(snapshot.lights);
    if (debug && snapshot.graphVersion !== shownOverlayGraphVersion) {
      const overlay = await client.request({ t: 'debugOverlay' });
      if (overlay.laneletsBuiltFor === overlay.graphVersion) {
        r.setOverlay(overlay);
        shownOverlayGraphVersion = overlay.graphVersion;
      }
    }
  });
}

const { setSnapshot } = useSimStore.getState();
client.onFrame((snapshot) => {
  setSnapshot(snapshot);
  syncRender(snapshot);
});
void api.ready
  .then(async () => {
    if (scenario !== null) {
      await api.setState('InGame');
      await api.scenario(scenario);
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
