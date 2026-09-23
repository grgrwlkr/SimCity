// U2: the tool palette and the map brush with Playwright's own mouse and keyboard — a stroke sends world commands,
// the hotkeys stand down in a text field, Ctrl+Z undoes, a click on the HUD never paints.
import { expect, test, type Page } from '@playwright/test';
import { GRID_LAYER_NAMES } from '../packages/bridge/src/protocol';
import type {} from '../packages/app/src/simApi';
import type { MapCell, TilePos } from '../packages/sim/src/index';

/** The test city's size: a map of plain dry land, nothing built. */
const SIZE = 128;
/** CSS pixels a tile spans once the camera is set. */
const TILE_PX = 32;

async function openBlankCity(page: Page): Promise<void> {
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
  // The brush picks tiles through the camera: wait for the map, then look at its middle up close.
  await expect.poll(() => page.evaluate(() => window.__sim.pickTile(640, 300))).not.toBeNull();
  await page.evaluate((px) => window.__sim.fitMap().then((c) => window.__sim.setCamera({ worldPerPixel: 16 / px, centerX: c.centerX, centerY: c.centerY })), TILE_PX);
}

const tileAt = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => window.__sim.pickTile(px!, py!), [x, y]);

/** The cell once the commands sent so far are applied: they go in with the next tick. */
async function cellAfterTick(page: Page, tile: TilePos): Promise<MapCell> {
  return (await page.evaluate(async (t) => {
    await window.__sim.step(1);
    return window.__sim.tile(t.x, t.y);
  }, tile))!;
}

