// The packaged Electron shell: it starts without taking focus, the game answers, and the test city
// holds its frame rate. `SIMCITY_TEST_WINDOW=1` keeps the window unfocused, on top and click-through.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {} from '../../app/src/simApi';

const APP = fileURLToPath(new URL('../release/mac-arm64/SimCity.app/Contents/MacOS/SimCity', import.meta.url));

test.skip(!existsSync(APP), 'build the app first: bun run desktop:build');

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ executablePath: APP, env: { ...process.env, SIMCITY_TEST_WINDOW: '1' } });
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  return { app, page };
}

test('startsWithNothingOnScreenAndTheSimAnswers', async () => {
  const { app, page } = await launch();
  try {
    const shown = await app.evaluate(({ app: a, BrowserWindow }) => ({
      windows: BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), focused: w.isFocused() })),
      dock: a.dock?.isVisible() ?? false,
    }));
    expect(shown).toEqual({ windows: [{ visible: false, focused: false }], dock: false });
    expect(page.url()).toBe('app://bundle/index.html');
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    const before = await page.evaluate(async () => {
      await window.__sim.setState('InGame');
      return (await window.__sim.snapshot()).tick;
    });
    await expect.poll(() => page.evaluate(() => window.__sim.snapshot().then((s) => s.tick))).toBeGreaterThan(before);
  } finally {
    await app.close();
  }
});

test('theTestCityHoldsItsFrameRate', async () => {
  const { app, page } = await launch();
  try {
    await page.evaluate(() => {
      location.search = '?scenario=city';
    });
    await page.waitForURL(/scenario=city/);
    await page.waitForFunction(() => typeof window.__sim !== 'undefined');
    await page.evaluate(() => window.__sim.ready);
    await page.waitForTimeout(2000);
    // Two counts per second: frames the page drew (rAF) and frames the GPU composited (`paint`).
    const paints = () => app.evaluate(() => (globalThis as { simcityPaintCount?: number }).simcityPaintCount ?? 0);
    const fps: number[] = [];
    const composited: number[] = [];
    for (let i = 0; i < 10; i++) {
      const before = await paints();
      const started = Date.now();
      await page.waitForTimeout(1000);
      composited.push(Math.round(((await paints()) - before) * (1000 / (Date.now() - started))));
      fps.push((await page.evaluate(() => window.__sim.renderStats())).fps);
    }
    const citizens = await page.evaluate(() => window.__sim.snapshot().then((s) => s.traffic.citizens));
    const backend = await page.evaluate(() => window.__sim.renderStats().then((s) => s.backend));
    const line = `page fps ${fps.join(' ')}; composited ${composited.join(' ')} (${backend}, citizens ${citizens})`;
    test.info().annotations.push({ type: 'fps', description: line });
    console.log(`test city: ${line}`);
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    expect(median(fps)).toBeGreaterThanOrEqual(58);
    expect(median(composited)).toBeGreaterThanOrEqual(55);
  } finally {
    await app.close();
  }
});
