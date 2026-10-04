import {expect, test, type Page} from '@playwright/test';
import {CityLife} from '../packages/app/src/city/life/world';
import {createGameSave} from '../packages/app/src/game/save';
import {createRegion} from '../packages/app/src/region/model/world';
import {serializeRegion} from '../packages/app/src/region/model/save';

test.use({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
test.describe.configure({timeout: 90_000});

test.beforeEach(async ({page}) => {
  const save = createGameSave(
    'native-prototype',
    'Город у воды',
    new CityLife('689856').save(),
  );

  await page.goto('/');
  await page.evaluate(async saved => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('simcity-regions', 1);

      open.onupgradeneeded = () => open.result.createObjectStore('regions');
      open.onerror = () => reject(open.error ?? new Error('Open failed'));

      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction('regions', 'readwrite');

        transaction.objectStore('regions').put(JSON.stringify(saved), saved.id);

        transaction.oncomplete = () => {
          db.close();
          resolve();
        };

        transaction.onerror = () => {
          db.close();
          reject(transaction.error ?? new Error('Write failed'));
        };
      };
    });
  }, save);
});

async function openPrototypeSave(page: Page): Promise<void> {
  await page.locator('#menu-load-region').click();
  await page.locator('.save-card').click();
}

async function records(page: Page) {
  return page.evaluate(async () => {
    return new Promise<Array<{id: string; value: unknown}>>(
      (resolve, reject) => {
        const open = indexedDB.open('simcity-regions', 1);

        open.onupgradeneeded = () => open.result.createObjectStore('regions');
        open.onerror = () => reject(open.error ?? new Error('Open failed'));

        open.onsuccess = () => {
          const db = open.result;
          const transaction = db.transaction('regions');
          const request = transaction.objectStore('regions').openCursor();
          const result: Array<{id: string; value: unknown}> = [];

          request.onsuccess = () => {
            const cursor = request.result;

            if (cursor) {
              if (typeof cursor.key === 'string') {
                result.push({
                  id: cursor.key,
                  value: cursor.value as unknown,
                });
              }

              cursor.continue();
            }
          };

          transaction.oncomplete = () => {
            db.close();
            resolve(result);
          };

          transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? new Error('Read failed'));
          };
        };
      },
    );
  });
}

async function startNativeWorld(page: Page) {
  await page.goto('/');
  await openPrototypeSave(page);
  await expect(page.locator('#city')).toHaveAttribute(
    'data-life-ready',
    'true',
  );
  await expect(page.locator('#main-menu')).toBeHidden();
  await page.evaluate(() => window.__cityLife.pause());
}

test('root starts one native world and resumes its exact state and camera', async ({
  page,
}) => {
  const workers: string[] = [];
  const errors: string[] = [];

  page.on('worker', worker => workers.push(worker.url()));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const origin = await page.evaluate(() => performance.timeOrigin);

  expect(workers).toHaveLength(0);
  await openPrototypeSave(page);
  await expect(page.locator('#city')).toHaveAttribute(
    'data-life-ready',
    'true',
  );
  await expect(page.locator('#main-menu')).toBeHidden();
  await expect(page.locator('#city')).toBeVisible();
  await expect(page.locator('#life-open')).toBeVisible();
  await expect(
    page.getByRole('button', {name: 'Ночь', exact: true}),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
  expect(workers).toHaveLength(1);
  expect(workers[0]).toContain('/city/life/worker.ts');
  await page.evaluate(() => window.__cityLife.pause());
  await page.evaluate(() => window.__cityLife.advance(24));
  const before = await page.evaluate(() => window.__cityLife.save());

  expect(before.population.people.length).toBeGreaterThanOrEqual(540);
  expect(before.population.cars.length).toBeGreaterThan(0);
  expect(before.harbor.cargo.length).toBeGreaterThan(0);
  await page.locator('#life-open').click();
  await page.getByLabel('Житель города', {exact: true}).selectOption('0');
  await expect(page.locator('#resident-name')).toHaveText(
    before.population.people[0]!.name,
  );
  await page.locator('#life-close').click();
  await page.locator('#city').focus();
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(async () => {
      const before = await page.evaluate(() =>
        window.__cityLife.project(0, 0, 0),
      );

      await page.waitForTimeout(100);
      const after = await page.evaluate(() =>
        window.__cityLife.project(0, 0, 0),
      );

      return Math.hypot(after.x - before.x, after.y - before.y);
    })
    .toBeLessThan(0.001);
  const camera = await page.evaluate(() => window.__cityLife.project(0, 0, 0));

  await page.getByRole('link', {name: 'В главное меню', exact: true}).click();
  await expect(page.locator('#main-menu')).toBeVisible();
  await expect(page.locator('#city')).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.__cityLife.save())).toEqual(before);
  await page.locator('#resume-region').click();
  await expect(page.locator('#main-menu')).toBeHidden();
  await expect(page.locator('#city')).toBeVisible();
  expect(await page.evaluate(() => window.__cityLife.save())).toEqual(before);
  expect(await page.evaluate(() => window.__cityLife.project(0, 0, 0))).toEqual(
    camera,
  );
  expect(workers).toHaveLength(1);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
  expect(errors).toEqual([]);
});

