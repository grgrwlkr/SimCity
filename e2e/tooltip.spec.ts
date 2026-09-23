// U3 tile tooltip in Chromium with Playwright's own mouse: beside the cursor it says what the tool in hand would do
// and what it costs, lets the pointer through, stands down over the HUD and for Inspect, and under Inspect names why a
// zoned tile does not grow. The words of the preview and the diagnosis are the sim's; only the tooltip's own are pinned.
// Needs TileTooltipLive mounted in the HUD and the `tilePreview` request wired (Hud.tsx, main.tsx, styles.css,
// ui index.ts, protocol.ts, host.ts: the integrator's lines from the dev-tooltip handoff); before that the first check
// fails as "not mounted".
import { expect, test, type Page } from '@playwright/test';
import { GRID_LAYER_NAMES } from '../packages/bridge/src/protocol';
import type {} from '../packages/app/src/simApi';
import type { MapCell, TilePos } from '../packages/sim/src/index';

const NOT_MOUNTED = 'TileTooltip is not mounted in the HUD: wired by the integrator (Hud.tsx, main.tsx, styles.css, ui index.ts, protocol.ts, host.ts)';
/** A map of plain dry land, nothing built. */
const SIZE = 128;
/** CSS pixels a tile spans once the camera is set. */
const TILE_PX = 32;
/** A point over the map, clear of every panel. */
const MAP_POINT = { x: 640, y: 420 } as const;

test.use({ viewport: { width: 1280, height: 800 } });
// Every pointer move over the canvas waits for a frame drawn on the processor: slow under a loaded machine.
test.describe.configure({ timeout: 90_000 });

async function openBlankCity(page: Page): Promise<void> {
  page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await page.getByTestId('start').click();
  await expect(page.getByTestId('hud')).toBeVisible();
  const blank = Object.fromEntries(GRID_LAYER_NAMES.map((name) => [name, '00'.repeat(SIZE * SIZE)]));
  await page.evaluate(async (layers) => {
    await window.__sim.setSpeed('Paused');
    await window.__sim.loadGridHex(layers as never);
    await window.__sim.step(1);
  }, blank);
  await expect.poll(() => page.evaluate(() => window.__sim.pickTile(640, 300))).not.toBeNull();
  await page.evaluate((px) => window.__sim.fitMap().then((c) => window.__sim.setCamera({ worldPerPixel: 16 / px, centerX: c.centerX, centerY: c.centerY })), TILE_PX);
}

const palette = (page: Page) => page.getByRole('toolbar', { name: 'Инструменты' });
const toolButton = (page: Page, name: string) => palette(page).getByRole('button', { name: new RegExp(`^${name}`) });
const tooltip = (page: Page) => page.getByTestId('tile-tooltip');

/** The cell once the commands sent so far are applied: they go in with the next tick. */
async function cellAfterTick(page: Page, tile: TilePos): Promise<MapCell> {
  return (await page.evaluate(async (t) => {
    await window.__sim.step(1);
    return window.__sim.tile(t.x, t.y);
  }, tile))!;
}

test('theTooltipSaysPriceAndEffectBesideTheCursorAndLetsThePointerThrough', async ({ page }) => {
  await openBlankCity(page);
  await toolButton(page, '2 полосы').click();
  await page.mouse.move(MAP_POINT.x, MAP_POINT.y, { steps: 4 });
  await expect(tooltip(page), NOT_MOUNTED).toBeVisible({ timeout: 30_000 });

  // «эффект, $N»: a road on bare land has a price, and nothing refuses it, so there is no red line.
  await expect(page.getByTestId('tile-tooltip-headline')).toHaveText(/, \$\d/);
  await expect(page.locator('[data-testid="tile-tooltip-detail"].is-refusal')).toHaveCount(0);

  // Beside the cursor: x + 16, y + 16 (layout.md §4).
  const box = (await tooltip(page).boundingBox())!;
  expect(Math.abs(box.x - (MAP_POINT.x + 16)), `left ${box.x}`).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y - (MAP_POINT.y + 16)), `top ${box.y}`).toBeLessThanOrEqual(1);
  expect(box.width).toBeLessThanOrEqual(320);
  // For the eye: the cursor's corner and the panel beside it.
  await page.screenshot({ path: test.info().outputPath('tooltip.png'), clip: { x: MAP_POINT.x - 40, y: MAP_POINT.y - 40, width: box.width + 120, height: box.height + 100 } });

  // It never catches the pointer: the point under it is still the map's.
  const through = await page.evaluate(
    ({ x, y }) => {
      const tip = document.querySelector('[data-testid="tile-tooltip"]')!;
      const nodes = [tip, ...tip.querySelectorAll('*')];
      return { styles: nodes.map((n) => getComputedStyle(n).pointerEvents), under: document.elementFromPoint(x, y)?.id ?? null };
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  expect(new Set(through.styles)).toEqual(new Set(['none']));
  expect(through.under, 'the map is under the tooltip').toBe('view');

  // The click it explains goes through: the road is laid where the cursor is.
  const tile = (await page.evaluate(({ x, y }) => window.__sim.pickTile(x, y), MAP_POINT))!;
  await page.mouse.down();
  await page.mouse.up();
  expect((await cellAfterTick(page, tile)).road.kind).toBe('TwoLane');
  // The same road again is free (preview.ts: a road already of this kind costs nothing).
  await page.mouse.move(MAP_POINT.x + 1, MAP_POINT.y, { steps: 2 });
  await expect(page.getByTestId('tile-tooltip-headline')).toHaveText(/, бесплатно$/);
});

