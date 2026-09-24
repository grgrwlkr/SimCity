// `bun run desktop:e2e`: the packaged shell, not the web page. package.spec.ts reads and starts the release
// (release/mac-arm64, `bun run desktop:build`); shell.spec.ts drives a clone of the test build (release/test/mac-arm64,
// `bun run desktop:build:test`) through Playwright's Electron driver. Build both first, from the same commit.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 90_000,
  reporter: [['list']],
});
