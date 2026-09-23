// U7: the advisor's panel in a running game (docs/design/hud/layout.md §8, states.md). Port of the behaviour of
// rust-final crates/simcity_frontend/src/game/hud/advisor_panel.rs: it opens from the HUD bar, names the worst problem
// the snapshot carries or says nothing needs attention, keeps its clicks off the map, and a problem with a place takes
// the camera there.
import { expect, test, type Page } from '@playwright/test';
import type {} from '../packages/app/src/simApi';

// Opening the game alone takes 25 s under a loaded machine (rev-toasts, round 1).
test.describe.configure({ timeout: 120_000 });

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
  // The worst problem of the snapshot, or the healthy city's one line (states.md).
  const worst = (await snapshot(page)).advisor[0]?.text ?? 'Ничего не требует внимания';
  await expect(page.getByTestId('advisor').locator('.advisor-worst')).toHaveText(worst);
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
  await panel.locator('h2').click();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.evaluate(() => window.__sim.step(1));
  expect((await snapshot(page)).appState, 'Esc closed the panel, not the game').not.toBe('MainMenu');
  await expect(page.getByTestId('advisor-toggle')).toBeFocused();
});

test('clickingAProblemWithAPlaceTakesTheCameraThere', async ({ page }) => {
  // The living city grows zoned buildings before any plant or pump: the advisor points at the first one without.
  await openGame(page, '/?scenario=living');
  await page.evaluate(() => window.__sim.setSpeed('X360'));
  await expect
    .poll(async () => (await snapshot(page)).advisor, { message: 'the living city has a problem with a place', timeout: 90_000 })
    .toContainEqual(expect.objectContaining({ at: expect.anything() }));
  await page.evaluate(() => window.__sim.setSpeed('Paused'));
  await page.evaluate(() => window.__sim.fitMap());
  await openAdvisor(page);
  const placed = (await snapshot(page)).advisor.find((problem) => problem.at !== null)!;
  expect(await centreTile(page), 'the camera starts elsewhere').not.toEqual(placed.at);
  await page.getByTestId('advisor-problem').filter({ hasText: placed.text }).click();
  await expect.poll(() => centreTile(page)).toEqual(placed.at);
});
