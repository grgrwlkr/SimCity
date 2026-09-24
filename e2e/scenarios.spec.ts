// Gate of stage 6b, "every scenario loads": each scenario of the menu opens by its link and runs without a failing
// system. The metropolis builds a million citizens: its case runs in the `metropolis-chromium` project after the rest,
// every other case in `chromium`.
import { expect, test } from '@playwright/test';
import type {} from '../packages/app/src/simApi';
import { SCENARIOS } from '../packages/bridge/src/scenarios';
import { SCENARIO_PRESETS } from '../packages/sim/src/index';

/** Fixed ticks each scenario runs past its opening. */
const TICKS = 200;

for (const scenario of SCENARIOS) {
  const heavy = scenario.name === 'metropolis';
  test(`scenario ${scenario.name} opens without a failing system`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== (heavy ? 'metropolis-chromium' : 'chromium'), 'the metropolis runs in its own project, after the rest');
    test.setTimeout(heavy ? 240_000 : 60_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`/?scenario=${scenario.query}`);
    await page.waitForFunction(() => typeof window.__sim !== 'undefined');
    await page.evaluate(() => window.__sim.ready);
    // main.tsx builds the scenario after `ready`: its map is on the world once the snapshot shows an edit.
    await expect
      .poll(() => page.evaluate(() => window.__sim.snapshot().then((s) => s.appState === 'InGame' && s.mapEditVersion > 0)), { timeout: heavy ? 180_000 : 30_000 })
      .toBe(true);
    const opened = await page.evaluate(async (ticks) => {
      await window.__sim.setSpeed('Paused');
      const before = (await window.__sim.snapshot()).tick;
      await window.__sim.step(ticks);
      return { before, after: await window.__sim.snapshot() };
    }, TICKS);
    expect(opened.after.tick, 'the scenario runs its ticks').toBe(opened.before + TICKS);
    expect(opened.after.errors, 'no system failed').toEqual([]);
    const preset = SCENARIO_PRESETS.find((p) => p.id === scenario.name);
    if (preset !== undefined) {
      expect(opened.after.mapSeed, 'a preset opens on its own seed').toBe(preset.seed.toString());
      expect(opened.after.scenario?.id).toBe(preset.id);
      expect(opened.after.scenario?.objectives.length).toBe(preset.objectives.length);
    } else {
      expect(opened.after.scenario, 'objectives are the presets\' alone').toBeNull();
    }
    expect(pageErrors, 'no uncaught error on the page').toEqual([]);
  });
}
