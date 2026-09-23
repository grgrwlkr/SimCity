// U5: the toast feed over the map — repeats as one counted line, a click that takes the camera to the event, lines
// that expire. Port of the behaviour of rust-final crates/simcity_frontend/src/game/hud/toasts.rs in a running game.
import { expect, test, type Page } from '@playwright/test';
import type {} from '../packages/app/src/simApi';

/** Far from the centre `fitMap` leaves the camera on, so a click that moved nothing cannot pass. */
const FIRE = { x: 5, y: 7 };

async function openGame(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await page.getByTestId('start').click();
  await expect(page.getByTestId('hud')).toBeVisible();
  // A world standing still: the feed carries only the events the test makes.
  await page.evaluate(() => window.__sim.setSpeed('Paused'));
}

/** Eight fires at one tile: eight identical `Fire emergency` events with a place. */
async function eightFires(page: Page): Promise<void> {
  await page.evaluate(async (at) => {
    for (let i = 0; i < 8; i += 1) await window.__sim.debugEmergency('Fire', at.x, at.y);
  }, FIRE);
}

/** The tile under the centre of the view. */
const centreTile = (page: Page) =>
  page.evaluate(async () => {
    const camera = await window.__sim.camera();
    return window.__sim.pickTile(camera.width / 2, camera.height / 2);
  });

test('eightIdenticalEventsAreOneLineWithACount', async ({ page }) => {
  await openGame(page);
  await eightFires(page);
  const lines = page.getByTestId('toasts').getByTestId('toast');
  await expect(lines).toHaveCount(1);
  await expect(lines.first()).toHaveAccessibleName('Fire emergency ×8');
  await expect(lines.first().locator('.hud-toast-count')).toHaveText('×8');
});

test('clickingAToastTakesTheCameraToTheEvent', async ({ page }) => {
  await openGame(page);
  await page.evaluate(() => window.__sim.fitMap());
  expect(await centreTile(page)).not.toEqual(FIRE);
  await eightFires(page);
  await page.getByTestId('toast').filter({ hasText: 'Fire emergency' }).click();
  await expect.poll(() => centreTile(page)).toEqual(FIRE);
});

test('toastLinesExpire', async ({ page }) => {
  await openGame(page);
  await eightFires(page);
  await expect(page.getByTestId('toast')).toHaveCount(1);
  // A fire's line lives five real seconds from its last occurrence (emergencies.ts `startEmergency`).
  await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 10_000 });
  // states.md: the empty feed is a container without lines.
  await expect(page.getByTestId('toasts')).toBeAttached();
});
