import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });

test('city generator retains its seed, regenerates the scene and offers district views', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/city/?seed=harbor');
  await expect(page.getByRole('heading', { name: 'Город у воды', exact: true })).toBeVisible();
  await expect(page.locator('#city')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#city')).toHaveAttribute('data-life-ready', 'true');
  await expect(page.getByLabel('Ключ генерации')).toHaveValue('harbor');
  const sceneImage = () =>
    page.locator('#city').screenshot({
      mask: [page.locator('.masthead, .inspector, .district-list, .zoom-controls, .bottom-panel, .life-interface')],
    });
  const initial = await sceneImage();
  await page.screenshot({ path: test.info().outputPath('city-day.png') });
  await page.getByRole('button', { name: 'Промышленный район', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Промышленный район', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.screenshot({ path: test.info().outputPath('city-industry.png') });
  await page.getByRole('button', { name: 'Ночь', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ночь', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await sceneImage()).equals(initial)).toBe(false);
  await page.getByRole('button', { name: 'Весь город', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('city-night.png') });
  await page.getByRole('button', { name: 'Другой город' }).click();
  await expect(page.getByLabel('Ключ генерации')).not.toHaveValue('harbor');
  await expect(page.locator('#city')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#city')).toHaveAttribute('data-life-ready', 'true');
  await expect(page.getByRole('button', { name: 'Ночь', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'День', exact: true }).click();
  expect((await sceneImage()).equals(initial)).toBe(false);
  await page.getByLabel('Ключ генерации').fill('harbor');
  await page.getByLabel('Ключ генерации').press('Enter');
  await expect(page).toHaveURL(/seed=harbor/);
  await page.getByRole('button', { name: 'День', exact: true }).click();
  await page.mouse.move(1, 1);
  await page.getByLabel('Ключ генерации').press('Tab');
  await expect.poll(async () => (await sceneImage()).equals(initial)).toBe(true);
  await page.locator('#city').screenshot({ path: test.info().outputPath('city-regenerated.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('button', { name: 'Другой город' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Ночь', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('city-desktop.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('modular building details follow selection and all moving assemblies pause', async ({ page }) => {
  await page.goto('/city/?seed=689856');
  await expect(page.locator('#city')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#city')).toHaveAttribute('data-life-ready', 'true');
  await page.getByLabel('Здание в городе').selectOption('building-0-0-0-0');
  const parts = page.getByRole('list', { name: 'Состав здания' });
  await expect(parts.getByRole('listitem')).toHaveCount(7);
  const firstAssembly = await parts.innerText();
  await page.getByLabel('Здание в городе').selectOption('building-3-2-0-0');
  await expect(parts).not.toHaveText(firstAssembly);
  await page.getByRole('button', { name: 'Закрыть описание' }).click();
  await page.getByRole('button', { name: 'Работающий порт', exact: true }).click();
  await page.getByRole('button', { name: 'Приблизить', exact: true }).click();
  await page.getByRole('button', { name: 'Приблизить', exact: true }).click();
  const sceneImage = () =>
    page.locator('#city').screenshot({
      mask: [page.locator('.masthead, .inspector, .district-list, .zoom-controls, .bottom-panel, .life-interface')],
    });
  await page.screenshot({ path: test.info().outputPath('modular-closeup.png') });
  await page.getByRole('button', { name: 'Продолжить движение' }).click();
  const moving = await sceneImage();
  await page.waitForTimeout(700);
  expect((await sceneImage()).equals(moving)).toBe(false);
  await page.screenshot({ path: test.info().outputPath('modular-moving.png') });
  await page.getByRole('button', { name: 'Остановить движение' }).click();
  const paused = await sceneImage();
  await page.waitForTimeout(500);
  expect((await sceneImage()).equals(paused)).toBe(true);
});

test('port cranes transfer real cargo and the shared pause freezes the harbor', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/city/?seed=689856');
  await expect(page.locator('#city')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#city')).toHaveAttribute('data-life-ready', 'true');
  await expect(page.locator('#city')).toHaveAttribute('data-life-ready', 'true');
  const advance = (seconds: number) =>
    page.evaluate(
      (seconds) =>
        (window as unknown as { __cityLife: { advance(seconds: number): Promise<unknown> } }).__cityLife.advance(
          seconds,
        ),
      seconds,
    );
  await page.getByRole('button', { name: 'Работающий порт' }).click();
  await expect(page.getByRole('region', { name: 'Работа порта' })).toBeVisible();
  await expect(page.locator('#harbor-aboard')).toHaveText('3 / 3');
  await page.screenshot({ path: test.info().outputPath('port-ready.png') });
  await advance(4);
  await expect(page.locator('#harbor-aboard')).toHaveText('2 / 3');
  await page.screenshot({ path: test.info().outputPath('port-unloading.png') });
  const paused = await page.locator('#city').screenshot();
  await page.waitForTimeout(500);
  expect((await page.locator('#city').screenshot()).equals(paused)).toBe(true);
  await advance(26);
  await expect(page.locator('#harbor-panel')).toHaveAttribute('data-phase', 'leaving');
  await expect(page.locator('#harbor-aboard')).toHaveText('0 / 3');
  await page.screenshot({ path: test.info().outputPath('port-departing-empty.png') });
  await advance(28);
  await expect(page.locator('#harbor-panel')).toHaveAttribute('data-phase', 'arriving');
  await expect(page.locator('#harbor-aboard')).toHaveText('0 / 3');
  await page.screenshot({ path: test.info().outputPath('port-arriving-empty.png') });
  await advance(4);
  await expect(page.locator('#harbor-panel')).toHaveAttribute('data-phase', 'loading');
  await page.screenshot({ path: test.info().outputPath('port-loading.png') });
  await advance(5);
  await expect(page.locator('#harbor-aboard')).toHaveText('1 / 3');
  expect(errors).toEqual([]);
});
