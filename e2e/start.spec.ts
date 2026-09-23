// U8: the start screen in the live app — the menu is the way into a city (start_screen.rs at rust-final), and the
// objectives panel of a catalogue preset in the city it starts. Every test first checks the screen is mounted: on a
// branch without the HUD wiring that is the one thing that fails.
import { SCENARIOS } from '../packages/bridge/src/scenarios';
import { expect, test, type Page } from '@playwright/test';
import type {} from '../packages/app/src/simApi';

async function openMenu(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await expect(page.getByTestId('hud-menu'), 'the start screen is mounted in the menu').toBeVisible();
}

/** Press a menu button: the app opens the choice on a fresh page, so wait for that page's `__sim`. */
async function pick(page: Page, testId: string, url: RegExp): Promise<void> {
  await page.getByTestId(testId).click();
  await page.waitForURL(url);
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
}

const appState = (page: Page) => page.evaluate(() => window.__sim.snapshot().then((s) => s.appState));
const scenarioId = (page: Page) => page.evaluate(() => window.__sim.snapshot().then((s) => s.scenario?.id ?? null));

// headless_sim.rs menu_first_startup_waits_in_the_main_menu_on_an_empty_map, plus the dev gate of start_screen.rs.
test('menuFirstStartupShowsTheStartScreenWithEveryScenarioAndNoDeveloperElement', async ({ page }) => {
  await openMenu(page, '?debug=1');
  expect(await appState(page)).toBe('MainMenu');
  await expect(page.getByTestId('menu-new-map')).toBeVisible();
  await expect(page.getByTestId('menu-demo-city')).toBeVisible();
  for (const s of SCENARIOS) await expect(page.getByTestId(`menu-scenario-${s.name}`)).toHaveText(new RegExp(s.title));
  await expect(page.getByTestId('menu-scenario-starter')).toContainText('Цели: население 50, счастье 60\u00a0%');
  const shown = (await page.getByTestId('hud-menu').innerText()).toLowerCase();
  for (const marker of ['test city', 'seed', 'dump', 'mcp', 'fps', 'тестов', 'сид', 'дамп']) expect(shown).not.toContain(marker);
  // The menu shows only the start screen: none of the game interface.
  await expect(page.getByTestId('hud')).toHaveCount(0);
});

test('uiShellPickingAScenarioStartsItWithItsGoalsOnScreen', async ({ page }) => {
  await openMenu(page);
  await pick(page, 'menu-scenario-starter', /scenario=starter/);
  await expect.poll(() => appState(page)).toBe('InGame');
  await expect.poll(() => scenarioId(page)).toBe('starter');
  await expect(page.getByTestId('hud-menu')).toHaveCount(0);
  const goals = page.getByTestId('objectives');
  await expect(goals).toContainText('Первый город');
  await expect(goals.locator('li')).toHaveCount(2);
});

test('uiShellANewMapStartsTheSandboxWithoutAGoalsPanel', async ({ page }) => {
  await openMenu(page);
  await pick(page, 'menu-new-map', /scenario=sandbox&seed=\d+/);
  await expect.poll(() => appState(page)).toBe('InGame');
  await expect.poll(() => scenarioId(page)).toBe('sandbox');
  await expect(page.getByTestId('hud')).toBeVisible();
  await expect(page.getByTestId('objectives')).toHaveCount(0);
});

test('uiShellTheDemoCityOpensFromTheMenu', async ({ page }) => {
  await openMenu(page);
  const before = await page.evaluate(() => window.__sim.snapshot().then((s) => s.mapEditVersion));
  await pick(page, 'menu-demo-city', /demo=1/);
  await expect.poll(() => appState(page)).toBe('InGame');
  await expect.poll(() => page.evaluate(() => window.__sim.snapshot().then((s) => s.mapEditVersion))).toBeGreaterThan(before);
  await expect(page.getByTestId('hud')).toBeVisible();
  await expect(page.getByTestId('hud-menu')).toHaveCount(0);
});