test('native Save appears in the main menu and loads the saved moving world', async ({
  page,
}) => {
  const workers: string[] = [];

  page.on('worker', worker => workers.push(worker.url()));
  await startNativeWorld(page);
  await page.evaluate(() => window.__cityLife.advance(24));
  const saved = await page.evaluate(() => window.__cityLife.save());

  await page.locator('#life-open').click();
  await page.locator('#life-save').click();
  await expect(page.locator('#life-save-status')).toContainText('сохранён');
  const stored = await records(page);

  expect(stored).toHaveLength(1);
  expect(typeof stored[0]!.value).toBe('string');
  const envelope: unknown = JSON.parse(String(stored[0]!.value));

  expect(envelope).toMatchObject({
    kind: 'simcity-game',
    version: 1,
    id: stored[0]!.id,
    seed: '689856',
    world: JSON.parse(JSON.stringify(saved)) as unknown,
  });
  await page.evaluate(() => window.__cityLife.advance(12));
  expect(
    (await page.evaluate(() => window.__cityLife.save())).tick,
  ).toBeGreaterThan(saved.tick);
  await page.locator('#life-close').click();
  await page.getByRole('link', {name: 'В главное меню', exact: true}).click();
  await page.locator('#menu-load-region').click();
  await expect(page.locator('.save-card')).toHaveCount(1);
  await expect(page.locator('.save-card')).toBeEnabled();
  await expect(page.locator('.save-card')).toContainText('689856');
  await page.locator('.save-card').click();
  await expect(page.locator('#main-menu')).toBeHidden();
  await expect(page.locator('#city')).toHaveAttribute(
    'data-life-ready',
    'true',
  );
  expect(await page.evaluate(() => window.__cityLife.save())).toEqual(saved);
  expect(await records(page)).toEqual(stored);
  expect(workers).toHaveLength(1);
  expect(new URL(page.url()).pathname).toBe('/');
});

test('canceling the native in-game load preserves the unsaved world', async ({
  page,
}) => {
  const workers: string[] = [];

  page.on('worker', worker => workers.push(worker.url()));
  await startNativeWorld(page);
  await page.locator('#life-open').click();
  await page.locator('#life-save').click();
  await expect(page.locator('#life-save-status')).toContainText('сохранён');
  const stored = await records(page);

  await page.evaluate(() => window.__cityLife.advance(24));
  const unsaved = await page.evaluate(() => window.__cityLife.save());

  await page.locator('#life-load').click();
  await expect(page.locator('#native-load-dialog')).toBeVisible();
  await expect(page.locator('#native-save-select option')).toHaveCount(1);
  await page.locator('#native-load-dialog [data-action="close"]').click();
  await expect(page.locator('#native-load-dialog')).toBeHidden();
  await expect(page.locator('#life-save-status')).toContainText('отменена');
  await expect(page.locator('#main-menu')).toBeHidden();
  expect(await page.evaluate(() => window.__cityLife.save())).toEqual(unsaved);
  expect(await records(page)).toEqual(stored);
  expect(workers).toHaveLength(1);
});

