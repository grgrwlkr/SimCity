// Stage R5: the screenshot gates of the scene (Q1 = a, the reference is the TS frames the user accepted). The test city
// from four views at noon and at midnight: two pages draw the same frame, and the frame matches its reference in
// e2e/fixtures/render/. `E2E_RENDER_UPDATE=1` writes the references instead. The `@perf` block below is not a gate: the
// numbers of the render debts for the plan of stage 5.
import { chromium, expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { SceneStats } from '../packages/render/src/scene/sceneRenderer';
import { tileToWorld } from '../packages/sim/src/index';

type LayerName = 'height' | 'water' | 'terrain' | 'roadKind' | 'roadDir' | 'roadLane' | 'roadFlow' | 'laneType' | 'zone' | 'density' | 'building';
const city = JSON.parse(readFileSync(new URL('../packages/sim/src/scenarios/testCity.json', import.meta.url), 'utf8')) as {
  width: number;
  height: number;
  rawGrid: Record<LayerName, string>;
};
/**
 * One set of references for every platform: SwiftShader on Linux x86_64 (CI's, checked in the Playwright image under
 * emulation) drew the macOS arm64 references within a mean of 0.0016, a third of `MAX_MEAN`. The platform is logged.
 */
const PLATFORM = `${process.platform}-${process.arch}`;
const REFERENCE_DIR = new URL('./fixtures/render/', import.meta.url);
const UPDATE = process.env.E2E_RENDER_UPDATE === '1';

/**
 * The metric: the mean over the frame of each pixel's largest channel difference, 0..255. A frame matches when the mean
 * is at most `MAX_MEAN`. SwiftShader draws the same frame twice bit for bit on one platform, so the bound only has to sit
 * under half of the smallest change the gate must see: the sun an hour on, the windows out at midnight, the shadows gone
 * at noon, in every view (`renderGateSeesTheLookGo`). The share of pixels off by more than 16 is reported beside it.
 */
const MAX_MEAN = 0.005;
const PIXEL_TOLERANCE = 16;
/** GTAO draws black under SwiftShader (docs/research/2026-09-21-q8-q9-render-pack.md, Q8); the rest of the look is in. */
const GATE_OFF = 'ao';

test.use({ viewport: { width: 640, height: 480 } });
test.describe.configure({ timeout: 600_000 });

const sceneStats = (page: Page) => page.evaluate(() => window.__sim.renderStats()) as Promise<SceneStats>;
const hex = (s: string) => Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16));
/** `1 + BUILDING_KINDS.indexOf('FireStation')`: the fixture's fire station tiles. */
const FIRE_STATION = 4;

/** Page errors are printed once per page: a shader that fails to build surfaces only here, the frame just stops. */
const watched = new WeakSet<Page>();
async function openScene(page: Page, query: string): Promise<void> {
  if (!watched.has(page)) {
    watched.add(page);
    page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
  }
  await page.goto(`/?renderer=scene${query}`);
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await page.addStyleTag({ content: '#root { visibility: hidden; }' });
}

async function loadCity(page: Page): Promise<void> {
  const { height, ...rest } = city.rawGrid;
  await page.evaluate(async (layers) => {
    await window.__sim.setSpeed('Paused');
    await window.__sim.setState('InGame');
    await window.__sim.loadGridHex(layers);
    await window.__sim.step(1);
  }, { elevation: height, ...rest });
}

/** Resolves once the current map is drawn, and a few frames after that: the camera has settled into the frame too. */
async function waitForDrawn(page: Page): Promise<SceneStats> {
  // `drawn/sent frames windows`: a timeout shows which of them stopped.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          // The worker's snapshot waits at most 5 s: a stalled worker reads as `worker?`, a stalled page never returns.
          const r = (await window.__sim.renderStats()) as SceneStats;
          const s = await Promise.race([window.__sim.snapshot(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))]);
          return `${r.mapEditVersion}/${s === null ? 'worker?' : s.mapEditVersion} frames ${r.frames} windows ${r.windowsPending}`;
        }),
      { timeout: 240_000 },
    )
    .toMatch(/^(\d+)\/\1 /);
  const since = (await sceneStats(page)).frames;
  await expect.poll(() => sceneStats(page).then((s) => s.frames), { timeout: 240_000 }).toBeGreaterThan(since + 2);
  return sceneStats(page);
}

