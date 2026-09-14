import { defineConfig, devices } from '@playwright/test';

/** 5174 unless `E2E_PORT` says otherwise: the gate runs beside a dev server another session holds. */
const port = Number(process.env.E2E_PORT ?? 5174);

/** The metropolis builds a million citizens in each engine and in Node: it runs after the rest, whose time limits it starved. */
const METROPOLIS = /metropolis\.spec\.ts/;
// `E2E_GPU=1`: headless Chromium draws on the GPU through ANGLE Metal instead of SwiftShader on the processor, for the
// frame-rate measurements; the gate itself runs on the default.
const chromium = {
  ...devices['Desktop Chrome'],
  ...(process.env.E2E_GPU === '1' ? { launchOptions: { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } } : {}),
};

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${port}` },
  // The stage gate: the same numbers in a Chromium and a WebKit engine.
  projects: [
    { name: 'chromium', testIgnore: METROPOLIS, use: chromium },
    { name: 'webkit', testIgnore: METROPOLIS, use: { ...devices['Desktop Safari'] } },
    { name: 'metropolis-chromium', testMatch: METROPOLIS, dependencies: ['chromium', 'webkit'], use: chromium },
    { name: 'metropolis-webkit', testMatch: METROPOLIS, dependencies: ['chromium', 'webkit'], use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'bun run dev',
    url: `http://localhost:${port}`,
    env: { PORT: String(port) },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
