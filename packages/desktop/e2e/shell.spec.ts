// The packaged Electron shell: it starts without taking focus, the game answers, saves go to files and
// come back, and the test city holds its frame rate. `SIMCITY_TEST_WINDOW=1` keeps the window hidden.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {} from '../../app/src/saves/desktopSaveStore';
import type {} from '../../app/src/simApi';
import { RELEASE_APP, TEST_APP, buildInfoOf, makeInspectableClone, requireBuild } from './inspectableClone';

// Playwright needs `--inspect`, which the release fuses refuse: drive a clone of the test build, the
// release shell with `window.__sim` in its page.
let APP = '';
test.beforeAll(async () => {
  // No skipping: without the test build, or with one from another commit than the release, the shell is untested.
  requireBuild(TEST_APP);
  requireBuild(RELEASE_APP);
  const { test: isTest, ...tested } = buildInfoOf(TEST_APP);
  const { test: isRelease, ...release } = buildInfoOf(RELEASE_APP);
  expect({ isTest, isRelease }).toEqual({ isTest: true, isRelease: false });
  expect(tested, 'the test build and the release come from one commit: rebuild both').toEqual(release);
  APP = await makeInspectableClone(TEST_APP);
});

/** Each start-up step has a limit of its own, so a hang names the step instead of the test timeout. */
async function launch(args: string[] = []): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await test.step('launch the app', () =>
    electron.launch({ executablePath: APP, args, env: { ...process.env, SIMCITY_TEST_WINDOW: '1' }, timeout: 30_000 }),
  );
  const page = await test.step('first window', () => app.firstWindow({ timeout: 30_000 }));
  await test.step('sim ready', async () => {
    await page.waitForFunction(() => typeof window.__sim !== 'undefined', null, { timeout: 30_000 });
    await page.waitForFunction(() => window.__sim.ready.then(() => true), null, { timeout: 30_000 });
  });
  return { app, page };
}

test('startsWithNothingOnScreenAndTheSimAnswers', async () => {
  const { app, page } = await launch();
  try {
    const shown = await app.evaluate(({ app: a, BrowserWindow }) => ({
      windows: BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), focused: w.isFocused() })),
      dock: a.dock?.isVisible() ?? false,
    }));
    expect(shown).toEqual({ windows: [{ visible: false, focused: false }], dock: false });
    expect(page.url()).toBe('app://bundle/index.html');
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    const before = await page.evaluate(async () => {
      await window.__sim.setState('InGame');
      return (await window.__sim.snapshot()).tick;
    });
    await expect.poll(() => page.evaluate(() => window.__sim.snapshot().then((s) => s.tick))).toBeGreaterThan(before);
  } finally {
    await app.close();
  }
});

test('theTestBuildKeepsDevToolsAndItsMenu', async () => {
  // The release has neither (main.ts `devToolsAllowed`, `RELEASE_MENU`); this build must keep both, or the flag in
  // build-info.json is not what main reads.
  const { app } = await launch();
  try {
    // `webPreferences.devTools` is not readable back (no typed getter); the menu follows the same `devTools` value.
    const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => item.role) ?? []);
    expect(menu).toContain('viewmenu');
  } finally {
    await app.close();
  }
});

test('aMalformedAssetPathGets404', async () => {
  const { app, page } = await launch();
  try {
    const statuses = await page.evaluate(async () => {
      const status = (url: string) => fetch(url).then((r) => r.status, (e: unknown) => `rejected: ${String(e)}`);
      return { badPercent: await status('app://bundle/assets/%E0%A4%A'), missing: await status('app://bundle/assets/none.js') };
    });
    expect(statuses).toEqual({ badPercent: 404, missing: 404 });
  } finally {
    await app.close();
  }
});

