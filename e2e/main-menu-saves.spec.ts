import {expect, test, type Page} from '@playwright/test';
import {serializeRegion} from '../packages/app/src/region/model/save';
import {createRegionalLife} from '../packages/app/src/region/model/life/state';

async function putRecords(
  page: Page,
  records: Array<{id: string; value: unknown}>,
) {
  await page.evaluate(async entries => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('simcity-regions', 1);

      open.onupgradeneeded = () => open.result.createObjectStore('regions');
      open.onerror = () => reject(open.error ?? new Error('Open failed'));

      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction('regions', 'readwrite');

        for (const entry of entries) {
          transaction.objectStore('regions').put(entry.value, entry.id);
        }

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
  }, records);
}

test.use({viewport: {width: 1280, height: 800}});

test('saved town opens from main menu with keyboard and restores exact state', async ({
  page,
}) => {
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#main-menu')).toBeHidden();
  const pixel = await page.evaluate(() =>
    window.__regionEditor!.project(window.__regionEditor!.terrainProbe().land),
  );

  await page
    .getByRole('button', {name: 'Основать поселение', exact: true})
    .click();
  await page.locator('#settlement-name').fill('Приозёрск');
  await page.mouse.click(pixel.x, pixel.y);
  await expect(page.locator('#city-name')).toHaveText('Приозёрск');
  const before = await page.evaluate(() => window.__regionEditor!.snapshot());

  await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.locator('#region-status')).toContainText('сохранён');
  await page.getByRole('link', {name: 'В главное меню'}).click();
  const load = page.getByRole('button', {name: 'Загрузить', exact: true});

  await load.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#saved-regions')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  const save = page.getByRole('button', {name: /Приозёрск.*689856/});

  await save.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#main-menu')).toBeHidden();
  expect(await page.evaluate(() => window.__regionEditor!.snapshot())).toEqual(
    before,
  );
});

test('empty list and Escape do not accidentally create a region', async ({
  page,
}) => {
  await page.goto('/');
  const load = page.getByRole('button', {name: 'Загрузить', exact: true});

  await load.click();
  await expect(page.getByText('Сохранений пока нет')).toBeVisible();
  await page.locator('#saves-title').click();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/$/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#saved-regions')).toBeHidden();
  await expect(load).toBeFocused();
});

test('corrupt records remain visible but unavailable', async ({page}) => {
  await page.goto('/');
  await putRecords(page, [{id: 'broken', value: 'not JSON'}]);
  await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
  await expect(
    page.getByRole('button', {name: /Несовместимое или повреждённое/}),
  ).toBeDisabled();
  await expect(page).toHaveURL(/\/$/);
});

test('changed records fail safely, refresh retries and long lists remain usable', async ({
  page,
}) => {
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#main-menu')).toBeHidden();
  const state = await page.evaluate(() => window.__regionEditor!.snapshot());

  await page.getByRole('link', {name: 'В главное меню'}).click();
  const records = Array.from({length: 12}, (_, index) => {
    const id = `saved-${String(index).padStart(2, '0')}`;
    const name = `Новый город ${index + 1} — длинное название поселения у северного берега`;

    return {
      id,
      value: serializeRegion({
        ...state,
        id,
        nextId: 2,
        settlements: [{id: 'settlement-1', name, center: {x: 0, z: -1500}}],
      }),
    };
  });

  await putRecords(page, records);
  await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
  await expect(page.locator('.save-card')).toHaveCount(12);
  expect(
    await page
      .locator('#save-list')
      .evaluate(element => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole('link', {name: 'Город у воды — прототип', exact: true}),
  ).toBeInViewport();
  await page.screenshot({
    path: test.info().outputPath('main-menu-saves-light.png'),
  });
  await page.emulateMedia({colorScheme: 'dark'});
  await page.screenshot({
    path: test.info().outputPath('main-menu-saves-dark.png'),
  });
  await putRecords(page, [{id: records[0]!.id, value: null}]);
  await page.locator('.save-card').first().click();
  await expect(page.locator('#saves-status')).toContainText(
    'Не удалось открыть сохранение',
  );
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('button', {name: 'Обновить список сохранений'}).click();
  await expect(page.locator('.save-card').first()).toBeDisabled();
  await putRecords(page, [records[0]!]);
  await page.getByRole('button', {name: 'Обновить список сохранений'}).click();
  await expect(page.locator('.save-card').first()).toBeEnabled();
  await page.locator('.save-card').first().click();
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#main-menu')).toBeHidden();
  expect(
    (await page.evaluate(() => window.__regionEditor!.snapshot())).id,
  ).toBe(records[0]!.id);
});

test('storage errors allow retry and a closed pending list stays closed', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(() =>
    Object.defineProperty(indexedDB, 'open', {
      configurable: true,
      value: () => {
        throw new Error('Storage unavailable');
      },
    }),
  );
  await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
  await expect(page.locator('#saves-status')).toContainText(
    'Не удалось прочитать сохранения',
  );
  await page.evaluate(() => Reflect.deleteProperty(indexedDB, 'open'));
  await page.getByRole('button', {name: 'Обновить список сохранений'}).click();
  await expect(page.locator('#saves-status')).toContainText(
    'Сохранений пока нет',
  );
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const original = indexedDB.open.bind(indexedDB);

    indexedDB.open = (...args) => {
      const request = original(...args);

      Object.defineProperty(request, 'onsuccess', {
        set(callback: (event: Event) => void) {
          request.addEventListener('success', event => {
            setTimeout(() => {
              callback(event);
              document.body.dataset.storageResponse = 'done';
            }, 150);
          });
        },
      });

      return request;
    };
  });
  await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveAttribute(
    'data-storage-response',
    'done',
  );
  await expect(page.locator('#saved-regions')).toBeHidden();
  await expect(
    page.getByRole('button', {name: 'Загрузить', exact: true}),
  ).toHaveAttribute('aria-expanded', 'false');
});

test('duplicate names and seeds show distinct save IDs and load the chosen state', async ({
  page,
}) => {
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#main-menu')).toBeHidden();
  const state = await page.evaluate(() => window.__regionEditor!.snapshot());

  await page.getByRole('link', {name: 'В главное меню'}).click();
  const first = {
    ...state,
    id: 'abcdefgh-first',
    cash: 111111,
    life: createRegionalLife(111111),
  };
  const second = {
    ...state,
    id: 'abcdefgh-second',
    cash: 222222,
    life: createRegionalLife(222222),
  };
  const unique = {
    ...state,
    id: 'unique-record',
    nextId: 2,
    settlements: [
      {
        id: 'settlement-1',
        name: 'Единственный город',
        center: {x: 0, z: -1500},
      },
    ],
  };

  await putRecords(
    page,
    [first, second, unique].map(saved => ({
      id: saved.id,
      value: serializeRegion(saved),
    })),
  );
  await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
  const firstRow = page.getByRole('button', {
    name: /Пустой регион.*689856.*Сохранение abcdefgh-f/,
  });
  const secondRow = page.getByRole('button', {
    name: /Пустой регион.*689856.*Сохранение abcdefgh-s/,
  });

  await expect(firstRow).toBeVisible({timeout: 1000});
  await expect(secondRow).toBeVisible();
  await expect(
    page.getByRole('button', {name: /Единственный город/}),
  ).not.toContainText('Сохранение');
  await secondRow.click();
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#main-menu')).toBeHidden();
  expect(await page.evaluate(() => window.__regionEditor!.snapshot())).toEqual(
    second,
  );
});
