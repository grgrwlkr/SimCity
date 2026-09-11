import { SimClient } from '@simcity/bridge';
import { Hud, useSimStore, type HudActions } from '@simcity/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installSimApi } from './simApi';
import './styles.css';

if (!crossOriginIsolated) {
  throw new Error('SharedArrayBuffer needs a cross-origin isolated page: serve with COOP/COEP headers (README).');
}

const worker = new Worker(new URL('../../bridge/src/worker.ts', import.meta.url), { type: 'module' });
const client = new SimClient(worker);
const api = installSimApi(client, new URLSearchParams(location.search).get('debug') === '1');

const { setSnapshot } = useSimStore.getState();
client.onFrame(setSnapshot);
void api.ready.then(() => api.snapshot()).then(setSnapshot);

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
