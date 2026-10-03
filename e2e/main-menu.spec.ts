import {expect, test} from '@playwright/test';

test.use({reducedMotion: 'reduce', viewport: {width: 1440, height: 1000}});

test('the main menu opens only the current city and the city returns to the menu', async ({
  page,
}) => {
  const workers: string[] = [];
  const errors: string[] = [];

  page.on('worker', worker => workers.push(worker.url()));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const menu = page.getByRole('navigation', {name: 'Главное меню'});

  await expect(menu).toBeVisible();
  await expect(menu.getByRole('link')).toHaveCount(1);
  await page.screenshot({path: test.info().outputPath('main-menu.png')});
  expect(workers).toEqual([]);
  await menu.getByRole('link', {name: 'Город у воды'}).click();
  await expect(page).toHaveURL(/\/city\//);
  await expect(page.locator('#city')).toHaveAttribute('data-ready', 'true');
  await expect(
    page.getByRole('button', {name: 'Работающий порт'}),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {name: 'Строительство', exact: true}),
  ).toBeVisible();
  expect(workers).toHaveLength(1);
  expect(workers[0]).toContain('/src/city/life/worker.ts');
  await page.getByRole('link', {name: 'В главное меню'}).click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#city')).toHaveAttribute('data-ready', 'true');
  expect(errors).toEqual([]);
});

test('old scenario URLs and the removed first prototype cannot start another city', async ({
  page,
}) => {
  for (const path of [
    '/?scenario=city',
    '/?scenario=living',
    '/?scenario=metropolis',
    '/?scenario=signalized',
    '/?scenario=signalized4',
    '/neighborhood/',
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole('navigation', {name: 'Главное меню'}),
    ).toBeVisible();
    expect(await page.evaluate(() => '__sim' in window)).toBe(false);
    await expect(page.locator('#neighborhood')).toHaveCount(0);
  }

  await page.setViewportSize({width: 1280, height: 800});
  await expect(page.getByRole('link', {name: 'Город у воды'})).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('main-menu-desktop.png'),
  });
  await page.emulateMedia({colorScheme: 'dark'});
  await expect(page.getByRole('link', {name: 'Город у воды'})).toBeVisible();
  await page.screenshot({path: test.info().outputPath('main-menu-dark.png')});
});
