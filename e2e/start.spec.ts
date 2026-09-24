// U8: the start screen in the live app — the menu is the way into a city (start_screen.rs at rust-final), and the
// objectives panel of a catalogue preset in the city it starts. Every test first checks the screen is mounted: on a
// branch without the HUD wiring that is the one thing that fails.
import { SCENARIOS } from '../packages/bridge/src/scenarios';
import { TEST_CITY_MONEY } from '../packages/sim/src/scenarios/testCity';
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

// The demo city is `LoadTestCity` on a page of its own: its treasury and roads, and nothing to undo behind it.
test('uiShellTheDemoCityOpensFromTheMenu', async ({ page }) => {
  await openMenu(page);
  await pick(page, 'menu-demo-city', /demo=1/);
  await expect.poll(() => appState(page)).toBe('InGame');
  // The treasury starts at TEST_CITY_MONEY; the game runs, so the first upkeep may already be paid.
  const money = await page.evaluate(() => window.__sim.snapshot().then((s) => s.city.money));
  expect(money, "the demo city's treasury").toBeLessThanOrEqual(TEST_CITY_MONEY);
  expect(money, "the demo city's treasury").toBeGreaterThan(TEST_CITY_MONEY / 2);
  const roads = await page.evaluate(async () => {
    let found = 0;
    for (const y of [32, 64, 96]) for (let x = 0; x < 128; x++) if ((await window.__sim.tile(x, y))?.road.kind !== 'None') found++;
    return found;
  });
  expect(roads, 'the demo city has its streets').toBeGreaterThan(0);
  const loaded = await page.evaluate(() => window.__sim.snapshot().then((s) => s.mapEditVersion));
  await page.evaluate(() => window.__sim.undoRedo(false));
  await page.evaluate(() => window.__sim.step(2));
  expect(await page.evaluate(() => window.__sim.snapshot().then((s) => s.mapEditVersion)), 'nothing to undo').toBe(loaded);
  await expect(page.getByTestId('hud')).toBeVisible();
  await expect(page.getByTestId('hud-menu')).toHaveCount(0);
});

// Enter is not a menu choice of its own: with nothing focused it does nothing, on a button it presses that button.
test('enterOnTheMenuPressesOnlyTheFocusedButton', async ({ page }) => {
  await openMenu(page);
  const url = page.url();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  expect(await appState(page), 'no city without a choice').toBe('MainMenu');
  expect(page.url()).toBe(url);
  await expect(page.getByTestId('hud-menu')).toBeVisible();

  await page.getByTestId('menu-scenario-starter').focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(/scenario=starter/);
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await expect.poll(() => scenarioId(page)).toBe('starter');
  expect(await appState(page)).toBe('InGame');
});

// A hand-made `&seed=` the host would refuse: the page stays in the menu and says why in the console.
test('aBadSeedInTheAddressLeavesThePlayerInTheMenu', async ({ page }) => {
  const errors: string[] = [];
  const thrown: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => thrown.push(error.message));
  await openMenu(page, '?scenario=sandbox&seed=x1');
  await page.waitForTimeout(500);
  expect(await appState(page)).toBe('MainMenu');
  expect(await scenarioId(page)).toBe(null);
  expect(errors.some((text) => text.includes('seed')), errors.join('\n')).toBe(true);
  expect(thrown, 'no unhandled rejection').toEqual([]);
});
