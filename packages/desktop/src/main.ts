// The desktop shell: one Chromium window over packages/app. `bun run desktop:dev` points it at the
// Vite dev server; the packaged app serves the Vite build from its asar through the `app://` scheme,
// with the headers cross-origin isolation (and so the sim's SharedArrayBuffer) needs.
import { app, BrowserWindow, net, protocol } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.join(here, 'renderer');
const APP_HOST = 'bundle';
/** Set by `bun run desktop:dev`. */
const devServerUrl = process.env.SIMCITY_DEV_SERVER_URL;
/**
 * `SIMCITY_TEST_WINDOW=1` (e2e and measurements): the app does not activate, the window never takes
 * focus and lets clicks through, and it stays on top, because an occluded window stops drawing.
 */
const testWindow = process.env.SIMCITY_TEST_WINDOW === '1';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Must run before `ready`. `standard` and `secure` make it a secure origin that can be isolated.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

async function serveRenderer(request: Request): Promise<Response> {
  const { host, pathname } = new URL(request.url);
  const file = path.resolve(RENDERER_DIR, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
  const relative = path.relative(RENDERER_DIR, file);
  if (host !== APP_HOST || relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return new Response('not found', { status: 404 });
  }
  const response = await net.fetch(pathToFileURL(file).toString());
  if (!response.ok) return new Response('not found', { status: 404 });
  return new Response(response.body, {
    headers: {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  });
}

/** The only origin the window may show: the dev server or the bundled build. */
function allowedOrigin(url: string): boolean {
  const target = new URL(url);
  if (devServerUrl !== undefined) return target.origin === new URL(devServerUrl).origin;
  return target.protocol === 'app:' && target.host === APP_HOST;
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'SimCity',
    show: !testWindow,
    ...(testWindow ? { focusable: false, alwaysOnTop: true } : {}),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (testWindow) {
    window.setIgnoreMouseEvents(true);
    window.once('ready-to-show', () => window.showInactive());
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!allowedOrigin(url)) event.preventDefault();
  });
  void window.loadURL(devServerUrl ?? `app://${APP_HOST}/index.html`);
}

app.on('window-all-closed', () => app.quit());

void app.whenReady().then(() => {
  if (testWindow && process.platform === 'darwin') app.setActivationPolicy('accessory');
  protocol.handle('app', serveRenderer);
  createWindow();
});
