// Stage 1½: the debug renderer in Chromium and WebKit. The gate reads the class of every tile back
// from a screenshot of the Rust test city and compares it with the Rust grid and the Rust frame.
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import type { CameraState } from '../packages/app/src/simApi';
import { CLASS_COLORS, VEHICLE_COLORS, layoutClass, tileClass, type LayoutClass, type TileClass } from '../packages/render/src/palette';
import { tileToWorld } from '../packages/sim/src/index';
const readJson = <T,>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const road = readJson<RoadFixture>('../packages/sim/test/fixtures/road-routes.json');
const laneletFixture = readJson<{ lanelets: unknown[] }>('../packages/sim/test/fixtures/lanelet-routes.json');

interface RoadFixture {
  width: number;
  height: number;
  rawGrid: Record<'height' | 'water' | 'terrain' | 'roadKind' | 'roadDir' | 'roadLane' | 'roadFlow' | 'laneType' | 'zone' | 'density' | 'building', string>;
}

const RUST_LAYOUT = new URL('./fixtures/rust-layout.json', import.meta.url);
const CFG = { width: road.width, height: road.height, tileSize: 16 };

test.use({ viewport: { width: 1100, height: 1100 } });

function hexToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Layout class of every tile straight from the Rust grid, row by row from y = 0. */
function gridLayout(): LayoutClass[] {
  const l = road.rawGrid;
  const map = {
    width: road.width,
    height: road.height,
    tileSize: 16,
    mapEditVersion: 0,
    graphVersion: 0,
    layers: {
      water: hexToBytes(l.water),
      roadKind: hexToBytes(l.roadKind),
      roadDir: hexToBytes(l.roadDir),
      zone: hexToBytes(l.zone),
      building: hexToBytes(l.building),
    },
  };
  return Array.from({ length: road.width * road.height }, (_, i) => layoutClass(tileClass(map, i)));
}

async function openApp(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await page.evaluate(async () => {
    await window.__sim.setSpeed('Paused');
    await window.__sim.setState('InGame');
    await window.__sim.step(1);
  });
  // The HUD sits over the canvas; the picture and the pointer are what is under test.
  await page.addStyleTag({ content: '#root { visibility: hidden; }' });
}

async function loadTestCity(page: Page): Promise<void> {
  const { height, ...rest } = road.rawGrid;
  await page.evaluate(async (layers) => {
    await window.__sim.loadGridHex(layers);
    await window.__sim.step(1);
  }, { elevation: height, ...rest });
}

/** Resolves once the renderer has drawn the current map at least one frame after `since`. */
async function waitForDrawn(page: Page, since = 0): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async (after) => {
        const [s, r] = await Promise.all([window.__sim.snapshot(), window.__sim.renderStats()]);
        return r.mapEditVersion === s.mapEditVersion && r.frames > after;
      }, since),
    )
    .toBe(true);
}

/** Screen point of a world position under the view contract: north up, east right, CSS pixels. */
function toScreen(cam: CameraState, x: number, y: number): { x: number; y: number } {
  return { x: cam.width / 2 + (x - cam.centerX) / cam.worldPerPixel, y: cam.height / 2 - (y - cam.centerY) / cam.worldPerPixel };
}

/** Classes of the canvas pixels at CSS points, read from a real screenshot (kept at `savePath` when given). */
async function sampleCanvas(page: Page, points: Array<{ x: number; y: number }>, savePath?: string): Promise<TileClass[]> {
  const frames = (await page.evaluate(() => window.__sim.renderStats())).frames;
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.frames)).toBeGreaterThan(frames + 1);
  const png = await page.locator('#view').screenshot(savePath === undefined ? {} : { path: savePath });
  return page.evaluate(
    async ({ b64, points, colors }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      const scale = bitmap.width / document.getElementById('view')!.clientWidth;
      const entries = Object.entries(colors);
      return points.map((p) => {
        const px = Math.floor(p.x * scale);
        const py = Math.floor(p.y * scale);
        const o = (py * bitmap.width + px) * 4;
        let best = entries[0]![0];
        let bestD = Infinity;
        for (const [name, [r, g, b]] of entries) {
          const d = (data[o]! - r) ** 2 + (data[o + 1]! - g) ** 2 + (data[o + 2]! - b) ** 2;
          if (d < bestD) {
            bestD = d;
            best = name;
          }
        }
        return best;
      });
    },
    { b64: png.toString('base64'), points, colors: { ...CLASS_COLORS, ...Object.fromEntries(VEHICLE_COLORS.map((c, i) => [`vehicle${i}`, c])) } },
  ) as Promise<TileClass[]>;
}

