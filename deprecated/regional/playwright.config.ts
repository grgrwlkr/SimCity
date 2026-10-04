import {defineConfig, devices} from '@playwright/test';
const baseURL = process.env.LEGACY_REGION_BASE_URL;
if (!baseURL) {
  throw new Error(
    'Historical region E2E requires LEGACY_REGION_BASE_URL pointing to a preserved legacy UI; the native primary app is not that fixture.',
  );
}
export default defineConfig({
  testDir: 'e2e',
  use: {baseURL},
  projects: [
    {name: 'legacy-region-chromium', use: {...devices['Desktop Chrome']}},
  ],
});
