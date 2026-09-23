// U5: the toast feed over the map — repeats as one counted line, a click that takes the camera to the event, lines
// that expire. Port of the behaviour of rust-final crates/simcity_frontend/src/game/hud/toasts.rs in a running game.
//
// A fire's line lives five real seconds from its last occurrence (emergencies.ts `startEmergency`), and a loaded
// machine can take longer than that between two Playwright calls. So nothing here reads the feed and hopes the line is
// still up: a MutationObserver in the page logs every state of the feed as it is drawn, and the tests read that log.
import { expect, test, type Page } from '@playwright/test';
import type {} from '../packages/app/src/simApi';

declare global {
  interface Window {
    /** Every state the feed was drawn in: each line as `label|chip`. */
    toastLog?: string[][];
  }
}

// Opening the game alone takes 25 s under a loaded machine (rev-toasts, round 1).
test.describe.configure({ timeout: 120_000 });

/** Far from the centre `fitMap` leaves the camera on, so a click that moved nothing cannot pass. */
const FIRE = { x: 5, y: 7 };

async function openGame(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await page.evaluate(() => window.__sim.setState('InGame'));
  await expect(page.getByTestId('hud')).toBeVisible();
  // A world standing still: the feed carries only the events the test makes.
  await page.evaluate(() => window.__sim.setSpeed('Paused'));
  await page.evaluate(() => {
    const log: string[][] = [];
    window.toastLog = log;
    const record = () => {
      const lines = [...document.querySelectorAll('[data-testid="toast"]')];
      log.push(lines.map((line) => `${line.getAttribute('aria-label')}|${line.querySelector('.hud-toast-count')?.textContent ?? ''}`));
    };
    new MutationObserver(record).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  });
}

/** Eight fires at one tile, sent together: eight identical `Fire emergency` events with a place. */
async function eightFires(page: Page): Promise<void> {
  await page.evaluate((at) => Promise.all(Array.from({ length: 8 }, () => window.__sim.debugEmergency('Fire', at.x, at.y))), FIRE);
}

const toastLog = (page: Page) => page.evaluate(() => window.toastLog ?? []);

/** The tile under the centre of the view. */
const centreTile = (page: Page) =>
  page.evaluate(async () => {
    const camera = await window.__sim.camera();
    return window.__sim.pickTile(camera.width / 2, camera.height / 2);
  });

test('eightIdenticalEventsAreOneLineWithACount', async ({ page }) => {
  await openGame(page);
  await eightFires(page);
  await expect.poll(async () => (await toastLog(page)).some((lines) => lines.includes('Fire emergency ×8|×8')), { message: 'the feed drew «Fire emergency ×8»' }).toBe(true);
  const log = await toastLog(page);
  expect(log.every((lines) => lines.length <= 1), `eight identical events are never two lines: ${JSON.stringify(log)}`).toBe(true);
});

test('clickingAToastTakesTheCameraToTheEvent', async ({ page }) => {
  await openGame(page);
  await page.evaluate(() => window.__sim.fitMap());
  expect(await centreTile(page)).not.toEqual(FIRE);
  // Fire and click in one go; a line that expired before the click is fired again, which only raises its count.
  await expect(async () => {
    await eightFires(page);
    await page.getByTestId('toast').filter({ hasText: 'Fire emergency' }).click({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect.poll(() => centreTile(page)).toEqual(FIRE);
});

test('toastLinesExpire', async ({ page }) => {
  await openGame(page);
  await eightFires(page);
  await expect.poll(async () => (await toastLog(page)).some((lines) => lines.length === 1), { message: 'the feed drew the fire line' }).toBe(true);
  await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 30_000 });
  // states.md: the empty feed is a container without lines.
  await expect(page.getByTestId('toasts')).toBeAttached();
});
