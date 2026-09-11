// Stage 0 gate: the worker in each browser engine computes exactly what Node computes.
import { expect, test } from '@playwright/test';
import type {} from '../packages/app/src/simApi';
import { createWorld, fingerprint, requestState, rngProbeDigest, step, toHex64 } from '../packages/sim/src/index';

const TICKS = 10_000;
const PROBE_DRAWS = 100_000;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
});

test('fingerprintMatchesNodeInBothEngines', async ({ page }) => {
  const reply = await page.evaluate(async (ticks) => {
    // The real-time loop must not add ticks of its own to the manual run.
    await window.__sim.setSpeed('Paused');
    await window.__sim.setState('InGame');
    return window.__sim.step(ticks);
  }, TICKS);

  const w = createWorld();
  requestState(w, 'InGame');
  step(w, TICKS);
  expect(reply).toEqual({ tick: TICKS, fingerprint: toHex64(fingerprint(w)) });

  const frame = await page.evaluate(() => window.__sim.renderFrame());
  expect(frame, 'the main thread reads the frame the worker published').toEqual({ tick: TICKS, count: 0 });
});

test('rngProbeMatchesNodeInBothEngines', async ({ page }) => {
  const digest = await page.evaluate((draws) => window.__sim.rngProbe('42', draws), PROBE_DRAWS);
  expect(digest).toBe(rngProbeDigest(42n, PROBE_DRAWS));
});

test('menuStartsAGameAndTheClockRuns', async ({ page }, testInfo) => {
  await page.getByTestId('start').click();
  await expect(page.getByTestId('hud')).toBeVisible();
  // One real second at ×1 is one game hour.
  await expect(page.getByTestId('clock')).toHaveText('День 1, 01:00', { timeout: 5_000 });
  await page.screenshot({ path: testInfo.outputPath('hud.png') });

  await page.keyboard.press('Space');
  await expect(page.getByText('Пауза')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('start')).toBeVisible();
});

test('hudShowsTheFrameRate', async ({ page }) => {
  await page.getByTestId('start').click();
  const fps = page.getByTestId('fps');
  await expect(fps).toHaveText(/^FPS \d+$/);
  await expect.poll(async () => Number((await fps.textContent())?.replace('FPS ', ''))).toBeGreaterThan(0);
});

test('debugFlagReachesTheApi', async ({ page }) => {
  expect(await page.evaluate(() => window.__sim.debug)).toBe(false);
  await page.goto('/?debug=1');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  expect(await page.evaluate(() => window.__sim.debug)).toBe(true);
});
