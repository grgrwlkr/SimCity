import {randomUUID} from 'node:crypto';
import {expect, test, type Page} from '@playwright/test';
import {gridForLayout} from '../../app/src/city/cityGrid';
import {parseGameSave, type NativeGameSave} from '../../app/src/game/save';
import {readNativeRegionDocument} from '../../app/src/game/regionDocument';
import type {Point} from '../../app/src/region/model/types';
import {launchPackaged} from './launchPackaged';
import {
  RELEASE_APP,
  TEST_APP,
  buildInfoOf,
  makeInspectableClone,
  requireBuild,
} from './inspectableClone';

let APP = '';

test.beforeAll(async () => {
  requireBuild(TEST_APP);
  requireBuild(RELEASE_APP);
  const {test: isTest, ...tested} = buildInfoOf(TEST_APP);
  const {test: isRelease, ...release} = buildInfoOf(RELEASE_APP);

  expect({isTest, isRelease}).toEqual({isTest: true, isRelease: false});
  expect(tested).toEqual(release);
  APP = await makeInspectableClone(TEST_APP);
});

function activeId(page: Page): string {
  const id = new URL(page.url()).searchParams.get('regionId');

  if (!id) {
    throw new Error('The native root URL carries no game ID');
  }

  return id;
}

async function readSave(
  page: Page,
  id = activeId(page),
): Promise<NativeGameSave> {
  const raw = await page.evaluate(async id => {
    return new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open('simcity-regions', 1);

      open.onerror = () => reject(open.error ?? new Error('Open failed'));

      open.onsuccess = () => {
        const db = open.result;
        const request = db
          .transaction('regions')
          .objectStore('regions')
          .get(id);

        request.onsuccess = () => {
          db.close();
          resolve(request.result as unknown);
        };

        request.onerror = () => {
          db.close();
          reject(request.error ?? new Error('Read failed'));
        };
      };
    });
  }, id);

  return parseGameSave(raw);
}