test('debugRenderMatchesRustLayout', async ({ page }, testInfo) => {
  await openApp(page);
  await loadTestCity(page);
  const cam = await page.evaluate(() => window.__sim.fitMap());
  await waitForDrawn(page);

  const points: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < CFG.height; y++) {
    for (let x = 0; x < CFG.width; x++) {
      const w = tileToWorld(CFG, { x, y });
      points.push(toScreen(cam, w.x, w.y));
    }
  }
  const drawn = (await sampleCanvas(page, points, testInfo.outputPath('test-city.png'))).map((c) => layoutClass(c));
  const expected = gridLayout();
  const mismatches = drawn.flatMap((c, i) => (c === expected[i] ? [] : [`(${i % CFG.width},${Math.floor(i / CFG.width)}) ${c}≠${expected[i]}`]));
  expect(mismatches.slice(0, 10), `${mismatches.length} tiles differ from the Rust grid`).toEqual([]);

  expect(existsSync(RUST_LAYOUT), 'e2e/fixtures/rust-layout.json comes from tools/rust-layout.ts').toBe(true);
  const rust = JSON.parse(readFileSync(RUST_LAYOUT, 'utf8')) as { classes: string };
  const legend: Record<string, LayoutClass> = { r: 'road', w: 'water', o: 'other' };
  let known = 0;
  let agree = 0;
  for (let i = 0; i < drawn.length; i++) {
    const c = legend[rust.classes[i]!];
    if (c === undefined) continue;
    known += 1;
    if (c === drawn[i]) agree += 1;
  }
  expect(known, 'most tiles are readable in the Rust frame').toBeGreaterThan(drawn.length * 0.8);
  expect(agree / known, `${agree} of ${known} readable tiles agree with the Rust frame`).toBeGreaterThanOrEqual(0.98);
});

test('vehiclesDrawAsCubes', async ({ page }) => {
  await openApp(page);
  await waitForDrawn(page);
  const cam = await page.evaluate(() => window.__sim.setCamera({ centerX: 0, centerY: 0, worldPerPixel: 0.25 }));
  const placed = [
    { x: 0, y: 0, heading: 0, kind: 0 },
    { x: 60, y: 0, heading: 1.2, kind: 1 },
    { x: 0, y: -60, heading: 2.4, kind: 2 },
  ];
  await page.evaluate((vehicles) => window.__sim.debugVehicles(vehicles), placed);
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.vehicles)).toBe(3);

  const classes = await sampleCanvas(page, placed.map((v) => toScreen(cam, v.x, v.y)));
  expect(classes).toEqual(['vehicle0', 'vehicle1', 'vehicle2']);
});

test('signalizedScenarioShowsTrafficLive', async ({ page }, testInfo) => {
  await page.goto('/?scenario=signalized');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);

  await expect
    .poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => ({ driving: s.vehicles > 0, lamps: s.lights })))
    .toEqual({ driving: true, lamps: 4 });
  const cam = await page.evaluate(() => window.__sim.camera());
  const box = tileToWorld(CFG, { x: 40, y: 40 });
  expect(Math.abs(cam.centerX - (box.x + 8)) + Math.abs(cam.centerY - (box.y + 8)), 'the camera looks at the box').toBeLessThan(16);

  // Real time at ×1: the frame keeps moving without any manual stepping.
  const first = await page.evaluate(() => window.__sim.renderFrame());
  await expect.poll(() => page.evaluate(() => window.__sim.renderFrame()).then((f) => f.tick)).toBeGreaterThan(first.tick + 5);
  await page.locator('#view').screenshot({ path: testInfo.outputPath('signalized.png') });
});

// Stage 2c live: commuters drive their own cars across the generated city and its nine lit crossings.
test('cityScenarioDrivesCommutersLive', async ({ page }, testInfo) => {
  await page.goto('/?scenario=city');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);

  await expect
    .poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => ({ driving: s.vehicles > 20, lamps: s.lights })), { timeout: 30_000 })
    .toEqual({ driving: true, lamps: 36 });
  await page.locator('#view').screenshot({ path: testInfo.outputPath('city.png') });
});

test('hudShowsCityStats', async ({ page }) => {
  await page.goto('/?scenario=city');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);

  await expect(page.getByTestId('citizens')).toHaveText(/^Жители 2\s000$/, { timeout: 30_000 });
  await expect
    .poll(async () => Number((await page.getByTestId('driving').textContent())?.replace(/\D/g, '')), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expect(page.getByTestId('sim-tick')).toHaveText(/^сим \d+(,\d)? мс$/);
});

