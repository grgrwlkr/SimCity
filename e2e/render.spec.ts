// Stage 1½: the debug renderer in Chromium. The gate reads the class of every tile back
// from a screenshot of the Rust test city and compares it with the Rust grid and the Rust frame.
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import type { CameraState } from '../packages/app/src/simApi';
import { SAMPLE_CARS } from '../packages/bridge/src/sample';
import { SCENARIOS } from '../packages/bridge/src/scenarios';
import { CLASS_COLORS, VEHICLE_COLORS, layoutClass, tileClass, type LayoutClass, type TileClass } from '../packages/render/src/palette';
import { RENDER_CONFIG } from '../packages/render/src/renderConfig';
import { tileToWorld } from '../packages/sim/src/index';
const readJson = <T,>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const road = readJson<RoadFixture>('../packages/sim/src/scenarios/testCity.json');
const laneletFixture = readJson<{ lanelets: unknown[] }>('../packages/sim/test/fixtures/lanelet-routes.json');

interface RoadFixture {
  width: number;
  height: number;
  rawGrid: Record<'height' | 'water' | 'terrain' | 'roadKind' | 'roadDir' | 'roadLane' | 'roadFlow' | 'laneType' | 'zone' | 'density' | 'building', string>;
}

const DEBUG_LAYOUT = new URL('./fixtures/debug-layout.json', import.meta.url);
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
    mapSeed: '0',
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

  expect(existsSync(DEBUG_LAYOUT), 'e2e/fixtures/debug-layout.json: the frame the Rust game drew of the test city (tools/rust-layout.ts at rust-final)').toBe(true);
  const rust = JSON.parse(readFileSync(DEBUG_LAYOUT, 'utf8')) as { classes: string };
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

// Stage 3b live: the living city grows from its zones; its HUD counts its own citizens from the first frame.
test('livingCityShowsItsCitizens', async ({ page }) => {
  await page.goto('/?scenario=living');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);

  await expect(page.getByTestId('citizens')).toHaveText(/^Жители \d/, { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.lights), { timeout: 30_000 }).toBe(36);
  // Stage 3½d: the cars of its citizens are drawn, the parked ones from the start, one cube for every tile they stand on.
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.vehicles), { timeout: 30_000 }).toBeGreaterThan(100);
});

// Stage 4 live: the living city's services and its bus. A fire breaks out at a house, its marker blinks over it, an engine
// sets out from a station, and the HUD counts them.
test('livingCityServesAnEmergencyAndRunsItsBus', async ({ page }, testInfo) => {
  await page.goto('/?scenario=living');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await expect(page.getByTestId('citizens')).toHaveText(/^Жители \d/, { timeout: 30_000 });
  await page.evaluate(async () => {
    await window.__sim.setSpeed('Paused');
    await window.__sim.debugEmergency('Fire', 40, 26);
    await window.__sim.step(50);
  });
  await expect(page.getByTestId('emergencies')).toHaveText('ЧС 1', { timeout: 15_000 });
  await expect(page.getByTestId('buses')).toHaveText('автобусы 1');
  const out = await page.evaluate(() => window.__sim.snapshot()).then((s) => s.services);
  expect(out.vehiclesOut, 'an engine is on its way').toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.emergencyMarkers), { timeout: 15_000 }).toBe(1);
  // Close to the fire, so the marker and the engine are told apart.
  const fire = tileToWorld({ width: 128, height: 128, tileSize: 16 }, { x: 40, y: 26 });
  await page.evaluate((at) => window.__sim.setCamera({ centerX: at.x, centerY: at.y, worldPerPixel: 0.6 }), fire);
  await page.locator('#view').screenshot({ path: testInfo.outputPath('living-emergency.png') });
});

// Stage 3½d gate, in Chromium: the living city in its morning rush at ×1, where every car, parked car and person in view is drawn, and at
// ×60, where the roads show their load and a sample of the cars drives on them.
test('livingCityAtX1AndX60', async ({ page }, testInfo) => {
  // Nine thousand ticks in the browser and three screenshots, drawn on the processor in headless Chromium.
  test.setTimeout(90_000);
  await page.goto('/?scenario=living');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.lights), { timeout: 30_000 }).toBe(36);
  // A quarter of an hour into the rush, stepped while paused so every run draws the same city.
  await page.evaluate(async () => {
    await window.__sim.setSpeed('Paused');
    for (let minute = 0; minute < 15; minute++) await window.__sim.step(600);
    await window.__sim.setSpeed('X1');
  });
  await expect
    .poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => ({ cars: s.vehicles > 0, loadLinks: s.loadLinks })), { timeout: 15_000 })
    .toEqual({ cars: true, loadLinks: 0 });
  await page.locator('#view').screenshot({ path: testInfo.outputPath('living-x1.png') });
  // Downtown by the boulevard, close enough to tell the cars, the parked ones and the people apart.
  await page.evaluate(() => window.__sim.setCamera({ centerX: -24, centerY: -24, worldPerPixel: 0.5 }));
  const frames = (await page.evaluate(() => window.__sim.renderStats())).frames;
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.frames), { timeout: 15_000 }).toBeGreaterThan(frames + 30);
  await page.locator('#view').screenshot({ path: testInfo.outputPath('living-x1-downtown.png') });

  await page.evaluate(() => window.__sim.fitMap());
  await page.evaluate(() => window.__sim.setSpeed('X60'));
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.loadLinks), { timeout: 15_000 }).toBeGreaterThan(0);
  const fast = await page.evaluate(() => window.__sim.renderStats());
  expect(fast.vehicles, 'a sample of the cars').toBeLessThanOrEqual(SAMPLE_CARS);
  await page.locator('#view').screenshot({ path: testInfo.outputPath('living-x60.png') });
});

