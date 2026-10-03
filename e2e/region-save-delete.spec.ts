import {expect, test, type Page} from '@playwright/test';

async function seedSaves(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('simcity-regions', 1);

      request.onupgradeneeded = () =>
        request.result.createObjectStore('regions');
      request.onerror = () => reject(request.error ?? new Error('Open failed'));

      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('regions', 'readwrite');

        transaction.objectStore('regions').put('first damaged save', 'first');
        transaction.objectStore('regions').put('second damaged save', 'second');

        transaction.oncomplete = () => {
          db.close();
          resolve();
        };

        transaction.onerror = () =>
          reject(transaction.error ?? new Error('Transaction failed'));
      };
    });
  });
}

async function keys(page: Page) {
  return page.evaluate(
    async () =>
      new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = indexedDB.open('simcity-regions', 1);

        request.onerror = () =>
          reject(request.error ?? new Error('Open failed'));

        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('regions');
          const result = transaction.objectStore('regions').getAllKeys();

          result.onsuccess = () => resolve(result.result);
          transaction.oncomplete = () => db.close();
        };
      }),
  );
}

for (const location of ['menu', 'region']) {
  test(`${location}: cancel keeps saves, confirmation removes only selected save and last deletion shows empty state`, async ({
    page,
  }) => {
    await page.goto(location === 'menu' ? '/' : '/?seed=689856');

    if (location === 'region') {
      await expect(page.locator('#region')).toHaveAttribute(
        'data-ready',
        'true',
      );
    }

    await seedSaves(page);
    await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
    const remove =
      location === 'menu'
        ? page.locator('.save-delete').first()
        : page.locator('#delete-save');

    await expect(remove).toBeVisible({timeout: 2000});
    page.once('dialog', dialog => {
      expect(dialog.message()).toContain('first');

      return dialog.dismiss();
    });
    await remove.click();
    expect(await keys(page)).toEqual(['first', 'second']);
    page.once('dialog', dialog => {
      expect(dialog.message()).toContain('повреждённое');

      return dialog.accept();
    });
    await remove.click();
    await expect.poll(() => keys(page)).toEqual(['second']);

    if (location === 'menu') {
      await expect(page.locator('.save-card')).toHaveCount(1);
    } else {
      await expect(page.locator('#save-select option')).toHaveCount(1);
    }

    page.once('dialog', dialog => dialog.accept());
    await remove.click();
    await expect.poll(() => keys(page)).toEqual([]);
    await expect(
      page.locator(location === 'menu' ? '#saves-status' : '#save-empty'),
    ).toContainText(/нет/);
    await page.screenshot({
      path: test.info().outputPath(`${location}-empty.png`),
    });
  });

  test(`${location}: failed delete preserves record and offers retry`, async ({
    page,
  }) => {
    await page.goto(location === 'menu' ? '/' : '/?seed=689856');

    if (location === 'region') {
      await expect(page.locator('#region')).toHaveAttribute(
        'data-ready',
        'true',
      );
    }

    await seedSaves(page);
    await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
    const remove =
      location === 'menu'
        ? page.locator('.save-delete').first()
        : page.locator('#delete-save');

    await expect(remove).toBeVisible({timeout: 2000});
    await page.evaluate(() => {
      IDBObjectStore.prototype.delete = function () {
        this.transaction.abort();
        throw new Error('Storage failure');
      };
    });
    page.once('dialog', dialog => dialog.accept());
    await remove.click();
    await expect(
      page.locator(location === 'menu' ? '#saves-status' : '#save-feedback'),
    ).toContainText('Не удалось удалить');
    expect(await keys(page)).toEqual(['first', 'second']);
    await expect(remove).toBeEnabled();
    await page.screenshot({
      path: test.info().outputPath(`${location}-failure.png`),
    });
  });
}