test('legacy regions remain visible and retain their exact stored bytes', async ({
  page,
}) => {
  const legacy = createRegion('legacy-native-root', '689856');
  const raw = serializeRegion({
    ...legacy,
    nextId: 2,
    settlements: [
      {id: 'settlement-1', name: 'Приозёрск', center: {x: 0, z: -1500}},
    ],
  });

  await startNativeWorld(page);
  await page.evaluate(() => window.__cityLife.advance(12));
  const before = await page.evaluate(() => window.__cityLife.save());
  const initialRecords = await records(page);

  await page.evaluate(async value => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('simcity-regions', 1);

      open.onupgradeneeded = () => open.result.createObjectStore('regions');
      open.onerror = () => reject(open.error ?? new Error('Open failed'));

      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction('regions', 'readwrite');

        transaction.objectStore('regions').put(value, 'legacy-native-root');

        transaction.oncomplete = () => {
          db.close();
          resolve();
        };

        transaction.onerror = () => {
          db.close();
          reject(transaction.error ?? new Error('Write failed'));
        };
      };
    });
  }, raw);
  await page.getByRole('link', {name: 'В главное меню', exact: true}).click();
  await page.locator('#menu-load-region').click();
  const card = page.getByRole('button', {name: /Приозёрск.*адаптация/});

  await expect(card).toBeVisible();
  await expect(card).toBeDisabled();
  await expect(card).toContainText(/адаптац/i);
  const stored = await records(page);

  expect(stored).toHaveLength(initialRecords.length + 1);
  expect(stored).toEqual(
    expect.arrayContaining([
      ...initialRecords,
      {id: 'legacy-native-root', value: raw},
    ]),
  );
  await page.keyboard.press('Escape');
  await page.locator('#resume-region').click();
  await expect(page.locator('#main-menu')).toBeHidden();
  expect(await page.evaluate(() => window.__cityLife.save())).toEqual(before);
  expect(await records(page)).toEqual(stored);
});

test('cold loading never overwrites the selected record with a generated initial world', async ({
  page,
}) => {
  await startNativeWorld(page);
  await page.evaluate(() => window.__cityLife.advance(24));
  await page.locator('#life-open').click();
  await page.locator('#life-save').click();
  await expect(page.locator('#life-save-status')).toContainText(
    'Город сохранён',
  );
  const saved = await records(page);

  await page.reload();
  await expect(page.locator('#city')).toHaveAttribute(
    'data-life-ready',
    'true',
  );
  await expect(page.locator('#main-menu')).toBeHidden();
  expect(JSON.stringify(await records(page)) === JSON.stringify(saved)).toBe(
    true,
  );
});

test('the native city has a regional overview and keyboard camera controls', async ({
  page,
}) => {
  await startNativeWorld(page);
  const before = await page.evaluate(() => window.__cityLife.save());

  await page.locator('#native-region-overview').click();
  await page.locator('#city').focus();
  await page.waitForTimeout(180);
  const initial = await page.evaluate(() => window.__cityLife.project(0, 0, 1));

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(200);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(180);
  const moved = await page.evaluate(() => window.__cityLife.project(0, 0, 1));

  expect(Math.hypot(initial.x - moved.x, initial.y - moved.y)).toBeGreaterThan(
    1,
  );
  await page.keyboard.down('KeyQ');
  await page.waitForTimeout(200);
  await page.keyboard.up('KeyQ');
  await page.waitForTimeout(180);
  const rotated = await page.evaluate(() =>
    window.__cityLife.project(200, 200, 1),
  );

  expect(Number.isFinite(rotated.x) && Number.isFinite(rotated.y)).toBe(true);
  expect(await page.evaluate(() => window.__cityLife.save())).toEqual(before);
});

test('save deletion keeps the live world and honors cancel before deleting one record', async ({
  page,
}) => {
  await startNativeWorld(page);
  const world = await page.evaluate(() => window.__cityLife.save());

  await page.getByRole('link', {name: 'В главное меню', exact: true}).click();
  await page.locator('#menu-load-region').click();
  const before = await records(page);

  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('.save-delete').click();
  expect(await records(page)).toEqual(before);
  await expect(page.locator('.save-card')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.save-delete').click();
  await expect(page.locator('#saves-status')).toHaveText('Сохранений пока нет');
  expect(await records(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await page.locator('#resume-region').click();
  await expect(page.locator('#main-menu')).toBeHidden();
  expect(await page.evaluate(() => window.__cityLife.save())).toEqual(world);
});
