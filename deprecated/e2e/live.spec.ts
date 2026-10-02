// The live helpers of e2e/helpers/live.ts in Chromium: each test is one meaning carried over from rust-final
// crates/simcity_debug/src/game/live/{observe,control,capture}.rs or the naming tests of
// crates/simcity_sim/src/game/map/tests.rs, under the Rust test's name where one maps. The worker side of observe and
// setClock (packages/bridge/src/requests) is wired into protocol.ts and host.ts by the integrator; before that the
// page tests fail on "unknown request".
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { OBSERVE_SECTIONS } from '../packages/bridge/src/requests/observe';
import { capture, frameStats, looksRendered, observe, openGame, overlayFromName, setClock, setSpeed, speedFromName } from './helpers/live';

test.describe.configure({ timeout: 180_000 });
test.use({ viewport: { width: 1280, height: 800 } });

/** The city held still: frames differ only by what a test changes. */
async function openStillCity(page: Page, query = ''): Promise<void> {
  await openGame(page, `?scenario=city${query}`);
  await page.evaluate(async () => {
    await window.__sim.setSpeed('Paused');
    await window.__sim.step(20);
  });
}

/** Mean luma of a CSS-pixel region of a PNG shot at `dpr`. */
async function regionMean(page: Page, png: Buffer, r: { x: number; y: number; width: number; height: number }, dpr: number): Promise<number> {
  return page.evaluate(
    async ({ b64, r, dpr }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const d = ctx.getImageData(Math.round(r.x * dpr), Math.round(r.y * dpr), Math.max(Math.round(r.width * dpr), 1), Math.max(Math.round(r.height * dpr), 1)).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
      return sum / (d.length / 4);
    },
    { b64: png.toString('base64'), r, dpr },
  );
}

