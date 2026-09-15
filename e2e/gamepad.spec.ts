// Stage 7: the gamepad layer in Chromium — silent without a pad, and a pad drives the camera and the clock.
import { expect, test } from '@playwright/test';
import type {} from '../packages/app/src/simApi';

interface FakePad {
  connected: boolean;
  mapping: 'standard';
  axes: number[];
  buttons: { pressed: boolean; value: number }[];
}

test('withoutAPadTheAppRunsAndNothingThrows', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  expect(await page.evaluate(() => [...navigator.getGamepads()].every((p) => p === null))).toBe(true);

  await page.getByTestId('start').click();
  await expect(page.getByTestId('clock')).toHaveText(/^День 1, 00:00:0[1-9]$/, { timeout: 5_000 });
  await page.keyboard.press('Space');
  await expect(page.getByText('Пауза')).toBeVisible();
  expect(errors).toEqual([]);
});

test('aStandardPadPansTheCameraAndPausesTheGame', async ({ page }) => {
  await page.addInitScript(() => {
    const pad: FakePad = {
      connected: true,
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    };
    (window as unknown as { __fakePad: FakePad }).__fakePad = pad;
    Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [pad, null, null, null] });
  });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await page.getByTestId('start').click();
  await expect(page.getByTestId('hud')).toBeVisible();

  const before = await page.evaluate(() => window.__sim.camera());
  await page.evaluate(() => {
    (window as unknown as { __fakePad: FakePad }).__fakePad.axes[0] = 1;
  });
  await expect.poll(() => page.evaluate(() => window.__sim.camera().then((c) => c.centerX))).toBeGreaterThan(before.centerX);
  await page.evaluate(() => {
    (window as unknown as { __fakePad: FakePad }).__fakePad.axes[0] = 0;
  });

  await page.evaluate(() => {
    (window as unknown as { __fakePad: FakePad }).__fakePad.buttons[9] = { pressed: true, value: 1 };
  });
  await expect(page.getByText('Пауза')).toBeVisible();
});