test('aSaveGoesToItsSlotFileAndLoadsBackToTheSameWorld', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'simcity-e2e-userdata-'));
  const { app, page } = await launch([`--user-data-dir=${userData}`]);
  try {
    expect(realpathSync(await app.evaluate(({ app: a }) => a.getPath('userData')))).toBe(realpathSync(userData));
    const saved = await page.evaluate(async () => {
      await window.__sim.setState('InGame');
      await window.__sim.setSpeed('Paused');
      await window.__sim.step(50);
      const before = await window.__sim.fingerprint();
      const info = await window.__sim.save('1');
      return { before, info };
    });
    const file = path.join(userData, 'saves', 'slot1.json');
    expect(readdirSync(path.dirname(file))).toEqual(['slot1.json']);
    expect(saved.info).toMatchObject({ slot: '1', bytes: statSync(file).size });
    const after = await page.evaluate(async () => {
      const moved = await window.__sim.step(50);
      const loaded = await window.__sim.load('1');
      return { moved, loaded, now: await window.__sim.fingerprint() };
    });
    expect(after.moved.fingerprint).not.toBe(saved.before.fingerprint);
    expect(after.loaded).toEqual(saved.before);
    expect(after.now).toEqual(saved.before);
    // The main process refuses a slot that is not a number from 1 to 255, whatever the page sends.
    const refused = await page.evaluate(async () => {
      const desktop = window.simcityDesktop as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const outcome = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => String(e));
      return Promise.all([outcome(desktop.save!('../../escape', new ArrayBuffer(1))), outcome(desktop.load!(0)), outcome(desktop.remove!(256))]);
    });
    expect(refused).toEqual(refused.map(() => expect.stringMatching(/RangeError: save slot .*: a whole number from 1 to 255/)));
    expect(readdirSync(path.dirname(file))).toEqual(['slot1.json']);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

/** One measuring window: a count a second for `seconds`, the median of each. */
async function measureFrameRate(app: ElectronApplication, page: Page, seconds: number) {
  const paints = () => app.evaluate(() => (globalThis as { simcityPaintCount?: number }).simcityPaintCount ?? 0);
  const fps: number[] = [];
  const composited: number[] = [];
  for (let i = 0; i < seconds; i++) {
    const before = await paints();
    const started = Date.now();
    await page.waitForTimeout(1000);
    composited.push(Math.round(((await paints()) - before) * (1000 / (Date.now() - started))));
    fps.push((await page.evaluate(() => window.__sim.renderStats())).fps);
  }
  return { fps, composited, fpsMedian: median(fps), compositedMedian: median(composited) };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

// The bar is unchanged (page 58, composited 55). What changed is how the city is measured: a longer warm-up, then up to
// three windows of 10 s each. One window taken while another process holds the GPU (the Pro gave 22–47 on the same
// commit that gives 60) no longer decides alone: two windows of three must each hold both bars. Two passing windows
// settle it, so a quiet machine measures twice.
const FPS_BAR = 58;
const COMPOSITED_BAR = 55;
const WINDOWS = 3;

test('theTestCityHoldsItsFrameRate', async () => {
  // Launch, warm-up and up to three 10 s windows.
  test.setTimeout(150_000);
  const { app, page } = await launch();
  try {
    await page.evaluate(() => {
      location.search = '?scenario=city';
    });
    await page.waitForURL(/scenario=city/);
    await page.waitForFunction(() => typeof window.__sim !== 'undefined');
    await page.evaluate(() => window.__sim.ready);
    // Warm-up: shaders compiled, the city's first chunks uploaded, the FPS meter past its first frames.
    await page.waitForTimeout(5000);
    // Two counts per second: frames the page drew (its FPS meter) and frames the GPU composited (`paint`).
    const windows: Awaited<ReturnType<typeof measureFrameRate>>[] = [];
    // A window passes when both of its medians hold the bar in it.
    const passing = () => windows.filter((w) => w.fpsMedian >= FPS_BAR && w.compositedMedian >= COMPOSITED_BAR).length;
    while (windows.length < WINDOWS && passing() < Math.ceil(WINDOWS / 2)) windows.push(await measureFrameRate(app, page, 10));
    const citizens = await page.evaluate(() => window.__sim.snapshot().then((s) => s.traffic.citizens));
    const backend = await page.evaluate(() => window.__sim.renderStats().then((s) => s.backend));
    const shown = windows.map((w, i) => `window ${i + 1}: page fps ${w.fps.join(' ')}; composited ${w.composited.join(' ')}`);
    const line = `${shown.join(' | ')} (${backend}, citizens ${citizens})`;
    test.info().annotations.push({ type: 'fps', description: line });
    console.log(`test city: ${line}`);
    // The median over the windows of "both bars held": most windows must hold both.
    expect(passing(), line).toBeGreaterThanOrEqual(Math.ceil(WINDOWS / 2));
  } finally {
    await app.close();
  }
});