// Stage 3½a: the speed ladder, the rate the game really runs at, and a failing system reported while the world goes on.
test('hudShowsTheSpeedLadderAndTheRealRate', async ({ page }, testInfo) => {
  await page.goto('/?scenario=city');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);

  await expect(page.getByRole('navigation', { name: 'Скорость' }).getByRole('button')).toHaveText(['Стоп', '×1', '×3', '×10', '×60', '×360']);
  const x60 = page.getByRole('button', { name: '×60', exact: true });
  await x60.click();
  // The pressed state comes back with the worker's next snapshot: under a full parallel run it took past 5 s once.
  await expect(x60).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
  await expect(page.getByTestId('real-rate')).toHaveText(/^×\d+(,\d)?$/);
  await expect(page.getByTestId('clock')).toHaveText(/^День \d+, \d{2}:\d{2}:\d{2}$/);

  await page.evaluate(() => window.__sim.failSystem('computePollution'));
  await expect(page.getByTestId('sim-errors')).toHaveText(/^Сбой: computePollution ×\d+ — debug failure of computePollution$/, { timeout: 15_000 });
  const failedAt = await page.evaluate(() => window.__sim.snapshot()).then((s) => s.tick);
  await expect.poll(() => page.evaluate(() => window.__sim.snapshot()).then((s) => s.tick), { timeout: 15_000 }).toBeGreaterThan(failedAt + 10);
  await page.screenshot({ path: testInfo.outputPath('hud-speeds.png') });
});

// The main menu lists every scenario the app knows, so nobody has to remember the links.
test('mainMenuOffersEveryScenario', async ({ page }, testInfo) => {
  await page.goto('/?debug=1');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  const scenarios = page.getByRole('navigation', { name: 'Сценарии' });
  await expect(scenarios.getByRole('link')).toHaveCount(SCENARIOS.length);
  // A link's name is its title and description; a name given as a string matches any link containing it, and
  // «Город» is inside «Живой город».
  const titled = (title: string) => new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  for (const s of SCENARIOS) {
    await expect(scenarios.getByRole('link', { name: titled(s.title) }), 'the debug flag survives the jump').toHaveAttribute(
      'href',
      `?scenario=${s.query}&debug=1`,
    );
  }
  await page.screenshot({ path: testInfo.outputPath('menu.png') });

  await page.goto('/');
  await page.getByRole('navigation', { name: 'Сценарии' }).getByRole('link', { name: titled('Город') }).click();
  await expect(page).toHaveURL(/\/\?scenario=city$/);
  await expect(page.getByTestId('citizens')).toHaveText(/^Жители 2\s000$/, { timeout: 30_000 });

  await page.getByRole('button', { name: 'В меню' }).click();
  await expect(page.getByRole('navigation', { name: 'Сценарии' }).getByRole('link')).toHaveCount(SCENARIOS.length);
});

// A scenario link opens in the same tab. WebKit revalidated the worker script, got a 304 without COEP
// and refused the worker, so the second page hung on "Запуск симуляции…".
test('aSecondPageInTheSameTabStartsTheSim', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Сценарии' })).toBeVisible();
  await page.goto('/?scenario=signalized');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.lights), { timeout: 15_000 }).toBe(4);
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

