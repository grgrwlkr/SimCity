// `bun run desktop:e2e`: the packaged shell, not the web page. The specs launch
// release/mac-arm64/SimCity.app through Playwright's Electron driver; build it first.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 90_000,
  reporter: [['list']],
});
