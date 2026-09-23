// U6: the budget screen by Playwright clicks, headless (docs/design/hud/layout.md §7, states.md). The levers are
// GameCommands, so each click is checked on the worker's snapshot as well as on the screen.
import { expect, test, type Page } from '@playwright/test';
import type {} from '../packages/app/src/simApi';

async function openGame(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await page.getByTestId('start').click();
  await expect(page.getByTestId('hud')).toBeVisible();
  // At ×1 a game day is a real day: the daily economy does not run in a test, so the treasury moves only by clicks.
  expect((await page.evaluate(() => window.__sim.snapshot())).speed).toBe('X1');
}

/** `$12 085`, `-$35`, `—` as whole dollars; the dash is no amount. */
function dollars(shown: string): number {
  return shown.trim() === '—' ? 0 : Number(shown.replace(/[$\s\u00a0]/g, ''));
}

const snapshot = (page: Page) => page.evaluate(() => window.__sim.snapshot());

test('theBudgetScreenPullsItsLeversByClicks', async ({ page }) => {
  // A dozen clicks, each waiting for a stable frame of the software-rendered map.
  test.setTimeout(90_000);
  await openGame(page);
  const toggle = page.getByTestId('budget-toggle');
  await toggle.click();
  const budget = page.getByRole('dialog', { name: 'Бюджет' });
  await expect(budget).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  // A rate steps by a point.
  await budget.getByTestId('budget-tax-commercial-high-up').click();
  await expect(budget.getByTestId('budget-tax-commercial-high')).toHaveText('10 %');
  await expect.poll(() => snapshot(page).then((s) => s.taxRates.Commercial.High)).toBe(10);
  await budget.getByTestId('budget-tax-commercial-high-down').click();
  await budget.getByTestId('budget-tax-commercial-high-down').click();
  await expect(budget.getByTestId('budget-tax-commercial-high')).toHaveText('8 %');
  expect((await snapshot(page)).taxRates.Commercial.Low, 'only the one rate moves').toBe(9);

  // Funding steps by ten percent.
  await budget.getByTestId('budget-funding-police-down').click();
  await expect(budget.getByTestId('budget-funding-police')).toHaveText('90 %');
  await expect.poll(() => snapshot(page).then((s) => s.serviceFunding.Police)).toBe(90);

  // A loan puts its money in the treasury.
  const before = (await snapshot(page)).city.money;
  await budget.getByTestId('budget-loan-10000').click();
  await expect.poll(() => snapshot(page).then((s) => s.city.money)).toBe(before + 10_000);
  await expect(budget.getByText(/Заём \$10\u00a0000: \$889 в месяц, осталось 12 мес\./)).toBeVisible();
  await expect(page.getByTestId('money')).toHaveText(`$${String(before + 10_000).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`);

  // The month's lines on screen add up to the change in the treasury.
  const now = await budget.locator('[data-testid^="budget-line-"] [data-testid="budget-now"]').allTextContents();
  expect(now).toHaveLength(9);
  const net = dollars(await budget.getByTestId('budget-net').getByTestId('budget-now').textContent().then((t) => t ?? ''));
  const month = (await snapshot(page)).budget.current;
  expect(now.map(dollars).reduce((a, b) => a + b, 0)).toBe(net);
  expect(net).toBe(month.moneyEnd - month.moneyStart);
  expect(dollars(now[3]!), 'the loan is its own line').toBe(10_000);
});

test('escapeClosesTheBudgetAndHandsFocusBackToItsButton', async ({ page }) => {
  test.setTimeout(60_000);
  await openGame(page);
  await page.getByTestId('budget-toggle').click();
  const budget = page.getByRole('dialog', { name: 'Бюджет' });
  await expect(budget.getByTestId('budget-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(budget).toBeHidden();
  await expect(page.getByTestId('budget-toggle')).toBeFocused();
  await expect(page.getByTestId('budget-toggle')).toHaveAttribute('aria-pressed', 'false');
  // The Escape was the modal's: the game did not go to the menu.
  expect((await snapshot(page)).appState).not.toBe('MainMenu');
});

// Stopping the clock is when a player sets the budget: the lever's change must reach the screen without a tick.
test('leversShowWhilePaused', async ({ page }) => {
  test.setTimeout(60_000);
  await openGame(page);
  await page.getByRole('navigation', { name: 'Скорость' }).getByRole('button', { name: 'Стоп', exact: true }).click();
  await expect.poll(() => snapshot(page).then((s) => s.speed)).toBe('Paused');
  const before = (await snapshot(page)).city.money;
  await page.getByTestId('budget-toggle').click();
  const budget = page.getByRole('dialog', { name: 'Бюджет' });
  await budget.getByTestId('budget-funding-fire-up').click();
  await budget.getByTestId('budget-loan-10000').click();
  await expect(budget.getByTestId('budget-funding-fire')).toHaveText('110 %');
  await expect(budget.getByTestId('budget-treasury')).toHaveText(`Казна $${String(before + 10_000).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}`);
});