test('theTooltipStandsDownOverTheHudAndForInspect', async ({ page }) => {
  await openBlankCity(page);
  await toolButton(page, '2 полосы').click();
  await page.mouse.move(MAP_POINT.x, MAP_POINT.y, { steps: 4 });
  await expect(tooltip(page), NOT_MOUNTED).toBeVisible({ timeout: 30_000 });

  // Over a panel the click is the panel's.
  const money = (await page.getByTestId('money').boundingBox())!;
  await page.mouse.move(money.x + money.width / 2, money.y + money.height / 2, { steps: 4 });
  await expect(tooltip(page)).toHaveCount(0);
  await page.mouse.move(MAP_POINT.x, MAP_POINT.y, { steps: 4 });
  await expect(tooltip(page)).toBeVisible();

  // Near the right and bottom edges it turns to the other side of the cursor instead of leaving the window.
  await page.mouse.move(1270, 790, { steps: 4 });
  await expect(tooltip(page)).toBeVisible();
  const turned = (await tooltip(page).boundingBox())!;
  expect(turned.x + turned.width).toBeLessThanOrEqual(1270 - 16 + 1);
  expect(turned.y + turned.height).toBeLessThanOrEqual(790 - 16 + 1);

  // Inspect edits nothing, so a plain tile has no price to show.
  await toolButton(page, 'Осмотр').click();
  await page.mouse.move(MAP_POINT.x, MAP_POINT.y, { steps: 4 });
  await expect(toolButton(page, 'Осмотр')).toHaveAttribute('aria-pressed', 'true');
  await expect(tooltip(page)).toHaveCount(0);
});

test('underInspectAZonedTileThatDoesNotGrowSaysWhy', async ({ page }) => {
  await openBlankCity(page);
  // A road across the view and a residential tile two rows below it: zoned, within reach, and no power anywhere.
  await toolButton(page, '2 полосы').click();
  await page.mouse.move(MAP_POINT.x - 3 * TILE_PX, MAP_POINT.y);
  await page.mouse.down();
  await page.mouse.move(MAP_POINT.x + 3 * TILE_PX, MAP_POINT.y, { steps: 8 });
  await page.mouse.up();
  const zoned = { x: MAP_POINT.x, y: MAP_POINT.y + 2 * TILE_PX };
  await toolButton(page, 'Жилая').click();
  await page.mouse.click(zoned.x, zoned.y);
  const tile = (await page.evaluate(({ x, y }) => window.__sim.pickTile(x, y), zoned))!;
  expect((await cellAfterTick(page, tile)).zone).toBe('Residential');

  await toolButton(page, 'Осмотр').click();
  await page.mouse.move(zoned.x, zoned.y, { steps: 4 });
  await expect(tooltip(page), NOT_MOUNTED).toBeVisible({ timeout: 30_000 });
  // The zone on the first line, the reason on the second, read in the refusal colour (states.md: «вторая строка причины»).
  await expect(page.getByTestId('tile-tooltip-headline')).not.toBeEmpty();
  const detail = page.getByTestId('tile-tooltip-detail');
  await expect(detail).toHaveClass(/is-refusal/);
  await expect(detail).not.toBeEmpty();
  const tip = (await tooltip(page).boundingBox())!;
  await page.screenshot({ path: test.info().outputPath('refusal.png'), clip: { x: zoned.x - 40, y: zoned.y - 40, width: tip.width + 120, height: tip.height + 100 } });
  const [red, negative] = await detail.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(document.documentElement).getPropertyValue('--hud-negative').trim()]);
  expect(red).toBe('rgb(255, 115, 107)');
  expect(negative).toBe('#ff736b');
});