const tileCentre = (tile: number) => tileToWorld({ width: city.width, height: city.height, tileSize: 16 }, { x: tile % city.width, y: Math.floor(tile / city.width) });
const fireStation = hex(city.rawGrid.building).findIndex((b) => b === FIRE_STATION);

/** The four views: the whole city and the district orthographic, a street and a corner in perspective. */
const VIEWS: ReadonlyArray<{ readonly name: string; readonly place: (page: Page) => Promise<unknown> }> = [
  { name: 'city', place: (page) => page.evaluate(() => window.__sim.fitMap()) },
  { name: 'district', place: (page) => page.evaluate((c) => window.__sim.setCamera({ centerX: c.x, centerY: c.y, worldPerPixel: 1 }), tileCentre(fireStation)) },
  { name: 'street', place: (page) => page.evaluate((c) => window.__sim.setCamera({ centerX: c.x, centerY: c.y, worldPerPixel: 0.2 }), tileCentre(fireStation)) },
  { name: 'corner', place: (page) => page.evaluate((c) => window.__sim.setCamera({ centerX: c.x + 20, centerY: c.y + 30, worldPerPixel: 0.1 }), tileCentre(fireStation)) },
];
const HOURS = [
  { name: 'noon', hour: 12 },
  { name: 'midnight', hour: 0 },
] as const;

/** One view at one hour: the frame of `#view` and the stats it was drawn with. */
async function shoot(page: Page, view: (typeof VIEWS)[number], hour: number, off = GATE_OFF): Promise<{ png: Buffer; stats: SceneStats }> {
  await openScene(page, `&hour=${hour}&off=${off}`);
  await loadCity(page);
  // The view goes in once the map is drawn: a camera set before the map arrives is fitted away by its first frame.
  await waitForDrawn(page);
  await view.place(page);
  const stats = await waitForDrawn(page);
  return { png: await page.locator('#view').screenshot(), stats };
}

interface FrameDiff {
  /** Mean of the largest channel difference per pixel, 0..255: the gate's metric. */
  readonly mean: number;
  /** Share of pixels off by more than `PIXEL_TOLERANCE`. */
  readonly share: number;
  readonly size: string;
}

