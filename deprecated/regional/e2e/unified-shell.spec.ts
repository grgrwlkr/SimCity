import {expect, test} from '@playwright/test';
import {createRegion} from '../../../packages/app/src/region/model/world';
import {serializeRegion} from '../../../packages/app/src/region/model/save';

test('root menu creates, pauses, resumes and loads in one document and one live worker', async ({
  page,
}) => {
  const workers: string[] = [];

  page.on('worker', worker => workers.push(worker.url()));
  await page.goto('/');
  const origin = await page.evaluate(() => performance.timeOrigin);

  expect(workers).toHaveLength(0);
  await page.getByRole('link', {name: 'Создать регион', exact: true}).click();
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  expect(new URL(page.url()).pathname).toBe('/');
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
  const point = await page.evaluate(() =>
    window.__regionEditor!.project(window.__regionEditor!.terrainProbe().land),
  );

  await page
    .getByRole('button', {name: 'Основать поселение', exact: true})
    .click();
  await page.locator('#settlement-name').fill('Домой');
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('#city-name')).toHaveText('Домой');
  await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.locator('#region-status')).toContainText('сохранён');
  const before = await page.evaluate(() => window.__regionEditor!.snapshot());
  const camera = await page.evaluate(() =>
    window.__regionEditor!.project({x: 0, z: 0}),
  );

  await page.getByRole('button', {name: 'Запустить симуляцию'}).click();
  await page.getByRole('link', {name: 'В главное меню'}).click();
  await expect(page.locator('#main-menu')).toBeVisible();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(200);
  await page.keyboard.up('KeyW');
  const paused = await page.evaluate(() => window.__regionEditor!.snapshot());

  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__regionEditor!.snapshot())).toEqual(
    paused,
  );
  await page.getByRole('button', {name: 'Продолжить', exact: true}).click();
  await expect(page.locator('#main-menu')).toBeHidden();
  expect(
    await page.evaluate(() => window.__regionEditor!.project({x: 0, z: 0})),
  ).toEqual(camera);
  await expect(
    page.getByRole('button', {name: 'Запустить симуляцию'}),
  ).toBeVisible();
  expect(workers).toHaveLength(1);
  await page.getByRole('link', {name: 'В главное меню'}).click();
  await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
  await page.locator('.save-card').click();
  await expect(page.locator('#main-menu')).toBeHidden();
  expect(await page.evaluate(() => window.__regionEditor!.snapshot())).toEqual(
    before,
  );
  expect(workers).toHaveLength(1);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
});

test('legacy region URL redirects to root and preserves seed and hash', async ({
  page,
}) => {
  await page.goto('/region/?seed=legacy-seed#camera');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).searchParams.get('seed')).toBe('legacy-seed');
  expect(new URL(page.url()).hash).toBe('#camera');
});

test('deleting the current save keeps the live region resumable and it can be saved again', async ({
  page,
}) => {
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  const before = await page.evaluate(() => window.__regionEditor!.snapshot());

  await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.locator('#region-status')).toContainText('сохранён');
  await page.getByRole('link', {name: 'В главное меню'}).click();
  await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.save-delete').click();
  await expect(page.locator('#saves-status')).toHaveText('Сохранений пока нет');
  await page.getByRole('button', {name: 'Продолжить', exact: true}).click();
  await expect(page.locator('#main-menu')).toBeHidden();
  expect(await page.evaluate(() => window.__regionEditor!.snapshot())).toEqual(
    before,
  );
  await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.locator('#region-status')).toContainText('сохранён');
  await page.goto(`/region/?seed=689856&regionId=${before.id}#restored`);
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).hash).toBe('#restored');
  expect(await page.evaluate(() => window.__regionEditor!.snapshot())).toEqual(
    before,
  );
});

test('a pending menu save read cannot replace the resumed in-memory world', async ({
  page,
}) => {
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.locator('#region-status')).toContainText('сохранён');
  const point = await page.evaluate(() =>
    window.__regionEditor!.project(window.__regionEditor!.terrainProbe().land),
  );

  await page
    .getByRole('button', {name: 'Основать поселение', exact: true})
    .click();
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('#settlement-count')).toHaveText('1');
  const unsaved = await page.evaluate(() => window.__regionEditor!.snapshot());

  await page.getByRole('link', {name: 'В главное меню'}).click();
  await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
  await expect(page.locator('.save-card')).toBeVisible();
  await page.evaluate(() => {
    const original = indexedDB.open.bind(indexedDB);

    indexedDB.open = (...args) => {
      const request = original(...args);

      Object.defineProperty(request, 'onsuccess', {
        set(callback: (event: Event) => void) {
          request.addEventListener('success', event => {
            setTimeout(() => {
              callback(event);
              document.body.dataset.storageReturned = 'true';
            }, 400);
          });
        },
      });

      return request;
    };
  });
  await page.locator('.save-card').click();
  await page.getByRole('button', {name: 'Продолжить', exact: true}).click();
  await expect(page.locator('body')).toHaveAttribute(
    'data-storage-returned',
    'true',
  );
  await expect(page.locator('#main-menu')).toBeHidden();
  expect(await page.evaluate(() => window.__regionEditor!.snapshot())).toEqual(
    unsaved,
  );
});

test('failed runtime import clears the save list busy state and reports the failure', async ({
  page,
}) => {
  await page.goto('/');
  const save = serializeRegion(createRegion('runtime-failure', '689856'));

  await page.evaluate(async raw => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('simcity-regions', 1);

      request.onupgradeneeded = () =>
        request.result.createObjectStore('regions');
      request.onerror = () => reject(request.error ?? new Error('Open failed'));

      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('regions', 'readwrite');

        transaction.objectStore('regions').put(raw, 'runtime-failure');

        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
  }, save);
  await page.route('**/src/region/main.ts', route => route.abort());
  await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
  await page.locator('.save-card').click();
  await expect(page.locator('#shell-status')).not.toHaveText(
    'Открываем регион…',
  );
  await expect(page.locator('#saved-regions')).not.toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(page.locator('#saves-status')).toContainText(
    'Не удалось открыть регион',
  );
  await expect(page.locator('.save-card')).toHaveCount(1);
});
