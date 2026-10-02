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

/** 5174, the port the e2e gate opens; a preview beside another dev server gets its own through `PORT`. */
const port = Number(process.env.PORT ?? 5174);

export default defineConfig({
  plugins: [alwaysFullResponses, react()],
  server: { port, strictPort: true, headers: crossOriginIsolation },
  preview: { port, strictPort: true, headers: crossOriginIsolation },
  // The one engine the game runs in: the Chromium of the desktop Electron (44.3.0 ships 152).
  // No source maps in a production build (Vite's default, pinned: the shipped app must not carry them).
  build: { target: 'chrome152', sourcemap: false },
  worker: { format: 'es' },
});
