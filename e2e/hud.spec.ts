// U1: the HUD bar over the map — clicks with Playwright, the dev gate, a click that stays on the panel.
import { expect, test, type Page } from '@playwright/test';
import type {} from '../packages/app/src/simApi';

async function openGame(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  // A scenario opens in game by itself; the plain page opens on the menu.
  if (!query.includes('scenario=')) await page.evaluate(() => window.__sim.setState('InGame'));
  await expect(page.getByTestId('hud')).toBeVisible();
}

test('uiShellHudBarShowsTheCity', async ({ page }) => {
  await openGame(page);
  await expect(page.getByTestId('money')).toHaveText(/^-?\$\d{1,3}(\u00a0\d{3})*$/);
  await expect(page.getByTestId('clock')).toHaveText(/^День \d+, \d{2}:\d{2}$/);
  await expect(page.getByTestId('population')).toHaveText(/^Население \d/);
  // window_title.rs: the title speaks to the player too.
  await expect(page).toHaveTitle(/^SimCity — День \d+ — -?\$[\d\u00a0]+ — Население \d/);
});

test('uiShellOneActivationOfASpeedButtonSetsTheSpeed', async ({ page }) => {
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
  await expect(page.getByTestId('hud-menu')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__sim.snapshot().then((s) => s.appState))).toBe('MainMenu');
});

// hud_bar.rs dev_ui_gated_game_interface_shows_no_developer_element, in a running city: the city scenario has every
// dev row to leak (commuters, trips, the tick cost).
test('devUiGatedGameInterfaceShowsNoDeveloperElement', async ({ page }) => {
  await openGame(page, '?scenario=city');
  await expect.poll(() => page.evaluate(() => window.__sim.snapshot().then((s) => s.traffic.citizens)), { timeout: 30_000 }).toBe(2000);
  // The renderer reports a frame rate twice a second: wait past it, then the DOM still has none.
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats().then((s) => s.fps))).toBeGreaterThan(0);
  await page.waitForTimeout(700);
  for (const id of ['fps', 'tick', 'sim-tick', 'citizens', 'driving', 'emergencies']) await expect(page.getByTestId(id)).toHaveCount(0);
  const shown = (await page.locator('body').innerText()).toLowerCase();
  expect(shown, 'the check needs the real interface').toContain('население');
  for (const word of ['fps', 'mcp', 'seed', 'dump', 'test city', 'тик', 'сим ', 'жители']) expect(shown).not.toContain(word);
});

test('devUiShownUnderDebugFlag', async ({ page }) => {
  await openGame(page, '?debug=1');
  await expect(page.getByTestId('fps')).toHaveText(/^FPS \d+$/);
  await expect(page.getByTestId('tick')).toHaveText(/^тик \d+$/);
  await expect(page.getByTestId('driving')).toBeVisible();
});

/** Drags from one point to another with the left button, the way installViewControls pans. */
async function drag(page: Page, from: { x: number; y: number }, by: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 2 });
  await page.mouse.up();
}

const centre = (s: { centerX: number; centerY: number }) => [s.centerX, s.centerY];

test('uiShellPointerOverAGamePanelIsCapturedAndReleasedWhenItLeaves', async ({ page }) => {
  // Every pointer move over the canvas waits for a frame drawn on the processor: slow under a loaded machine.
  test.setTimeout(60_000);
  await openGame(page);
  await page.evaluate(() => window.__sim.setSpeed('Paused'));
  const before = await page.evaluate(() => window.__sim.camera());
  const box = (await page.getByTestId('money').boundingBox())!;
  await drag(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: 200, y: 150 });
  expect(centre(await page.evaluate(() => window.__sim.camera())), 'a drag on the bar belongs to the interface').toEqual(centre(before));

  // The pointer left the panel: the map is the player's again.
  await drag(page, { x: 640, y: 500 }, { x: 200, y: 150 });
  expect(centre(await page.evaluate(() => window.__sim.camera()))).not.toEqual(centre(before));
});

test('uiShellLayoutRootsLetThePointerThrough', async ({ page }) => {
  // Every pointer move over the canvas waits for a frame drawn on the processor: slow under a loaded machine.
  test.setTimeout(60_000);
  await openGame(page);
  await page.evaluate(() => window.__sim.setSpeed('Paused'));
  const before = await page.evaluate(() => window.__sim.camera());
  // Beside the bar, at its height: the wrapper spans the width to centre the bar, and that strip is still map.
  const box = (await page.getByTestId('money').boundingBox())!;
  await drag(page, { x: 40, y: box.y + box.height / 2 }, { x: 200, y: 150 });
  expect(centre(await page.evaluate(() => window.__sim.camera()))).not.toEqual(centre(before));
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