// ПДД 6.3: the protected left is a green arrow beside a red main signal, on both approaches of its axis.
test('protectedLeftShowsAGreenArrow', async ({ page }, testInfo) => {
  await page.goto('/?scenario=signalized');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.lights)).toBe(4);

  const phase = await page.evaluate(async () => {
    await window.__sim.setSpeed('Paused');
    for (let i = 0; i < 1200; i++) {
      await window.__sim.step(10);
      const current = (await window.__sim.snapshot()).lights[0]?.phase;
      if (current?.endsWith('LeftProtected')) return current;
    }
    return null;
  });
  expect(phase, 'the scenario reaches a protected-left phase').not.toBeNull();
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => ({ lamps: s.lights, arrows: s.arrows }))).toEqual({
    lamps: 4,
    arrows: 2,
  });
  await page.locator('#view').screenshot({ path: testInfo.outputPath('protected-left.png') });
});

test('fourLaneScenarioShowsTrafficLive', async ({ page }, testInfo) => {
  await page.goto('/?scenario=signalized4');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);

  await expect
    .poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => ({ driving: s.vehicles > 0, lamps: s.lights })))
    .toEqual({ driving: true, lamps: 4 });
  // The 4×4 box spans tiles 40..43: its centre lies 1.5 tiles (24 world units) past the centre of tile 40.
  const box = tileToWorld(CFG, { x: 40, y: 40 });
  await expect
    .poll(() => page.evaluate(() => window.__sim.camera()))
    .toMatchObject({ centerX: box.x + 24, centerY: box.y + 24 });
  await page.locator('#view').screenshot({ path: testInfo.outputPath('signalized4.png') });
});

// A scenario opened in a hidden pane: the camera focus must wait for a real canvas size, or a 0×0
// start divides the view span by one pixel and the cross ends up a dot.
test('scenarioFocusWaitsForACanvasSize', async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.id = 'collapsed';
      style.textContent = '#view { width: 0 !important; height: 0 !important; }';
      document.head.appendChild(style);
    });
  });
  await page.goto('/?scenario=signalized');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.lights)).toBe(4);

  await page.evaluate(() => document.getElementById('collapsed')!.remove());
  const box = tileToWorld(CFG, { x: 40, y: 40 });
  await expect
    .poll(() => page.evaluate(() => window.__sim.camera()))
    .toMatchObject({ centerX: box.x + 8, centerY: box.y + 8 });
  const cam = await page.evaluate(() => window.__sim.camera());
  // The cross spans 46 tiles of 16 world units; on a 1100 px view that is well under 2 world units a pixel.
  expect(cam.worldPerPixel, 'the whole cross fills the view').toBeLessThan(2);
});

test('pickingReportsTheTileUnderTheCursor', async ({ page }) => {
  await openApp(page);
  await waitForDrawn(page);
  const cam = await page.evaluate(() => window.__sim.fitMap());
  const world = tileToWorld(CFG, { x: 10, y: 20 });
  const at = toScreen(cam, world.x, world.y);

  await page.mouse.move(at.x, at.y);
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.hovered)).toEqual({ x: 10, y: 20 });
  expect(await page.evaluate((p) => window.__sim.pickTile(p.x, p.y), at)).toEqual({ x: 10, y: 20 });
});

// A page opened in a hidden pane or a collapsed layout starts with a 0×0 canvas: WebGPU rejects
// zero-size textures, and the view must come to life once the canvas gets a size.
test('drawingStartsOnceAZeroSizeCanvasGetsASize', async ({ page }) => {
  const gpuErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /GPU|WebGL|texture/i.test(m.text())) gpuErrors.push(m.text());
  });
  // Collapsed before the renderer exists (it waits for the worker). Not via page.route: a fulfilled
  // response loses COOP/COEP in WebKit, and the page loses SharedArrayBuffer.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.id = 'collapsed';
      style.textContent = '#view { width: 0 !important; height: 0 !important; }';
      document.head.appendChild(style);
    });
  });
  await openApp(page);
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.chunks)).toBeGreaterThan(0);
  expect((await page.evaluate(() => window.__sim.camera())).width, 'precondition: the renderer started on a 0×0 canvas').toBe(0);

  await page.evaluate(() => document.getElementById('collapsed')!.remove());
  await waitForDrawn(page);
  expect(gpuErrors, 'no GPU validation errors from the zero-size start').toEqual([]);
  // The first "whole map in view" waits for the size too: fitted on 0×0 it divides by one pixel.
  await expect
    .poll(() => page.evaluate(() => window.__sim.camera()).then((c) => c.worldPerPixel), 'the map fills the view')
    .toBeLessThan((CFG.width * CFG.tileSize) / 1000);
});

test('overlaysOnlyWithDebugFlag', async ({ page }) => {
  await openApp(page);
  await loadTestCity(page);
  await waitForDrawn(page);
  expect((await page.evaluate(() => window.__sim.renderStats())).overlayLanelets).toBe(0);
});

test('debugOverlayDrawsEveryLanelet', async ({ page }) => {
  await openApp(page, '?debug=1');
  await loadTestCity(page);
  await expect
    .poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.overlayLanelets))
    .toBe(laneletFixture.lanelets.length);
});
