import { defineConfig, devices } from '@playwright/test';

/** 5174 unless `E2E_PORT` says otherwise: the gate runs beside a dev server another session holds. */
const port = Number(process.env.E2E_PORT ?? 5174);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${port}` },
  // The stage gate: the same numbers in a Chromium and a WebKit engine.
  projects: [
    // `E2E_GPU=1`: headless Chromium draws on the GPU through ANGLE Metal instead of SwiftShader on the processor, for the
    // frame-rate measurements; the gate itself runs on the default.
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.E2E_GPU === '1' ? { launchOptions: { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } } : {}),
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'bun run dev',
    url: `http://localhost:${port}`,
    env: { PORT: String(port) },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
