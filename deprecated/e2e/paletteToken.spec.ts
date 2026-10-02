// The palette's height token in a running game (debt w6 u7, advisorPanel.css): ToolPalette.tsx measures the palette with
// a ResizeObserver and sets --hud-palette-height, and the advisor's panel stops above the palette at that height. The
// window is resized in place, so the token must follow the groups wrapping into more rows and back without a reload.
import { expect, test, type Page } from '@playwright/test';
import type {} from '../packages/app/src/simApi';

// Opening the game alone takes 25 s under a loaded machine (advisor.spec.ts).
test.describe.configure({ timeout: 120_000 });

/** The palette's rows, its height and top, the token, and where the advisor's panel would end at its max height. */
const measure = (page: Page) =>
  page.evaluate(() => {
    const palette = document.querySelector('.hud-tools-panel')!.getBoundingClientRect();
    const advisor = document.querySelector<HTMLElement>('[data-testid="advisor"]')!;
    return {
      rows: new Set([...document.querySelectorAll('.hud-tools-group')].map((g) => Math.round(g.getBoundingClientRect().top))).size,
      paletteHeight: palette.height,
      paletteTop: palette.top,
      token: getComputedStyle(document.documentElement).getPropertyValue('--hud-palette-height').trim(),
      advisorMaxBottom: advisor.getBoundingClientRect().top + parseFloat(getComputedStyle(advisor).maxHeight),
    };
  });

test('thePaletteHeightTokenFollowsItsRowsAndTheAdvisorClearsThePalette', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await page.evaluate(() => window.__sim.setState('InGame'));
  await expect(page.getByTestId('hud')).toBeVisible();
  await page.getByTestId('advisor-toggle').click();
  await expect(page.getByTestId('advisor')).toBeVisible();

  const rows = new Set<number>();
  for (const [width, height] of [
    [1600, 900],
    [1280, 800],
    [1000, 800],
    [2400, 900],
    [1280, 720],
  ] as const) {
    await page.setViewportSize({ width, height });
    // The observer reports after layout: poll until the token matches the palette on screen.
    await expect
      .poll(async () => {
        const m = await measure(page);
        return m.token === `${m.paletteHeight}px`;
      }, { message: `the token follows the palette at ${width}×${height}` })
      .toBe(true);
    const m = await measure(page);
    rows.add(m.rows);
    expect(m.advisorMaxBottom, `the advisor at its tallest ends 8 px above the palette at ${width}×${height}: ${JSON.stringify(m)}`).toBeLessThanOrEqual(m.paletteTop - 8);
  }
  expect([...rows].sort(), 'the sizes cover one, two and three rows').toEqual([1, 2, 3]);
});