// The zoom picks the projection: below `orthoAboveZoom` the camera is perspective, at it and above orthographic.
// Swapping one camera for another must not resize the frame or aim it elsewhere. Nothing here reads the frame
// size back off the plan the camera came from — that check could not fail. The two halves prove different things
// at different resolutions, and neither is a substitute for the other:
//   - the pick path carries the 1 % claim. `__sim.pickTile` is bisected down the middle column for two tile
//     boundaries, to a hundredth of a pixel over roughly a thousand, so the measured frame height is good to
//     far better than a percent. It sees everything the view ray is built from, and nothing beyond it.
//   - the canvas probe is coarse on purpose. It only asks whether the city is drawn where the view contract
//     puts it — the half of the frame the pick path cannot reach, since the picture comes out of Three. It
//     reads a tile's class at that tile's centre, so it notices nothing until the drawing slips half a tile:
//     8 world units against the 96 of the outermost probe, and more for the inner ones. That is tens of
//     percent, not one. Tightening it means a finer landmark than a 16-unit tile, which the fixture has not got.
test('zoomingThroughTheThresholdKeepsTheFrameAndThePick', async ({ page }) => {
  await openApp(page);
  await loadTestCity(page);
  await waitForDrawn(page);
  const threshold = RENDER_CONFIG.perspective.orthoAboveZoom;
  const middle = { x: Math.floor(CFG.width / 2), y: Math.floor(CFG.height / 2) };
  const focus = tileToWorld(CFG, middle);
  // Six tiles out is 96 world units, well inside the ~137 the frame is half as tall as at these zooms.
  const probes = [-6, -3, 0, 3, 6].flatMap((dy) => [-6, -3, 0, 3, 6].map((dx) => ({ x: middle.x + dx, y: middle.y + dy })));
  const grid = gridLayout();
  const probedClasses = probes.map((t) => grid[t.y * CFG.width + t.x]);
  /** Fractions of the viewport: the centre, which every projection fixes, and two points far from it, which none does. */
  const picked = [
    { fx: 0, fy: 0 },
    { fx: 0.3, fy: -0.3 },
    { fx: -0.25, fy: 0.2 },
  ];

  /** Aims the camera at the middle tile at `worldPerPixel` and reports the frame that came out of it. */
  async function framedAt(worldPerPixel: number) {
    const seen = (await page.evaluate(() => window.__sim.renderStats())).frames;
    const cam = await page.evaluate((s) => window.__sim.setCamera(s), { centerX: focus.x, centerY: focus.y, worldPerPixel });
    await expect.poll(() => page.evaluate(() => window.__sim.renderStats()).then((s) => s.frames)).toBeGreaterThan(seen + 1);
    const projection = (await page.evaluate(() => window.__sim.renderStats())).projection;

    const edges = await page.evaluate(
      async ({ x, h }) => {
        const tileAt = async (row: number) => (await window.__sim.pickTile(x, row))?.y ?? null;
        // Screen rows run down the frame while tile rows run north, so the pick falls as the row grows.
        const north = await tileAt(2);
        const south = await tileAt(h - 2);
        if (north === null || south === null || north - south < 4) return null;
        /** The row where the pick first drops to `target`: the boundary between tile rows `target + 1` and `target`. */
        const edge = async (target: number) => {
          let lo = 2;
          let hi = h - 2;
          while (hi - lo > 0.01) {
            const mid = (lo + hi) / 2;
            const seenTile = await tileAt(mid);
            if (seenTile !== null && seenTile > target) lo = mid;
            else hi = mid;
          }
          return (lo + hi) / 2;
        };
        return { north, south, rowNorth: await edge(north - 1), rowSouth: await edge(south) };
      },
      { x: Math.round(cam.width / 2), h: cam.height },
    );
    expect(edges, `no two tile boundaries to measure against at worldPerPixel ${worldPerPixel}`).not.toBeNull();
    const { north, south, rowNorth, rowSouth } = edges!;
    const northY = tileToWorld(CFG, { x: middle.x, y: north - 1 }).y + CFG.tileSize / 2;
    const southY = tileToWorld(CFG, { x: middle.x, y: south }).y + CFG.tileSize / 2;
    const frameHeight = (cam.height * (northY - southY)) / (rowSouth - rowNorth);

    const classes = (
      await sampleCanvas(
        page,
        probes.map((t) => {
          const w = tileToWorld(CFG, t);
          return toScreen(cam, w.x, w.y);
        }),
      )
    ).map((c) => layoutClass(c));
    const picks = await page.evaluate(
      (points) => Promise.all(points.map((p) => window.__sim.pickTile(p.x, p.y))),
      picked.map((p) => ({ x: cam.width * (0.5 + p.fx), y: cam.height * (0.5 + p.fy) })),
    );
    return { projection, frameHeight, classes, picks, wanted: cam.height * worldPerPixel };
  }

  const below = await framedAt(threshold * 0.999);
  const above = await framedAt(threshold);
  expect([below.projection, above.projection], 'the zoom crosses the switch').toEqual(['perspective', 'orthographic']);
  expect(
    Math.abs(below.frameHeight - above.frameHeight) / above.frameHeight,
    `the frame resized across the switch: ${below.frameHeight} then ${above.frameHeight}`,
  ).toBeLessThan(0.01);
  // The two agreeing is not enough on its own — both could be the same wrong size — so each is held to its zoom.
  for (const [label, f] of [
    ['perspective', below],
    ['orthographic', above],
  ] as const) {
    expect(Math.abs(f.frameHeight - f.wanted) / f.wanted, `the ${label} frame measures ${f.frameHeight}, not ${f.wanted}`).toBeLessThan(0.01);
    expect(f.classes, `the ${label} frame draws the city away from where the view contract puts it`).toEqual(probedClasses);
  }
  expect(below.picks, 'the same pixels pick the same tiles in both projections').toEqual(above.picks);
  expect(below.picks[0], 'and the centre pixel is the tile the camera is aimed at').toEqual(middle);
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
