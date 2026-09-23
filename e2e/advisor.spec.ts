// U7: the advisor's panel in a running game (docs/design/hud/layout.md §8, states.md). Port of the behaviour of
// rust-final crates/simcity_frontend/src/game/hud/advisor_panel.rs: it opens from the HUD bar, names the worst problem
// the snapshot carries or says nothing needs attention, keeps its clicks off the map, and a problem with a place takes
// the camera there.
import { expect, test, type Page } from '@playwright/test';
import type {} from '../packages/app/src/simApi';

// Opening the game alone takes 25 s under a loaded machine (rev-toasts, round 1).
test.describe.configure({ timeout: 120_000 });
// The Electron window and the smallest screen of states.md: the panel must clear the palette here.
test.use({ viewport: { width: 1280, height: 800 } });

async function openGame(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  // A scenario opens straight into the game (hud.spec.ts `openGame`).
  if (!url.includes('scenario=')) await page.getByTestId('start').click();
  await expect(page.getByTestId('hud')).toBeVisible();
}

async function openAdvisor(page: Page): Promise<void> {
  await expect(page.getByTestId('advisor-toggle'), 'the advisor is mounted in the HUD bar').toBeVisible();
  await expect(page.getByTestId('advisor')).toHaveCount(0);
  await page.getByTestId('advisor-toggle').click();
  await expect(page.getByTestId('advisor-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('advisor')).toBeVisible();
  // Focus moves into the panel on opening, so the next Esc is the panel's (rev-advisor-panel, finding 1).
  await expect(page.getByTestId('advisor')).toBeFocused();
}

/** The panel stops above the palette rather than covering its left end (rev-advisor-panel, finding 3). */
async function expectClearOfPalette(page: Page): Promise<void> {
  const panel = await page.getByTestId('advisor').boundingBox();
  const palette = await page.getByRole('toolbar', { name: 'Инструменты' }).boundingBox();
  expect(panel, 'the panel is laid out').not.toBeNull();
  expect(palette, 'the palette is laid out').not.toBeNull();
  expect(panel!.y + panel!.height, `the panel ${JSON.stringify(panel)} ends above the palette ${JSON.stringify(palette)}`).toBeLessThanOrEqual(palette!.y);
}

const snapshot = (page: Page) => page.evaluate(() => window.__sim.snapshot());

/** The tile under the centre of the view. */
const centreTile = (page: Page) =>
  page.evaluate(async () => {
    const camera = await window.__sim.camera();
    return window.__sim.pickTile(camera.width / 2, camera.height / 2);
  });

test('advisorOpensFromTheBarAndNamesTheWorstProblem', async ({ page }) => {
  await openGame(page);
  await page.evaluate(() => window.__sim.setSpeed('Paused'));
  await openAdvisor(page);
  // The worst problem of the snapshot, or the healthy city's one line (states.md), read afresh on every try: a tick
  // in flight when the game paused may still change it.
  const worst = page.getByTestId('advisor').locator('.advisor-worst');
  await expect
    .poll(async () => {
      await page.evaluate(() => window.__sim.step(1));
      const expected = (await snapshot(page)).advisor[0]?.text ?? 'Ничего не требует внимания';
      return (await worst.textContent()) === expected;
    }, { message: 'the panel names the worst problem of the snapshot' })
    .toBe(true);
  await page.getByTestId('advisor-toggle').click();
  await expect(page.getByTestId('advisor')).toHaveCount(0);
});

test('advisorPanelKeepsItsClicksOffTheMapAndEscClosesIt', async ({ page }) => {
  await openGame(page);
  await openAdvisor(page);
  const camera = await page.evaluate(() => window.__sim.camera());
  const panel = page.getByTestId('advisor');
  await panel.hover();
  await page.mouse.wheel(0, 600);
  await page.mouse.down();
  await page.mouse.up();
  expect(await page.evaluate(() => window.__sim.camera()), 'a wheel on the panel does not zoom the map').toEqual(camera);
  // Straight from the toggle, as a player does: the panel took focus on opening.
  await expect(panel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.evaluate(() => window.__sim.step(1));
  expect((await snapshot(page)).appState, 'Esc closed the panel, not the game').not.toBe('MainMenu');
  await expect(page.getByTestId('advisor-toggle')).toBeFocused();
});

test('clickingAProblemWithAPlaceTakesTheCameraThere', async ({ page }) => {
  // openGame (up to 25 s under load) + the 90 s poll + the rest.
  test.setTimeout(240_000);
  // The living city grows zoned buildings before any plant or pump: the advisor points at the first one without.
  await openGame(page, '/?scenario=living');
  await page.evaluate(() => window.__sim.setSpeed('X360'));
  await expect
    .poll(async () => (await snapshot(page)).advisor, { message: 'the living city has a problem with a place', timeout: 90_000 })
    .toContainEqual(expect.objectContaining({ at: expect.anything() }));
  await page.evaluate(() => window.__sim.setSpeed('Paused'));
  await page.evaluate(() => window.__sim.fitMap());
  await openAdvisor(page);
  await expectClearOfPalette(page);
  const centre = await centreTile(page);
  const placed = (await snapshot(page)).advisor.find((problem) => problem.at !== null && (problem.at.x !== centre?.x || problem.at.y !== centre?.y));
  expect(placed, `a problem with a place away from the centre tile ${JSON.stringify(centre)} is still named after the pause`).toBeDefined();
  const line = page.getByTestId('advisor-problem').filter({ hasText: placed!.text });
  // Space on a focused problem presses it: the camera goes there and the game does not pause (finding 2).
  await line.focus();
  await page.keyboard.press('Space');
  await expect.poll(() => centreTile(page)).toEqual(placed!.at);
  await page.evaluate(() => window.__sim.step(1));
  expect((await snapshot(page)).appState, 'Space on a problem is not the pause hotkey').toBe('InGame');
  await page.evaluate(() => window.__sim.fitMap());
  await line.click();
  await expect.poll(() => centreTile(page)).toEqual(placed!.at);
});