async function stroke(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

// Every pointer move over the canvas waits for a frame drawn on the processor: slow under a loaded machine.
test.describe.configure({ timeout: 90_000 });

const palette = (page: Page) => page.getByRole('toolbar', { name: 'Инструменты' });
const toolButton = (page: Page, name: string) => palette(page).getByRole('button', { name: new RegExp(`^${name}`) });

test('aButtonAndAHotkeyPickTheTool', async ({ page }) => {
  await openBlankCity(page);
  await expect(toolButton(page, 'Осмотр')).toHaveAttribute('aria-pressed', 'true');
  await toolButton(page, 'Жилая').click();
  await expect(toolButton(page, 'Жилая')).toHaveAttribute('aria-pressed', 'true');
  await expect(palette(page).getByRole('button', { pressed: true })).toHaveCount(2); // the tool and the density
  await page.keyboard.press('Digit1');
  await expect(toolButton(page, '2 полосы')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Digit1');
  await expect(toolButton(page, '4 полосы')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Digit5');
  await expect(toolButton(page, 'Снос')).toHaveAttribute('aria-pressed', 'true');
  await expect(toolButton(page, 'Жилая')).toHaveAttribute('aria-pressed', 'false');
});

test('aRoadStrokeLaysRoadAndCtrlZUndoesIt', async ({ page }) => {
  await openBlankCity(page);
  await toolButton(page, '2 полосы').click();
  const start = (await tileAt(page, 500, 300))!;
  const end = (await tileAt(page, 500 + 6 * TILE_PX, 300))!;
  expect(end.y).toBe(start.y);
  expect(end.x - start.x).toBeGreaterThanOrEqual(5);
  expect((await cellAfterTick(page, start)).road.kind).toBe('None');
  await stroke(page, { x: 500, y: 300 }, { x: 500 + 6 * TILE_PX, y: 300 });
  for (const tile of [start, end, { x: (start.x + end.x) >> 1, y: start.y }]) expect((await cellAfterTick(page, tile)).road.kind, `${tile.x},${tile.y}`).toBe('TwoLane');

  // One Ctrl+Z takes back one edit of the history, as in Rust: the last `SetRoad` of the stroke, the far lane of its end.
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await cellAfterTick(page, end)).road.kind).toBe('None');
  expect((await cellAfterTick(page, { x: end.x, y: end.y - 1 })).road.kind, 'the other lane is an edit of its own').toBe('TwoLane');
  expect((await cellAfterTick(page, start)).road.kind).toBe('TwoLane');
  await page.keyboard.press('Control+y');
  await expect.poll(async () => (await cellAfterTick(page, end)).road.kind).toBe('TwoLane');
});

test('aZoneIsPaintedWithTheChosenDensity', async ({ page }) => {
  await openBlankCity(page);
  await toolButton(page, '2 полосы').click();
  await stroke(page, { x: 450, y: 300 }, { x: 450 + 8 * TILE_PX, y: 300 });
  await toolButton(page, 'Высокая').click();
  await toolButton(page, 'Жилая').click();
  await expect(toolButton(page, 'Высокая')).toHaveAttribute('aria-pressed', 'true');
  // Two tiles below the road: zoning needs a road within three.
  const y = 300 + 2 * TILE_PX;
  await stroke(page, { x: 500, y }, { x: 500 + 3 * TILE_PX, y });
  for (const x of [500, 500 + 3 * TILE_PX]) {
    const cell = await cellAfterTick(page, (await tileAt(page, x, y))!);
    expect(cell.zone).toBe('Residential');
    expect(cell.density).toBe('High');
  }
});

test('oneWayIsSwitchedOnByTheToggleAndTheHotkey', async ({ page }) => {
  await openBlankCity(page);
  await toolButton(page, '2 полосы').click();
  await palette(page).getByTestId('tool-one-way').click();
  await expect(palette(page).getByTestId('tool-one-way')).toHaveAttribute('aria-pressed', 'true');
  await expect(toolButton(page, '2 полосы'), 'one-way is a modifier, not a tool').toHaveAttribute('aria-pressed', 'true');
  await stroke(page, { x: 500, y: 260 }, { x: 500 + 4 * TILE_PX, y: 260 });
  const oneWay = await cellAfterTick(page, (await tileAt(page, 500, 260))!);
  expect(oneWay.road.flow).toEqual({ kind: 'OneWay', dir: 'East' });

  await page.keyboard.press('KeyO');
  await expect(palette(page).getByTestId('tool-one-way')).toHaveAttribute('aria-pressed', 'false');
  await stroke(page, { x: 500, y: 420 }, { x: 500 + 4 * TILE_PX, y: 420 });
  expect((await cellAfterTick(page, (await tileAt(page, 500, 420))!)).road.flow).toEqual({ kind: 'TwoWay' });
});

test('aToolAMilestoneKeepsClosedIsDisabledAndSaysWhenItOpens', async ({ page }) => {
  await openBlankCity(page);
  expect((await page.evaluate(() => window.__sim.snapshot())).milestones.bestPopulation).toBeLessThan(250);
  const school = toolButton(page, 'Школа');
  await expect(school).toHaveAttribute('aria-disabled', 'true');
  await expect(school).toContainText('Откроется при 250 жителях');
  await expect(school).toHaveAttribute('title', 'Откроется при 250 жителях');
  // `aria-disabled`, not `disabled`: the button stays in the Tab order (states.md). Playwright waits for neither, so the
  // player's click is forced.
  expect(await school.evaluate((b) => b.hasAttribute('disabled'))).toBe(false);
  await school.click({ force: true });
  await expect(school).toHaveAttribute('aria-pressed', 'false');
  await expect(toolButton(page, 'Осмотр')).toHaveAttribute('aria-pressed', 'true');
  await expect(toolButton(page, 'Парк'), 'a park is open from the start').not.toHaveAttribute('aria-disabled', 'true');
});

test('typingIntoAFieldDoesNotSwitchTheTool', async ({ page }) => {
  await openBlankCity(page);
  await toolButton(page, '2 полосы').click();
  await stroke(page, { x: 500, y: 300 }, { x: 500 + 3 * TILE_PX, y: 300 });
  const laid = (await tileAt(page, 500, 300))!;
  expect((await cellAfterTick(page, laid)).road.kind).toBe('TwoLane');

  // The HUD has no text field yet (the seed box of Rust is a dev element): the check brings its own.
  await page.evaluate(() => {
    const field = document.createElement('input');
    field.id = 'probe';
    field.style.cssText = 'position:fixed;top:120px;left:20px;z-index:100';
    document.body.append(field);
  });
  await page.locator('#probe').click();
  await page.keyboard.type('25o');
  await expect(page.locator('#probe')).toHaveValue('25o');
  await page.keyboard.press('Control+z');
  await expect(toolButton(page, '2 полосы'), 'typing into a text field must not switch the active tool').toHaveAttribute('aria-pressed', 'true');
  await expect(palette(page).getByTestId('tool-one-way')).toHaveAttribute('aria-pressed', 'false');
  expect((await cellAfterTick(page, laid)).road.kind, 'Ctrl+Z in a field belongs to the field').toBe('TwoLane');
});

test('aClickOnTheHudDoesNotPaintTheMap', async ({ page }) => {
  await openBlankCity(page);
  await toolButton(page, '2 полосы').click();
  // The palette and the bar sit over the map: a click on either stays on the panel.
  for (const target of [toolButton(page, '2 полосы'), page.getByTestId('money')]) {
    const box = (await target.boundingBox())!;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const under = await tileAt(page, at.x, at.y);
    expect(under, 'the panel stands over the map').not.toBeNull();
    await stroke(page, at, { x: at.x + 3, y: at.y });
    expect((await cellAfterTick(page, under!)).road.kind).toBe('None');
  }
  await expect(toolButton(page, '2 полосы')).toHaveAttribute('aria-pressed', 'true');
  // The map beside them is the brush's.
  await stroke(page, { x: 640, y: 360 }, { x: 640, y: 360 });
  expect((await cellAfterTick(page, (await tileAt(page, 640, 360))!)).road.kind).toBe('TwoLane');
});
