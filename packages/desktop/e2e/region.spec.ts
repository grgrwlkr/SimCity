import {randomUUID} from 'node:crypto';
import {expect, test} from '@playwright/test';
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

test('the hidden packaged region builds and restores a player layout through its controls', async () => {
  const app = await launchPackaged(APP);

  try {
    const page = await app.firstWindow({timeout: 30_000});
    const errors: string[] = [];

    page.on('pageerror', error => errors.push(error.message));
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);

    await page.getByRole('link', {name: 'Создать регион', exact: true}).click();
    await expect(page).toHaveURL(
      url =>
        url.protocol === 'app:' &&
        url.hostname === 'bundle' &&
        url.pathname === '/' &&
        url.searchParams.get('seed') === '689856',
    );
    const canvas = page.locator('#region');

    await expect(canvas).toHaveAttribute('data-ready', 'true');
    expect(
      await page.evaluate(
        () => '__sim' in window || '__regionEditor' in window,
      ),
    ).toBe(false);
    const settlementName = `Первое поселение ${randomUUID().slice(0, 8)}`;

    await page
      .getByRole('button', {name: 'Основать поселение', exact: true})
      .click();
    await page.locator('#settlement-name').fill(settlementName);
    const box = await canvas.boundingBox();

    if (!box) {
      throw new Error('The region canvas has no screen bounds');
    }

    await page.mouse.click(box.x + box.width * 0.43, box.y + box.height * 0.55);
    await expect(page.locator('#settlement-select')).toContainText(
      settlementName,
    );
    await expect(page.locator('#settlement-count')).toHaveText('1');
    const initialCash = await page.locator('#region-budget').textContent();

    await expect(page.locator('body')).toHaveAttribute('data-mode', 'city');
    await page
      .getByRole('button', {name: 'Режим региона', exact: true})
      .click();
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'region');
    await page.getByRole('button', {name: 'Дорога', exact: true}).click();
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.52);
    await page.mouse.click(box.x + box.width * 0.47, box.y + box.height * 0.52);
    await page.keyboard.press('Enter');
    await expect(page.locator('#region-budget')).not.toHaveText(
      initialCash ?? '',
    );
    await expect(page.locator('#road-count')).toHaveText('2');
    const savedCash = await page.locator('#region-budget').textContent();
    const settlements = await page
      .locator('#settlement-select option')
      .evaluateAll(options =>
        options.map(option => ({
          id: option.getAttribute('value'),
          name: option.textContent,
        })),
      );

    await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
    await expect(page.locator('#region-status')).toContainText(/сохранён/i);
    await page
      .getByRole('button', {name: 'Режим региона', exact: true})
      .click();
    await page
      .getByRole('button', {name: 'Основать поселение', exact: true})
      .click();
    await page.locator('#settlement-name').fill('Временное поселение');
    await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.55);
    await expect(page.locator('#settlement-select')).toContainText(
      'Временное поселение',
    );
    await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
    await expect(page.locator('#save-select option')).not.toHaveCount(0);
    const savedId = await page
      .locator('#save-select option')
      .filter({hasText: settlementName})
      .getAttribute('value');

    if (!savedId) {
      throw new Error('The newly saved region is missing from the load list');
    }

    await page.locator('#save-select').selectOption(savedId);
    await page.locator('#load-confirm').click();
    await expect(page.locator('#region-status')).toContainText(
      /загружен|восстановлен/i,
    );
    await expect(page.locator('#region-budget')).toHaveText(savedCash ?? '');
    await expect(page.locator('#settlement-count')).toHaveText('1');
    await expect(page.locator('#road-count')).toHaveText('2');
    expect(
      await page.locator('#settlement-select option').evaluateAll(options =>
        options.map(option => ({
          id: option.getAttribute('value'),
          name: option.textContent,
        })),
      ),
    ).toEqual(settlements);
    expect(
      await page.evaluate(
        () => '__sim' in window || '__regionEditor' in window,
      ),
    ).toBe(false);
    await page.getByRole('link', {name: 'В главное меню'}).click();
    await expect(page.locator('#main-menu')).toBeVisible();
    await page.getByRole('button', {name: 'Продолжить', exact: true}).click();
    await expect(page.locator('#main-menu')).toBeHidden();
    await expect(page.locator('#region-budget')).toHaveText(savedCash ?? '');
    await expect(page.locator('#road-count')).toHaveText('2');
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    await page.screenshot({path: test.info().outputPath('desktop-region.png')});
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
