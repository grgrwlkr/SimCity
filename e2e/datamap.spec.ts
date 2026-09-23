// U4 data maps in Chromium: a map picked in the panel paints the tile under the cursor in its legend's colour, read back
// from a screenshot of the debug renderer (its colours reach the screen unmanaged), and the panel reads that tile's
// value as a number. In the scene the same pick lights the frame at noon and drops the vignette.
// Needs DataMapPanel mounted in the HUD and the `dataMap` request wired (Hud.tsx, main.tsx, protocol.ts, host.ts: the
// integrator's lines from the dev-datamap handoff); before that the first check fails as "not mounted".
import { expect, test, type Page } from '@playwright/test';
import type { SceneStats } from '../packages/render/src/scene/sceneRenderer';

test.use({ viewport: { width: 1100, height: 1100 } });
test.describe.configure({ timeout: 240_000 });

/** `NOON_SUN_INTENSITY` of packages/render/src/scene/lighting.ts; that module pulls three.js into the runner. */
const NOON_SUN_INTENSITY = 3;
const NOT_MOUNTED = 'DataMapPanel is not mounted in the HUD: wired by the integrator (Hud.tsx, main.tsx, protocol.ts, host.ts)';

/** The panel starts collapsed to its header (left column, layout.md §5): a click on the header opens the maps. */
async function expandDataMaps(page: Page): Promise<void> {
  const toggle = page.getByTestId('datamap-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

async function openCity(page: Page, query = ''): Promise<void> {
  page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
  await page.goto(`/?scenario=city${query}`);
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await expect(page.getByTestId('datamap'), NOT_MOUNTED).toBeVisible({ timeout: 60_000 });
  await expandDataMaps(page);
  // Held still, with the indexes computed over the whole map: land value publishes a chunk a tick.
  await page.evaluate(async () => {
    await window.__sim.setSpeed('Paused');
    await window.__sim.step(400);
  });
}

/** The canvas pixel at a CSS point, from a real screenshot taken after the renderer drew two more frames. */
async function pixelAt(page: Page, p: { x: number; y: number }): Promise<[number, number, number]> {
  const frames = (await page.evaluate(() => window.__sim.renderStats())).frames;
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.frames), { timeout: 30_000 }).toBeGreaterThan(frames + 2);
  const png = await page.locator('#view').screenshot();
  return page.evaluate(
    async ({ b64, p }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const scale = bitmap.width / document.getElementById('view')!.clientWidth;
      const d = ctx.getImageData(Math.floor(p.x * scale), Math.floor(p.y * scale), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!] as [number, number, number];
    },
    { b64: png.toString('base64'), p },
  );
}

test('a data map paints the tile in its legend colour and reads its value as a number', async ({ page }, testInfo) => {
  await openCity(page);
  // A point clear of the panels, over a tile of the city.
  const cam = await page.evaluate(() => window.__sim.camera());
  const box = (await page.locator('#view').boundingBox())!;
  const point = { x: Math.round(cam.width * 0.6), y: Math.round(cam.height * 0.62) };
  expect(await page.evaluate((p) => window.__sim.pickTile(p.x, p.y), point), 'the point is on the map').not.toBeNull();
  const plain = await pixelAt(page, point);

  await page.getByTestId('overlay-LandValue').click();
  await expect(page.getByTestId('overlay-LandValue')).toHaveAttribute('aria-pressed', 'true');
  // The legend on screen: nine stops sampled evenly from low (red) through yellow to high (green).
  const stops = await page
    .locator('.datamap-stop')
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number)));
  expect(stops).toHaveLength(9);
  expect([stops[0], stops[4], stops[8]]).toEqual([
    [255, 0, 0],
    [255, 255, 0],
    [0, 255, 0],
  ]);

  // The value under the cursor, as a number.
  await page.mouse.move(box.x + point.x, box.y + point.y);
  const reading = page.getByTestId('datamap-reading');
  await expect(reading).toHaveText(/^Стоимость земли: \d{1,3}\s%$/, { timeout: 30_000 });
  const percent = Number(/(\d{1,3})\s%/.exec((await reading.textContent())!)![1]);
  expect(percent).toBeGreaterThanOrEqual(0);
  expect(percent).toBeLessThanOrEqual(100);

  // That tile is drawn in the legend's colour for that value, read off the legend between its two nearest stops (the
  // scale is linear between stops); the reading rounds to a percent, which is two bytes at most.
  const k = (percent / 100) * (stops.length - 1);
  const [lo, hi] = [stops[Math.floor(k)]!, stops[Math.ceil(k)]!];
  const expected = lo.map((c, i) => c + (hi[i]! - c) * (k - Math.floor(k)));
  const painted = await pixelAt(page, point);
  await page.locator('#view').screenshot({ path: testInfo.outputPath('land-value.png') });
  painted.forEach((c, i) => expect(Math.abs(c - expected[i]!), `channel ${i}: painted ${painted} vs legend ${expected}`).toBeLessThanOrEqual(3));
  expect(painted, 'the map changed colour').not.toEqual(plain);

  // Off again: the plain map, no legend, no reading.
  await page.getByTestId('overlay-None').click();
  await expect(page.getByTestId('datamap-legend')).toHaveCount(0);
  await expect(reading).toHaveCount(0);
  expect(await pixelAt(page, point)).toEqual(plain);
});

