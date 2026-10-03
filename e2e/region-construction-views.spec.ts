import {writeFile} from 'node:fs/promises';
import {expect, test, type Page} from '@playwright/test';
import {serializeRegion} from '../packages/app/src/region/model/save';
import type {RegionState} from '../packages/app/src/region/model/types';
import {createConstructionFixture} from './helpers/regionConstructionFixture';

test.use({viewport: {width: 1440, height: 1000}});

async function snapshot(page: Page): Promise<RegionState> {
  return page.evaluate(() => window.__regionEditor!.snapshot());
}

async function prepareSave(page: Page, state: RegionState): Promise<void> {
  await page.evaluate(
    record =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('simcity-regions', 1);

        open.onupgradeneeded = () => open.result.createObjectStore('regions');
        open.onerror = () =>
          reject(open.error ?? new Error('Cannot open saves'));

        open.onsuccess = () => {
          const db = open.result;
          const transaction = db.transaction('regions', 'readwrite');

          transaction.objectStore('regions').put(record.value, record.id);

          transaction.oncomplete = () => {
            db.close();
            resolve();
          };

          transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? new Error('Cannot prepare save'));
          };
        };
      }),
    {id: state.id, value: serializeRegion(state)},
  );
}

for (const degrees of [30, -35]) {
  test(`construction completes on a ${degrees} degree road with the same building and camera`, async ({
    page,
  }) => {
    const stored = createConstructionFixture(degrees);
    const building = stored.life.buildings[0]!;
    const lot = stored.parcels[0]!;
    const errors: string[] = [];

    expect(stored.life.buildings).toHaveLength(1);
    expect(building.stage).toBe('constructing');
    expect(building.progressSeconds).toBeGreaterThan(0);
    expect(building.progressSeconds).toBeLessThan(building.durationSeconds);
    expect(lot.heading).toBeCloseTo((-degrees * Math.PI) / 180, 3);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await prepareSave(page, stored);
    await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
    await expect(page.locator('.save-card')).toHaveCount(1);
    await page.locator('.save-card').click();
    await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
    expect(await snapshot(page)).toEqual(stored);
    await page.getByRole('button', {name: 'Режим региона'}).click();
    await page
      .getByRole('button', {
        name: `Открыть город ${stored.settlements[0]!.name}`,
        exact: true,
      })
      .click();

    // Pan and zoom only through the controls that are available to the player.
    const pixel = await page.evaluate(
      p => window.__regionEditor!.project(p),
      lot.center,
    );

    await page.mouse.move(pixel.x, pixel.y);
    await page.mouse.down();
    await page.mouse.move(720, 500, {steps: 10});
    await page.mouse.up();
    await page
      .getByRole('button', {name: 'Приблизить', exact: true})
      .click({clickCount: 3});
    // OrbitControls retains pan inertia; wait for its visible projection to settle.
    const framed = await page.evaluate(
      p =>
        new Promise<{x: number; y: number}>(resolve => {
          let previous = window.__regionEditor!.project(p);
          let stable = 0;
          const frame = () => {
            const current = window.__regionEditor!.project(p);

            stable =
              Math.hypot(current.x - previous.x, current.y - previous.y) <
              0.0001
                ? stable + 1
                : 0;
            previous = current;

            if (stable >= 12) {
              resolve(current);
            } else {
              requestAnimationFrame(frame);
            }
          };

          requestAnimationFrame(frame);
        }),
      lot.center,
    );

    expect(framed.x).toBeGreaterThan(400);
    expect(framed.x).toBeLessThan(1200);
    expect(framed.y).toBeGreaterThan(220);
    expect(framed.y).toBeLessThan(800);
    await page.screenshot({
      path: test.info().outputPath('construction-before.png'),
    });
    await page.getByRole('button', {name: 'Запустить симуляцию'}).click();
    await expect
      .poll(async () => (await snapshot(page)).life.elapsedSeconds)
      .toBeGreaterThan(stored.life.elapsedSeconds + 15);
    const moving = await snapshot(page);

    expect(moving.life.buildings[0]!.stage).toBe('constructing');
    expect(moving.life.buildings[0]!.progressSeconds).toBeGreaterThan(
      building.progressSeconds,
    );
    await page.screenshot({
      path: test.info().outputPath('construction-moving.png'),
    });
    await page.getByLabel('Скорость симуляции').selectOption('120');
    await expect
      .poll(async () => (await snapshot(page)).life.buildings[0]!.stage, {
        timeout: 20_000,
      })
      .toBe('ready');
    await page.getByRole('button', {name: 'Приостановить симуляцию'}).click();
    await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
    await expect(page.locator('#region-status')).toContainText('сохранён');
    const completed = await snapshot(page);

    expect(completed.life.buildings[0]).toMatchObject({
      id: building.id,
      lotId: building.lotId,
      stage: 'ready',
      progressSeconds: building.durationSeconds,
    });
    expect(completed.parcels[0]).toEqual(lot);
    const finalFrame = await page.evaluate(
      p => window.__regionEditor!.project(p),
      lot.center,
    );

    expect(finalFrame.x).toBeCloseTo(framed.x, 1);
    expect(finalFrame.y).toBeCloseTo(framed.y, 1);
    await page.screenshot({
      path: test.info().outputPath('construction-complete.png'),
    });
    await writeFile(
      test.info().outputPath('construction-evidence.json'),
      JSON.stringify(
        {degrees, framed, finalFrame, before: stored, moving, completed},
        null,
        2,
      ),
    );
    expect(errors).toEqual([]);
  });
}
