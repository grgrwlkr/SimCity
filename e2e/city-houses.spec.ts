import {expect, test} from '@playwright/test';

test.use({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});

test('private homes have a district view, a one-storey profile and a complete construction cycle', async ({
  page,
}) => {
  const errors: string[] = [];

  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/city/?seed=689856&view=houses');
  await expect(page.locator('#city')).toHaveAttribute('data-ready', 'true');
  await expect(
    page.getByRole('button', {name: 'Частные дома', exact: true}),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({
    path: test.info().outputPath('private-houses-day.png'),
  });
  await page.getByLabel('Здание в городе').selectOption('building-0-6-0-1');
  await expect(page.locator('#building-floors')).toHaveText('1');
  await expect(
    page.getByRole('list', {name: 'Состав здания'}).getByRole('listitem'),
  ).toHaveCount(7);
  await page
    .getByRole('button', {name: 'Показать строительство', exact: true})
    .click();
  await expect(page.getByLabel('Готовность здания')).toHaveValue('0');
  await page.screenshot({
    path: test.info().outputPath('private-house-site.png'),
  });
  await page.getByLabel('Готовность здания').fill('100');
  await expect(page.locator('#construction-stage')).toHaveText('Здание готово');
  await page.screenshot({
    path: test.info().outputPath('private-house-finished.png'),
  });
  await page.getByRole('button', {name: 'Частные дома', exact: true}).click();
  await page.getByRole('button', {name: 'Ночь', exact: true}).click();
  await page.screenshot({
    path: test.info().outputPath('private-houses-night.png'),
  });
  await page.setViewportSize({width: 1280, height: 800});
  await expect(
    page.getByRole('button', {name: 'Частные дома', exact: true}),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('private-houses-desktop.png'),
  });
  expect(errors).toEqual([]);
});