async function frameDiff(page: Page, a: Buffer, b: Buffer): Promise<FrameDiff> {
  return page.evaluate(
    async ({ a, b, tolerance }) => {
      const read = async (b64: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [x, y] = [await read(a), await read(b)];
      if (x.width !== y.width || x.height !== y.height) return { mean: 255, share: 1, size: `${x.width}x${x.height} vs ${y.width}x${y.height}` };
      let differing = 0;
      let sum = 0;
      for (let o = 0; o < x.data.length; o += 4) {
        const d = Math.max(Math.abs(x.data[o]! - y.data[o]!), Math.abs(x.data[o + 1]! - y.data[o + 1]!), Math.abs(x.data[o + 2]! - y.data[o + 2]!));
        sum += d;
        if (d > tolerance) differing += 1;
      }
      const n = x.data.length / 4;
      return { mean: sum / n, share: differing / n, size: `${x.width}x${x.height}` };
    },
    { a: a.toString('base64'), b: b.toString('base64'), tolerance: PIXEL_TOLERANCE },
  );
}

const referencePath = (view: string, hour: string) => new URL(`${view}-${hour}.png`, REFERENCE_DIR);

for (const view of VIEWS) {
  for (const hour of HOURS) {
    test(`renderGate ${view.name} ${hour.name}`, async ({ page, browser, baseURL }, testInfo) => {
      // Two pages in two browser contexts: nothing of the first page's session is left for the second to draw from.
      const context = await browser.newContext({ viewport: { width: 640, height: 480 }, ...(baseURL === undefined ? {} : { baseURL }) });
      const first = await shoot(page, view, hour.hour);
      // The first page stops drawing: both share the browser's GPU process, and under SwiftShader a scene still drawing
      // there starved the second page's shader builds past four minutes.
      await page.goto('about:blank');
      const second = await shoot(await context.newPage(), view, hour.hour);
      await context.close();
      writeFileSync(testInfo.outputPath(`${view.name}-${hour.name}-1.png`), first.png);
      writeFileSync(testInfo.outputPath(`${view.name}-${hour.name}-2.png`), second.png);
      const runs = await frameDiff(page, first.png, second.png);
      const line = { platform: PLATFORM, view: view.name, hour: hour.name, projection: first.stats.projection, post: first.stats.post, buildings: first.stats.buildings, runs };
      expect(first.stats.buildingInstancesDrawn, 'the city is in the frame').toBeGreaterThan(0);
      expect(runs.mean, `two pages draw the same frame: ${JSON.stringify(runs)}`).toBeLessThanOrEqual(MAX_MEAN);
      const ref = referencePath(view.name, hour.name);
      if (UPDATE) {
        mkdirSync(REFERENCE_DIR, { recursive: true });
        writeFileSync(ref, first.png);
        console.log(`render gate (reference written): ${JSON.stringify(line)}`);
        return;
      }
      expect(existsSync(ref), `reference ${ref.pathname}: run with E2E_RENDER_UPDATE=1 and have it accepted`).toBe(true);
      const reference = await frameDiff(page, readFileSync(ref), first.png);
      console.log(`render gate: ${JSON.stringify({ ...line, reference })}`);
      expect(reference.mean, `the frame matches its reference: ${JSON.stringify(reference)}`).toBeLessThanOrEqual(MAX_MEAN);
    });
  }
}

// The bound is not so loose that the look can leave unnoticed, in any view: the sun an hour past noon, the windows out
// at midnight and the shadows gone at noon each move the mean by at least twice `MAX_MEAN`.
for (const view of VIEWS) {
  test(`renderGateSeesTheLookGo ${view.name}`, async ({ page }) => {
    const noon = await shoot(page, view, 12);
    const sun = await frameDiff(page, noon.png, (await shoot(page, view, 13)).png);
    const shadows = await frameDiff(page, noon.png, (await shoot(page, view, 12, `${GATE_OFF},shadows`)).png);
    const midnight = await shoot(page, view, 0);
    const windows = await frameDiff(page, midnight.png, (await shoot(page, view, 0, `${GATE_OFF},windows`)).png);
    console.log(`render gate mutations: ${JSON.stringify({ platform: PLATFORM, view: view.name, backend: noon.stats.backend, sun, windows, shadows })}`);
    expect(sun.mean, 'the sun an hour on').toBeGreaterThanOrEqual(2 * MAX_MEAN);
    expect(windows.mean, 'windows out at midnight').toBeGreaterThanOrEqual(2 * MAX_MEAN);
    expect(shadows.mean, 'no shadows at noon').toBeGreaterThanOrEqual(2 * MAX_MEAN);
  });
}

// Not a gate: the render debts on the fitted metropolis, for the plan of stage 5. Run alone on the GPU:
// `E2E_PERF=1 E2E_GPU=1 bunx playwright test e2e/render-gates.spec.ts --grep @perf --workers=1`.
test.describe('@perf render debts', () => {
  test.skip(process.env.E2E_PERF !== '1', 'measurements run alone: E2E_PERF=1');
  test.describe.configure({ timeout: 600_000 });

  // Headless Chromium on this Mac paces frames at 9-14 Hz whatever the scene costs (every effect off on a 128 map drew
  // at 14 fps): the browser of this test runs without vsync and the frame-rate cap, so the count is what the GPU
  // manages. `RENDER_PERF_UNCAPPED=0` keeps the cap.
  test('renderDebtsOnTheFittedMetropolis', async ({ baseURL }, testInfo) => {
    const uncapped = process.env.RENDER_PERF_UNCAPPED === '0' ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit'];
    const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', ...uncapped] });
    const page = await browser.newPage({ viewport: { width: 800, height: 800 }, ...(baseURL === undefined ? {} : { baseURL }) });
    await openScene(page, `&scenario=metropolis${process.env.RENDER_PERF_QUERY ?? ''}`);
    // The load is several maps (the empty one, then the city): the dearest setMap of the first seconds is the city's.
    let setMapMs = 0;
    const loadStats = () => sceneStats(page).then((s) => ((setMapMs = Math.max(setMapMs, s.setMapMs)), s));
    await expect.poll(() => loadStats().then((s) => s.buildings), { timeout: 300_000, intervals: [100] }).toBeGreaterThan(0);
    for (let k = 0; k < 30; k++) await loadStats().then(() => page.waitForTimeout(100));
    const loaded = await sceneStats(page);
    await page.evaluate(() => window.__sim.setSpeed('Paused'));
    const t0 = Date.now();
    const drawn = await waitForDrawn(page);
    const untilDrawnMs = Date.now() - t0;
    await page.evaluate(() => {
      const w = window as unknown as { __longTaskMs: number };
      w.__longTaskMs = 0;
      new PerformanceObserver((list) => list.getEntries().forEach((e) => (w.__longTaskMs += e.duration))).observe({ type: 'longtask' });
    });
    const a = await sceneStats(page);
    const s0 = Date.now();
    await page.waitForTimeout(10_000);
    const b = await sceneStats(page);
    // Main-thread time in tasks over 50 ms during the window: a frame held up by the processor, not the GPU.
    const longTaskShare = Math.round((await page.evaluate(() => (window as unknown as { __longTaskMs: number }).__longTaskMs)) / (Date.now() - s0) * 100) / 100;
    const fps = Math.round(((b.frames - a.frames) * 1000) / (Date.now() - s0));
    await page.screenshot({ path: testInfo.outputPath('metropolis-fitted.png') });
    // The first data map on this map: the whole ground and every building repainted.
    await page.addStyleTag({ content: '#root { visibility: visible !important; }' });
    const toggle = page.getByTestId('datamap-toggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    const dataMaps: Record<string, number> = {};
    for (const overlay of ['LandValue', 'Zones']) {
      await page.getByTestId(`overlay-${overlay}`).click();
      await expect.poll(() => sceneStats(page).then((s) => s.dataMap), { timeout: 120_000 }).toBe(overlay);
      dataMaps[overlay] = (await sceneStats(page)).dataMapMs ?? NaN;
    }
    // Which device drew it: Dawn falls back to a software adapter when it finds no GPU, and the numbers mean nothing then.
    const adapter = await page.evaluate(async () => {
      const a = await (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ info: { vendor: string; architecture: string; description: string }; isFallbackAdapter?: boolean } | null> } }).gpu?.requestAdapter();
      return a === null || a === undefined ? 'none' : `${a.info.vendor}/${a.info.architecture}/${a.info.description}${a.isFallbackAdapter === true ? ' fallback' : ''}`;
    });
    // What the page's clock paces frames at, whatever the scene costs: headless pacing caps the fps above.
    const rafHz = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let n = 0;
          const t0 = performance.now();
          const tick = () => (performance.now() - t0 < 2000 ? (n++, requestAnimationFrame(tick)) : resolve(Math.round(n / 2)));
          requestAnimationFrame(tick);
        }),
    );
    const line = {
      query: process.env.RENDER_PERF_QUERY ?? '',
      adapter,
      rafHz,
      backend: b.backend,
      buildings: loaded.buildings,
      props: loaded.props,
      setMapMs,
      untilDrawnMs,
      fps,
      longTaskShare,
      vehicles: b.vehicles,
      drawCalls: b.drawCalls,
      post: b.post,
      dataMapMs: dataMaps,
      drawnFps: drawn.fps,
    };
    console.log(`render debts: ${JSON.stringify(line)}`);
    testInfo.annotations.push({ type: 'render debts', description: JSON.stringify(line) });
    await browser.close();
  });
});
