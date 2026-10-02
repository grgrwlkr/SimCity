import react from '@vitejs/plugin-react';
import { defineConfig, type Connect, type Plugin } from 'vite';

// SharedArrayBuffer needs a cross-origin isolated page: COOP same-origin + COEP require-corp.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Answers every request in full. A 304 carries no COEP, and WebKit refuses a worker whose script it
 * revalidated that way: the second page opened in the same tab (a scenario link) never started the sim.
 */
const stripConditionalRequest: Connect.NextHandleFunction = (req, _res, next) => {
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  next();
};

const alwaysFullResponses: Plugin = {
  name: 'always-full-responses',
  configureServer: (server) => void server.middlewares.use(stripConditionalRequest),
  configurePreviewServer: (server) => void server.middlewares.use(stripConditionalRequest),
};

/**
 * `__SIM_API__`: whether the page installs `window.__sim` (main.tsx imports it dynamically under this flag, so a build
 * without it carries neither the code nor the name). On for the dev server (web e2e, `desktop:dev`); a build turns it on
 * only with `SIMCITY_SIM_API=1`, the desktop test build (`build:test`), never the release.
 */
const simApiFlag: Plugin = {
  name: 'sim-api-flag',
  config: (_config, { command }) => ({
    define: { __SIM_API__: JSON.stringify(command === 'serve' || process.env.SIMCITY_SIM_API === '1') },
  }),
};

/** 5174, the port the e2e gate opens; a preview beside another dev server gets its own through `PORT`. */
const port = Number(process.env.PORT ?? 5174);

export default defineConfig({
  plugins: [alwaysFullResponses, simApiFlag, react()],
  server: { port, strictPort: true, headers: crossOriginIsolation },
  preview: { port, strictPort: true, headers: crossOriginIsolation },
  // The one engine the game runs in: the Chromium of the desktop Electron (44.3.0 ships 152).
  // No source maps in a production build (Vite's default, pinned: the shipped app must not carry them).
  build: { target: 'chrome152', sourcemap: false },
  worker: { format: 'es' },
});
