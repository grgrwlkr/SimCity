import {expect, test} from '@playwright/test';

test.use({reducedMotion: 'reduce', viewport: {width: 1440, height: 1000}});

test('the primary menu opens the region and Enter returns there after leaving it', async ({
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
  await expect(menu.locator('#open-region')).toHaveAttribute(
    'href',
    '/?seed=689856',
  );
  await expect(menu.locator('#open-city')).toHaveCount(0);
  await page.screenshot({path: test.info().outputPath('main-menu.png')});
  expect(workers).toEqual([]);
  await menu.locator('#open-region').click();
  await expect(page).toHaveURL(
    url => url.pathname === '/' && url.searchParams.has('regionId'),
  );
  await expect(page.locator('#city')).toHaveAttribute(
    'data-life-ready',
    'true',
  );
  await expect(
    page.getByRole('button', {name: 'Основать поселение', exact: true}),
  ).toBeVisible();
  expect(workers).toHaveLength(1);
  expect(workers[0]).toContain('/src/city/life/worker.ts');
  await page.getByRole('link', {name: 'В главное меню'}).click();
  await expect(menu).toBeVisible();
  await page.waitForLoadState('domcontentloaded');
  await page.keyboard.press('Enter');
  await expect(page.locator('#city')).toHaveAttribute(
    'data-life-ready',
    'true',
  );
  expect(errors).toEqual([]);
});

test('the secondary prototype link keeps the original city and its life worker available', async ({
  page,
}) => {
  const workers: string[] = [];
  const errors: string[] = [];

  page.on('worker', worker => workers.push(worker.url()));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page
    .getByRole('link', {name: 'Город у воды — прототип', exact: true})
    .click();
  await expect(page).toHaveURL(/\/city\//);
  await expect(page.locator('#city')).toHaveAttribute('data-ready', 'true');
  // Worker initialization measured 9.0 s under the local SwiftShader load.
  await expect(page.locator('#city')).toHaveAttribute(
    'data-life-ready',
    'true',
    {timeout: 20_000},
  );
  await expect(
    page.getByRole('button', {name: 'Работающий порт'}),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {name: 'Строительство', exact: true}),
  ).toBeVisible();
  expect(workers).toHaveLength(1);
  expect(workers[0]).toContain('/src/city/life/worker.ts');
  await page.getByRole('link', {name: 'В главное меню'}).click();
  await expect(page.locator('#open-region')).toBeVisible();
  expect(errors).toEqual([]);
});

test('old scenario URLs keep the regional menu without starting archived games', async ({
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
  await expect(page.locator('#open-region')).toBeInViewport();
  await expect(
    page.getByRole('link', {name: 'Город у воды — прототип', exact: true}),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('main-menu-desktop.png'),
  });
  await page.emulateMedia({colorScheme: 'dark'});
  await expect(page.locator('#open-region')).toBeVisible();
  await page.screenshot({path: test.info().outputPath('main-menu-dark.png')});
});