test('while a data map is open the scene is lit at noon and drawn without the vignette', async ({ page }) => {
  // Midnight pinned, the vignette kept: the two things a data map sets aside. AO, FXAA and the grade are off for speed.
  await openCity(page, '&renderer=scene&hour=0&off=ao,fxaa,grade');
  const stats = () => page.evaluate(() => window.__sim.renderStats()) as Promise<SceneStats>;
  await expect.poll(() => stats().then((s) => s.frames), { timeout: 120_000 }).toBeGreaterThan(1);
  const night = await stats();
  expect(night.vignette, 'the plain map at night has its vignette').toBe(true);
  expect(night.sunIntensity).toBeLessThan(NOON_SUN_INTENSITY / 2);

  await page.getByTestId('overlay-Pollution').click();
  await expect.poll(() => stats().then((s) => [s.dataMap, s.vignette, s.sunIntensity]), { timeout: 120_000 }).toEqual(['Pollution', false, NOON_SUN_INTENSITY]);
  expect((await stats()).hour, 'the clock is still midnight: only the light changed').toBe(0);

  await page.getByTestId('overlay-None').click();
  await expect.poll(() => stats().then((s) => [s.dataMap, s.vignette, s.sunIntensity < NOON_SUN_INTENSITY / 2]), { timeout: 120_000 }).toEqual(['None', true, true]);
});

test.describe('the left column at the desktop window size', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the data maps and the advisor share the left column one at a time', async ({ page }) => {
    await page.goto('/?scenario=city');
    await page.waitForFunction(() => typeof window.__sim !== 'undefined');
    await page.evaluate(() => window.__sim.ready);
    const panel = page.getByTestId('datamap');
    const toggle = page.getByTestId('datamap-toggle');
    await expect(panel, NOT_MOUNTED).toBeVisible({ timeout: 60_000 });

    // Collapsed by default, 260 px wide and short enough to clear the advisor at top 352 (layout.md §5, §8).
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('overlay-LandValue')).toHaveCount(0);
    const collapsed = (await panel.boundingBox())!;
    expect(collapsed.width).toBe(260);
    expect(collapsed.height, 'a collapsed panel leaves room for the advisor').toBeLessThanOrEqual(280);
    expect(collapsed.y + collapsed.height).toBeLessThanOrEqual(352);

    // A picked map stays painted and named in the header once the panel folds.
    await expandDataMaps(page);
    await page.getByTestId('overlay-LandValue').click();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveText(/Карты данных\s*Стоимость земли/);
    await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.dataMap)).toBe('LandValue');

    // Opening the advisor folds the data maps; unfolding them closes the advisor (states.md «Левая колонка»).
    await expandDataMaps(page);
    await page.getByTestId('advisor-toggle').click();
    await expect(page.getByTestId('advisor')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.getByTestId('advisor').hover();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('advisor')).toHaveCount(0);
  });
});
