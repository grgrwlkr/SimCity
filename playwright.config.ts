import {defineConfig, devices} from '@playwright/test';

/** 5174 unless `E2E_PORT` says otherwise: the gate runs beside a dev server another session holds. */
const port = Number(process.env.E2E_PORT ?? 5174);

// `E2E_GPU=1`: headless Chromium draws on the GPU through ANGLE Metal instead of SwiftShader on the processor, for the
// frame-rate measurements; the gate itself runs on the default.
const chromium = {
  ...devices['Desktop Chrome'],
  ...(process.env.E2E_GPU === '1'
    ? {
        launchOptions: {
          args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
        },
      }
    : {}),
};

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  // SwiftShader and trace readbacks share the runner's CPUs; keep one browser rendering at a time.
  ...(process.env.CI ? {workers: 1} : {}),
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    // Retain DOM/actions/network diagnostics without per-frame WebGL ReadPixels screencasts.
    trace: process.env.CI
      ? {mode: 'retain-on-failure', screenshots: false}
      : 'off',
  },
  // The stage gate: the same numbers in Chromium as in Node.
  projects: [{name: 'chromium', use: chromium}],
  webServer: {
    command: 'bun run dev',
    url: `http://localhost:${port}`,
    env: {PORT: String(port)},
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
