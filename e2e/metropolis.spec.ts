// Stage 3½e gate: the metropolis of a million in Chromium. The fingerprint and the failing system run with the
// suite, in a project of its own after the rest; the measurements carry `@perf` and run alone
// (`E2E_PERF=1 bunx playwright test e2e/metropolis.spec.ts --no-deps --workers=1`), since a parallel suite takes the
// processor they measure.
import { expect, test, type Page } from '@playwright/test';
import type {} from '../packages/app/src/simApi';
import { MetropolisScenario, createWorld, fingerprint, frame, requestState, step, toHex64 } from '../packages/sim/src/index';

const TICKS = 600;

async function openMenu(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
}

test('metropolisFingerprintMatchesNode', async ({ page }) => {
  test.setTimeout(240_000);
  await openMenu(page);
  const reply = await page.evaluate(async (ticks) => {
    await window.__sim.setSpeed('Paused');
    await window.__sim.setState('InGame');
    await window.__sim.scenario('metropolis');
    return window.__sim.step(ticks);
  }, TICKS);

  // The host builds the scenario into a fresh world heading into the game and settles it into its first frame.
  const w = createWorld({ mapWidth: 800, mapHeight: 800 });
  requestState(w, 'InGame');
  new MetropolisScenario(w);
  frame(w, 0);
  step(w, TICKS);
  expect(w.citizens.count, 'a city of a million').toBeGreaterThan(900_000);
  expect(reply).toEqual({ tick: TICKS, fingerprint: toHex64(fingerprint(w)) });
});

test('metropolisGoesOnPastAFailingSystem', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?scenario=metropolis&debug=1');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await expect
    .poll(async () => Number((await page.getByTestId('citizens').textContent())?.replace(/\D/g, '')), { timeout: 120_000 })
    .toBeGreaterThan(900_000);
  await page.evaluate(() => window.__sim.failSystem('computePollution'));
  await expect(page.getByTestId('sim-errors')).toHaveText(/^Сбой: computePollution ×\d+ — debug failure of computePollution$/, { timeout: 30_000 });
  const failedAt = await page.evaluate(() => window.__sim.snapshot()).then((s) => s.tick);
  await expect.poll(() => page.evaluate(() => window.__sim.snapshot()).then((s) => s.tick), { timeout: 30_000 }).toBeGreaterThan(failedAt + 10);
});

test.describe('@perf metropolis measurements', () => {
  test.skip(process.env.E2E_PERF !== '1', 'measurements run alone: E2E_PERF=1');

  /** Ticks a real second over `seconds` at the current speed, divided by the ticks of ×1. */
  async function realRate(page: Page, seconds: number): Promise<number> {
    const [t0, s0] = [Date.now(), (await page.evaluate(() => window.__sim.snapshot())).tick];
    await page.waitForTimeout(seconds * 1000);
    const [t1, s1] = [Date.now(), (await page.evaluate(() => window.__sim.snapshot())).tick];
    return (s1 - s0) / ((t1 - t0) / 1000) / 10;
  }

  test('metropolisHoldsX10AndRunsX360', async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    await page.goto('/?scenario=metropolis&debug=1');
    await page.waitForFunction(() => typeof window.__sim !== 'undefined');
    await page.evaluate(() => window.__sim.ready);
    await expect
      .poll(async () => Number((await page.getByTestId('citizens').textContent())?.replace(/\D/g, '')), { timeout: 120_000 })
      .toBeGreaterThan(900_000);
    // The whole map in view: what the renderer draws is part of the frame the worker publishes.
    await page.evaluate(() => window.__sim.fitMap());
    await page.evaluate(() => window.__sim.setSpeed('X10'));
    // The first plans of a million and the district times, then a clean window.
    await page.waitForTimeout(40_000);
    await page.evaluate(() => window.__sim.resetTickStats());
    const x10 = await realRate(page, 60);
    const ticksX10 = await page.evaluate(() => window.__sim.tickStats());
    const fpsX10 = (await page.evaluate(() => window.__sim.renderStats())).fps;

    await page.evaluate(() => window.__sim.setSpeed('X360'));
    await page.waitForTimeout(5_000);
    await page.evaluate(() => window.__sim.resetTickStats());
    const x360 = await realRate(page, 60);
    const ticksX360 = await page.evaluate(() => window.__sim.tickStats());
    const snapshot = await page.evaluate(() => window.__sim.snapshot());

    await page.evaluate(() => window.__sim.setSpeed('X1'));
    await page.evaluate(() => window.__sim.setCamera({ centerX: 0, centerY: 0, worldPerPixel: 0.5 }));
    await page.waitForTimeout(5_000);
    const downtown = await page.evaluate(() => window.__sim.renderStats());
    await page.locator('#view').screenshot({ path: testInfo.outputPath('metropolis-x1-downtown.png') });
    await page.evaluate(() => window.__sim.fitMap());
    await page.waitForTimeout(5_000);
    const whole = await page.evaluate(() => window.__sim.renderStats());
    await page.locator('#view').screenshot({ path: testInfo.outputPath('metropolis-x1.png') });

    const measured = {
      engine: testInfo.project.name,
      citizens: snapshot.traffic.citizens,
      clock: `${snapshot.city.day} ${snapshot.city.hour}:${snapshot.city.minute}`,
      x10: { realRate: Number(x10.toFixed(2)), ...ticksX10, fps: fpsX10 },
      x360: { realRate: Number(x360.toFixed(1)), ...ticksX360 },
      fpsX1: { downtown: downtown.fps, downtownVehicles: downtown.vehicles, whole: whole.fps, wholeVehicles: whole.vehicles },
      errors: snapshot.errors.map((e) => e.system),
    };
    console.log(JSON.stringify(measured));
    await testInfo.attach('measured.json', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
    expect(measured.errors).toEqual([]);
    if (testInfo.project.name === 'metropolis-chromium') {
      expect(x10, 'the metropolis holds ×10 in Chromium').toBeGreaterThanOrEqual(9.5);
      expect(x360, 'and runs at least ×60 when asked for ×360').toBeGreaterThanOrEqual(60);
    }
  });
});