async function writeCheckpoint(
  page: Page,
  save: NativeGameSave,
): Promise<void> {
  await page.evaluate(async save => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('simcity-regions', 1);

      open.onerror = () => reject(open.error ?? new Error('Open failed'));

      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction('regions', 'readwrite');

        transaction.objectStore('regions').put(JSON.stringify(save), save.id);

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
}

function documentOf(save: NativeGameSave) {
  if (save.world.version !== 3) {
    throw new Error('The root region is not an authored native world');
  }

  const document = readNativeRegionDocument(
    save.world.definition.metadata?.['regionDocument'],
  );

  if (!document) {
    throw new Error('The native region document is missing');
  }

  return document;
}

async function overview(page: Page): Promise<void> {
  await page.locator('#native-region-editor [data-mode="region"]').click();
  await page.locator('#top-view').click();
  await page.locator('#native-region-editor [data-action="overview"]').click();
  await page.evaluate(
    () =>
      new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** Public top-view/overview controls give pointer input a fixed orientation and scale. */
async function clickGround(page: Page, point: Point): Promise<void> {
  const saved = await readSave(page);

  if (saved.world.version !== 3) {
    throw new Error('Ground input requires the authored native layout');
  }

  const bounds = gridForLayout(saved.world.definition.layout).bounds;
  const box = await page.locator('#city').boundingBox();

  if (!box) {
    throw new Error('The native canvas has no screen bounds');
  }

  const aspect = box.width / box.height;
  const span = Math.max(
    bounds.maxZ - bounds.minZ + 64,
    (bounds.maxX - bounds.minX + 140) / aspect,
  );
  const pixel = {
    x: box.x + box.width * (0.5 + (point.x * 0.085) / (span * aspect)),
    y: box.y + box.height * (0.5 + (point.z * Math.cos(0.025) * 0.085) / span),
  };

  expect(
    await page.evaluate(
      point => document.elementFromPoint(point.x, point.y)?.id,
      pixel,
    ),
  ).toBe('city');
  await page.mouse.click(pixel.x, pixel.y);
  await expect(page.locator('#native-region-editor')).not.toHaveAttribute(
    'aria-busy',
    'true',
  );
}

async function saveThroughControls(page: Page): Promise<NativeGameSave> {
  if (!(await page.locator('#residents-panel').isVisible())) {
    await page.locator('#life-open').click();
  }

  await page.locator('#life-save').click();
  await expect(page.locator('#life-save-status')).toContainText(/сохранён/i);
  const saved = await readSave(page);

  await page.locator('#life-close').click();

  return saved;
}

test('the hidden packaged native root builds, restores and deletes an ordinary player save', async () => {
  const app = await launchPackaged(APP);
  const ownIds: string[] = [];
  let page: Page | undefined;

  try {
    page = await app.firstWindow({timeout: 30_000});
    const errors: string[] = [];
    const workers: string[] = [];

    page.on('pageerror', error => errors.push(error.message));
    page.on('worker', worker => workers.push(worker.url()));
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);

    expect(workers).toEqual([]);
    await page.getByRole('link', {name: 'Создать регион', exact: true}).click();
    await expect(page).toHaveURL(
      url =>
        url.protocol === 'app:' &&
        url.hostname === 'bundle' &&
        url.pathname === '/' &&
        url.searchParams.get('seed') === '689856' &&
        url.searchParams.has('regionId'),
    );
    ownIds.push(activeId(page));
    await expect(page.locator('#city')).toHaveAttribute(
      'data-life-ready',
      'true',
    );
    await expect(page.locator('#native-region-editor')).toBeVisible();
    await expect(page.locator('#life-count')).toHaveText('0');
    expect(workers).toHaveLength(1);
    expect(new URL(workers[0]!).protocol).toBe('app:');
    expect(new URL(workers[0]!).hostname).toBe('bundle');
    expect(new URL(workers[0]!).pathname).toMatch(/^\/assets\/worker-.+\.js$/);
    expect(
      await page.evaluate(
        () =>
          '__sim' in window ||
          '__regionEditor' in window ||
          '__cityLife' in window,
      ),
    ).toBe(false);
    await page.getByLabel('Остановить движение', {exact: true}).click();
    const settlementName = `Первое поселение ${randomUUID().slice(0, 8)}`;

    await overview(page);
    await page.locator('#native-town-name').fill(settlementName);
    await page.locator('#native-region-editor [data-tool="found"]').click();
    await clickGround(page, {x: -1300, z: -500});
    await expect(page.locator('#native-town-select')).toContainText(
      settlementName,
    );
    expect(documentOf(await readSave(page)).settlements).toHaveLength(1);
    const initialCash = await page
      .locator('#native-region-budget')
      .textContent();

    await expect(
      page.locator('#native-region-editor [data-mode="city"]'),
    ).toHaveAttribute('aria-pressed', 'true');
    await overview(page);
    await expect(
      page.locator('#native-region-editor [data-mode="region"]'),
    ).toHaveAttribute('aria-pressed', 'true');
    await page
      .locator('#native-region-editor [data-panel="region"] [data-tool="road"]')
      .click();
    await clickGround(page, {x: -1380, z: -410});
    await expect(page.locator('#native-editor-status')).toContainText(
      'Начало выбрано',
    );
    await clickGround(page, {x: -1250, z: -410});
    await expect(page.locator('#native-editor-status')).toHaveText(
      'Изменение применено.',
    );
    await expect(page.locator('#native-region-budget')).not.toHaveText(
      initialCash ?? '',
    );
    const saved = await saveThroughControls(page);
    const savedDocument = documentOf(saved);
    const savedCash = await page.locator('#native-region-budget').textContent();
    const checkpoint = {
      ...saved,
      id: `desktop-checkpoint-${randomUUID()}`,
      name: `${settlementName} — контрольная копия`,
    };

    expect(savedDocument.roads).toHaveLength(2);
    ownIds.push(checkpoint.id);
    // The editor autosaves edits. Retain a separate ordinary native record before changing its layout.
    await writeCheckpoint(page, checkpoint);
    await overview(page);
    await page.locator('#native-town-name').fill('Временное поселение');
    await page.locator('#native-region-editor [data-tool="found"]').click();
    await clickGround(page, {x: -1300, z: 500});
    await expect(page.locator('#native-town-select')).toContainText(
      'Временное поселение',
    );
    expect(documentOf(await readSave(page)).settlements).toHaveLength(2);
    await page.locator('#life-open').click();
    await page.locator('#life-load').click();
    await expect(page.locator('#native-load-dialog')).toBeVisible();
    await page.locator('#native-save-select').selectOption(checkpoint.id);
    await page.locator('#native-load-dialog [data-action="load"]').click();
    await expect(page.locator('#life-save-status')).toContainText(
      /загружен|восстановлен/i,
    );
    await expect(page.locator('#native-region-budget')).toHaveText(
      savedCash ?? '',
    );
    const restored = await readSave(page);

    expect(restored).toEqual(checkpoint);
    expect(documentOf(restored)).toEqual(savedDocument);
    expect((await saveThroughControls(page)).world).toEqual(checkpoint.world);
    await page.getByRole('link', {name: 'В главное меню', exact: true}).click();
    await expect(page.locator('#main-menu')).toBeVisible();
    await page.getByRole('button', {name: 'Продолжить', exact: true}).click();
    await expect(page.locator('#main-menu')).toBeHidden();
    await expect(page.locator('#native-region-budget')).toHaveText(
      savedCash ?? '',
    );
    expect(documentOf(await readSave(page))).toEqual(savedDocument);
    expect(workers).toHaveLength(1);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);

    await page.getByRole('link', {name: 'В главное меню', exact: true}).click();
    await page.locator('#menu-load-region').click();
    const row = page.locator('#save-list li').filter({
      has: page.getByRole('button', {
        name: new RegExp(settlementName + '.*контрольная копия'),
      }),
    });

    await expect(row).toHaveCount(1);
    page.once('dialog', dialog => dialog.dismiss());
    await row.locator('.save-delete').click();
    expect(await readSave(page, checkpoint.id)).toEqual(checkpoint);
    page.once('dialog', dialog => dialog.accept());
    await row.locator('.save-delete').click();
    await expect(row).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.locator('#resume-region').click();
    await expect(page.locator('#main-menu')).toBeHidden();
    await expect(page.locator('#native-town-select option')).toHaveCount(1);
    await expect(page.locator('#native-region-budget')).toHaveText(
      savedCash ?? '',
    );
    expect(workers).toHaveLength(1);
    expect(new URL(page.url()).pathname).toBe('/');
    await page.screenshot({
      path: test.info().outputPath('desktop-native-region.png'),
    });
    expect(errors).toEqual([]);
  } finally {
    try {
      if (page && !page.isClosed() && ownIds.length) {
        await page.evaluate(async ids => {
          await new Promise<void>((resolve, reject) => {
            const open = indexedDB.open('simcity-regions', 1);

            open.onerror = () => reject(open.error ?? new Error('Open failed'));

            open.onsuccess = () => {
              const db = open.result;
              const transaction = db.transaction('regions', 'readwrite');

              for (const id of ids) {
                transaction.objectStore('regions').delete(id);
              }

              transaction.oncomplete = () => {
                db.close();
                resolve();
              };

              transaction.onerror = () => {
                db.close();
                reject(transaction.error ?? new Error('Cleanup failed'));
              };
            };
          });
        }, ownIds);
      }
    } finally {
      await app.close();
    }
  }
});
