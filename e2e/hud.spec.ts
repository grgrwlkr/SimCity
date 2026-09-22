// U1: the HUD bar over the map — clicks with Playwright, the dev gate, a click that stays on the panel.
import { expect, test, type Page } from '@playwright/test';
import type {} from '../packages/app/src/simApi';

async function openGame(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  // A scenario opens in game by itself; the plain page opens on the menu.
  if (!query.includes('scenario=')) await page.getByTestId('start').click();
  await expect(page.getByTestId('hud')).toBeVisible();
}

test('hudBarShowsMoneyDayHourAndPopulation', async ({ page }) => {
  await openGame(page);
  await expect(page.getByTestId('money')).toHaveText(/^-?\$\d{1,3}(\u00a0\d{3})*$/);
  await expect(page.getByTestId('clock')).toHaveText(/^День \d+, \d{2}:\d{2}$/);
  await expect(page.getByTestId('population')).toHaveText(/^Население \d/);
});

test('aSpeedIsSetWithOneClickOnTheBar', async ({ page }) => {
  await openGame(page);
  const speeds = page.getByRole('navigation', { name: 'Скорость' });
  await speeds.getByRole('button', { name: '×10', exact: true }).click();
  await expect(speeds.getByRole('button', { name: '×10', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.__sim.snapshot().then((s) => s.speed))).toBe('X10');
  await speeds.getByRole('button', { name: 'Стоп', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__sim.snapshot().then((s) => s.speed))).toBe('Paused');
  await expect(speeds.getByRole('button', { pressed: true })).toHaveText(['Стоп']);
});

test('theMenuButtonOnTheBarLeadsToTheMainMenu', async ({ page }) => {
  await openGame(page);
  await page.getByTestId('hud').getByRole('button', { name: 'В меню' }).click();
  await expect(page.getByTestId('start')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__sim.snapshot().then((s) => s.appState))).toBe('MainMenu');
});

test('devUiGatedWithoutDebugFlag', async ({ page }) => {
  await openGame(page);
  // The renderer reports a frame rate twice a second: wait past it, then the DOM still has none.
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats().then((s) => s.fps))).toBeGreaterThan(0);
  await page.waitForTimeout(700);
  for (const id of ['fps', 'tick', 'sim-tick', 'driving', 'emergencies']) await expect(page.getByTestId(id)).toHaveCount(0);
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/FPS|тик \d/);
});

test('devUiShownUnderDebugFlag', async ({ page }) => {
  await openGame(page, '?debug=1');
  await expect(page.getByTestId('fps')).toHaveText(/^FPS \d+$/);
  await expect(page.getByTestId('tick')).toHaveText(/^тик \d+$/);
  await expect(page.getByTestId('driving')).toBeVisible();
});

test('aDragOnTheBarDoesNotReachTheMap', async ({ page }) => {
  await openGame(page);
  await page.evaluate(() => window.__sim.setSpeed('Paused'));
  const before = await page.evaluate(() => window.__sim.camera());
  const box = (await page.getByTestId('money').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 150, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(() => window.__sim.camera());
  expect([after.centerX, after.centerY]).toEqual([before.centerX, before.centerY]);

  // Beside the bar, at the same height, the map takes the drag: the wrapper does not eat the top strip.
  await page.mouse.move(40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(240, box.y + box.height / 2 + 150, { steps: 5 });
  await page.mouse.up();
  const panned = await page.evaluate(() => window.__sim.camera());
  expect([panned.centerX, panned.centerY]).not.toEqual([before.centerX, before.centerY]);
});

// Headless screenshots of the bar over a light and a dark spot of the map, for the handoff.
test('hudBarScreenshotsOverLightAndDarkMap', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openGame(page, '?scenario=living');
  await expect(page.getByTestId('population')).toHaveText(/^Население \d/);
  await page.evaluate(() => window.__sim.setSpeed('Paused'));
  const dir = process.env.HUD_SHOTS_DIR;
  // Dark: downtown streets by the boulevard (asphalt, as render.spec's living-x1-downtown); light: a close-up of pale tiles.
  const views = [
    ['hud-dark', { centerX: -24, centerY: -24, worldPerPixel: 0.5 }],
    ['hud-light', { worldPerPixel: 0.05 }],
  ] as const;
  for (const [name, view] of views) {
    await page.evaluate((v) => window.__sim.setCamera(v), view);
    await page.waitForTimeout(400);
    const path = dir === undefined ? testInfo.outputPath(`${name}.png`) : `${dir}/${name}.png`;
    await page.screenshot({ path, clip: { x: 0, y: 0, width: 1280, height: 200 } });
  }
});