test.describe('naming', () => {
  test('cityFieldsOverlaysCanBeNamed', () => {
    for (const [name, mode] of [
      ['Crime', 'Crime'],
      ['Fire hazard', 'FireHazard'],
      ['fire_hazard', 'FireHazard'],
      ['Health', 'Health'],
      ['Education', 'Education'],
      ['Attractiveness', 'Attractiveness'],
    ] as const) {
      expect(overlayFromName(name), name).toBe(mode);
    }
  });

  test('namesAreForgivingAboutCaseAndSpacingButNotAboutNonsense', () => {
    expect(overlayFromName('  land_value ')).toBe('LandValue');
    expect(overlayFromName('SERVICECOVERAGE')).toBe('ServiceCoverage');
    expect(overlayFromName('Service')).toBe('ServiceCoverage');
    expect(overlayFromName('Land Value')).toBe('LandValue');
    expect(overlayFromName('smog')).toBeNull();
    expect(overlayFromName('')).toBeNull();
    expect(speedFromName('  PAUSE ')).toBe('Paused');
    expect(speedFromName('1')).toBe('X1');
    expect(speedFromName('x360')).toBe('X360');
    expect(speedFromName('x2'), 'the Rust ladder had ×2; this one does not').toBeNull();
    expect(speedFromName('fast')).toBeNull();
    expect(speedFromName('')).toBeNull();
  });

  test('aSimRequestRefusesAnUnknownSpeed', async ({ page }) => {
    await expect(setSpeed(page, 'warp9')).rejects.toThrow(/warp9/);
  });

  /** Every map the panel offers is named by its id and by the words on its button. */
  test('everyOverlayTheToolbarOffersCanBeNamed', async ({ page }) => {
    await openStillCity(page);
    const toggle = page.getByTestId('datamap-toggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    const buttons = page.locator('[data-testid^="overlay-"]');
    await expect(buttons.first()).toBeVisible();
    const offered = await buttons.evaluateAll((els) => els.map((el) => [el.getAttribute('data-testid')!.slice('overlay-'.length), el.textContent!.trim()] as const));
    expect(offered.length).toBeGreaterThan(10);
    for (const [mode, label] of offered) {
      expect(overlayFromName(mode), mode).toBe(mode);
      expect(overlayFromName(label), label).toBe(mode);
    }
  });

  /** Every speed button of the HUD is named by its label, and setting a speed by that name is what the button does. */
  test('everySpeedTheToolbarOffersCanBeNamed', async ({ page }) => {
    await openStillCity(page);
    const labels = await page.getByRole('navigation', { name: 'Скорость' }).getByRole('button').allTextContents();
    expect(labels).toHaveLength(6);
    for (const label of labels) {
      const speed = await setSpeed(page, label);
      await expect.poll(() => page.evaluate(() => window.__sim.snapshot().then((s) => s.speed)), label).toBe(speed);
    }
  });
});

test.describe('observe', () => {
  /** Every section asked for comes back, read from the tick the snapshot reports, and reading changes nothing. */
  test('theAnswerAlwaysCarriesEverySection', async ({ page }) => {
    await openStillCity(page);
    const before = await page.evaluate(() => window.__sim.fingerprint());
    const reply = await observe(page, { sections: OBSERVE_SECTIONS, at: { x: 10, y: 10 }, tool: { kind: 'Park' }, region: [0, 0, 30, 30] });
    for (const section of OBSERVE_SECTIONS) expect(reply[section], section).toBeDefined();
    const snapshot = await page.evaluate(() => window.__sim.snapshot());
    expect(reply.tick).toBe(snapshot.tick);
    expect([reply.day, reply.hour, reply.minute]).toEqual([snapshot.city.day, snapshot.city.hour, snapshot.city.minute]);
    expect(reply.budget!.taxRates).toEqual(snapshot.taxRates);
    expect(reply.milestones!.bestPopulation).toBe(snapshot.milestones.bestPopulation);
    expect(reply.advisor!.problems.slice(0, 3)).toEqual(snapshot.advisor);
    expect(reply.buildings!.inRegion, 'a region lists its buildings').not.toBeNull();
    expect(await page.evaluate(() => window.__sim.fingerprint()), 'observing reads, never writes').toEqual(before);
  });

  test('aMalformedParameterIsRefusedRatherThanIgnored', async ({ page }) => {
    await openStillCity(page);
    await expect(observe(page, { sections: ['weather' as never] })).rejects.toThrow(/weather/);
    await expect(observe(page, { sections: ['buildings'], region: [1, 2, 3] as never })).rejects.toThrow(/`region`/);
  });

  test('toolPreviewIsReportedSoAPlacementRunCanChooseItsTile', async ({ page }) => {
    await openStillCity(page);
    const off = await observe(page, { sections: ['preview'], at: { x: -1, y: 0 }, tool: { kind: 'Park' } });
    expect(off.preview).toMatchObject({ tile: { x: -1, y: 0 }, tool: { kind: 'Park' }, verdict: 'Вне карты' });
    const inspect = await observe(page, { sections: ['preview'], at: { x: 5, y: 5 }, tool: { kind: 'Inspect' } });
    expect(inspect.preview!.verdict, 'inspect edits nothing').toBeNull();
  });
});

test.describe('setClock', () => {
  /** The hour is written, not waited for; an hour already past is tomorrow's; the past itself is refused. */
  test('aSimRequestReadsSpeedClockAndStep', async ({ page }) => {
    await openStillCity(page);
    const clock = () => page.evaluate(() => window.__sim.snapshot().then((s) => [s.city.day, s.city.hour, s.city.minute]));
    const start = await clock();
    expect(await setClock(page, 12)).toMatchObject({ day: start[0], hour: 12, minute: 0 });
    expect(await clock()).toEqual([start[0], 12, 0]);
    await setClock(page, 3);
    expect(await clock()).toEqual([start[0]! + 1, 3, 0]);
    await expect(setClock(page, 12, start[0])).rejects.toThrow(/forward/);
    await expect(setClock(page, 24)).rejects.toThrow(/`hour`/);
  });

  /** From the moment set the world runs on the same in any run: setClock must not break a replay. */
  test('setClockIsDeterministic', async ({ browser }) => {
    const run = async () => {
      const page = await browser.newPage();
      // Paused before the city exists: `?scenario=` would run it at ×1 for as long as the page takes to load.
      await openGame(page);
      await page.evaluate(async () => {
        await window.__sim.setSpeed('Paused');
        await window.__sim.setState('InGame');
        await window.__sim.scenario('city');
        await window.__sim.step(20);
      });
      await setClock(page, 18, 2);
      const reply = await page.evaluate(() => window.__sim.step(60));
      await page.close();
      return reply;
    };
    const [a, b] = [await run(), await run()];
    expect(a.tick).toBe(b.tick);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  /** What the clock is set for: a noon frame without waiting half a day, lit as noon while the game stands still. */
  test('aNoonFrameIsLitAsNoonWhileTheGameIsPaused', async ({ page }) => {
    await openStillCity(page, '&renderer=scene');
    await setClock(page, 0);
    const night = await capture(page, { settleFrames: 3 });
    await setClock(page, 12);
    const noon = await capture(page, { settleFrames: 3 });
    expect(noon.looksRendered).toBe(true);
    expect(noon.stats.mean, `noon ${noon.stats.mean.toFixed(1)} against midnight ${night.stats.mean.toFixed(1)}`).toBeGreaterThan(night.stats.mean + 10);
  });
});

test.describe('input', () => {
  /** A tile hovered from inside the game, no pointer moved; `null` hands hovering back to the pointer. */
  test('hoverTileSetsAndClearsThePointerOverride', async ({ page }) => {
    await openStillCity(page);
    expect(await page.evaluate(() => window.__sim.hoverTile({ x: 3, y: 4 }))).toEqual({ x: 3, y: 4 });
    expect(await page.evaluate(() => window.__sim.pointerOverride())).toEqual({ x: 3, y: 4 });
    await page.evaluate(() => window.__sim.hoverTile(null));
    expect(await page.evaluate(() => window.__sim.pointerOverride())).toBeNull();
  });

  test('hoverTileOffTheMapIsRefused', async ({ page }) => {
    await openStillCity(page);
    await expect(page.evaluate(() => window.__sim.hoverTile({ x: 900, y: 4 }))).rejects.toThrow(/off the map/);
    expect(await page.evaluate(() => window.__sim.pointerOverride())).toBeNull();
  });
});

test.describe('capture', () => {
  test('aCaptureLooksRenderedAndLandsAtItsPath', async ({ page }, testInfo) => {
    await openStillCity(page);
    const path = testInfo.outputPath('nested', 'dir', 'shot.png');
    const shot = await capture(page, { path });
    expect(shot.looksRendered, JSON.stringify(shot.stats)).toBe(true);
    expect(shot.settledFrames, 'the renderer drew fresh frames before the shot').toBeGreaterThanOrEqual(2);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).equals(shot.png)).toBe(true);
  });

  /** Without `ui` the map alone, at the canvas's size; the HUD is hidden for the shot only and is back after it. */
  test('parseDefaultsToTheOffscreenEye', async ({ page }) => {
    await openStillCity(page);
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const box = (await page.locator('#view').boundingBox())!;
    const world = await capture(page);
    expect([world.stats.width, world.stats.height]).toEqual([Math.round(box.width * dpr), Math.round(box.height * dpr)]);
    const withHud = await page.locator('#view').screenshot();
    // Where the HUD bar lies the shot shows the map, not the bar; where nothing lies over the map both shots agree, so
    // the difference is the HUD and nothing else.
    const bar = (await page.getByTestId('hud').boundingBox())!;
    const barBox = { x: bar.x - box.x, y: bar.y - box.y, width: bar.width, height: bar.height };
    const clear = { x: box.width / 2 - 20, y: box.height / 2 - 20, width: 40, height: 40 };
    const overClear = await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y)[0]?.id, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(overClear, 'nothing of the HUD over the middle of the map').toBe('view');
    const differs = async (region: typeof clear) => (await regionMean(page, world.png, region, dpr)) - (await regionMean(page, withHud, region, dpr));
    expect(Math.abs(await differs(barBox)), 'the bar is not in the shot').toBeGreaterThan(3);
    expect(Math.abs(await differs(clear)), 'the map itself is the same').toBeLessThan(0.5);
    await expect(page.getByTestId('hud'), 'and the HUD is back after the shot').toBeVisible();
  });

  test('aUiCaptureTakesTheWindowSizeAndScale', async ({ page }) => {
    await openStillCity(page);
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const shot = await capture(page, { ui: true });
    expect([shot.stats.width, shot.stats.height]).toEqual([1280 * dpr, 800 * dpr]);
    expect(shot.looksRendered).toBe(true);
  });

  test('twoDestinationsAreTwoIndependentJobs', async ({ page }, testInfo) => {
    await openStillCity(page);
    const [one, two] = [testInfo.outputPath('one.png'), testInfo.outputPath('two.png')];
    await Promise.all([capture(page, { path: one }), capture(page, { path: two, ui: true })]);
    expect(existsSync(one) && existsSync(two)).toBe(true);
  });

  test('aFrameThatNeverArrivesTimesOut', async ({ page }) => {
    await openStillCity(page);
    await page.evaluate(() => {
      const stats = window.__sim.renderStats;
      window.__sim.renderStats = () => stats().then((s) => ({ ...s, frames: 0 }));
    });
    await expect(capture(page, { timeoutMs: 500 })).rejects.toThrow(/drew 0 of 2 frames/);
  });

  test('aFailureFromTheObserverReachesTheCaller', async ({ page }, testInfo) => {
    await openStillCity(page);
    const file = testInfo.outputPath('not-a-folder');
    writeFileSync(file, 'x');
    await expect(capture(page, { path: `${file}/shot.png` })).rejects.toThrow(/ENOTDIR|EEXIST/);
  });

  test('parseInsistsTheDestinationIsAPng', async ({ page }) => {
    for (const bad of ['a.txt', 'a', '/Users/someone/.zshrc']) await expect(capture(page, { path: bad }), bad).rejects.toThrow(/\.png/);
  });

  test('parseRefusesAUiFlagThatIsNotABool', async ({ page }) => {
    await expect(capture(page, { ui: 'yes' as never })).rejects.toThrow(/`ui`/);
  });

  test('aFrameWorthLookingAtIsDrawnAndNotOneFlatColour', () => {
    const frame = (px: (i: number) => number) => Uint8Array.from({ length: 16 * 4 }, (_, i) => (i % 4 === 3 ? 255 : px(i >> 2)));
    expect(looksRendered(frameStats(4, 4, frame(() => 0))), 'black').toBe(false);
    expect(looksRendered(frameStats(4, 4, frame(() => 128))), 'flat grey').toBe(false);
    expect(frameStats(4, 4, frame(() => 128)).std, 'a flat frame spreads by exactly zero').toBe(0);
    expect(looksRendered(frameStats(4, 4, frame((i) => ((i + (i >> 2)) % 2 === 0 ? 0 : 255)))), 'checkerboard').toBe(true);
    expect(() => frameStats(4, 4, new Uint8Array(10)), 'a buffer that disagrees with its size').toThrow(RangeError);
    const flat = (r: number, g: number, b: number) => frameStats(1, 1, [r, g, b, 255]).mean;
    expect(flat(0, 255, 0), 'luma weighs green heaviest').toBeGreaterThan(flat(255, 0, 0));
    expect(flat(255, 0, 0)).toBeGreaterThan(flat(0, 0, 255));
  });
});
