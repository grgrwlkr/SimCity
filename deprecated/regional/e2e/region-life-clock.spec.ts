import {expect, test} from '@playwright/test';

test('regional clock starts paused, runs across modes and reloads paused', async ({
  page,
}) => {
  const errors: string[] = [];

  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  await expect(
    page.getByRole('button', {name: 'Запустить симуляцию'}),
  ).toBeEnabled();
  const pixel = await page.evaluate(() =>
    window.__regionEditor!.project(window.__regionEditor!.terrainProbe().land),
  );

  await page
    .getByRole('button', {name: 'Основать поселение', exact: true})
    .click();
  await page.mouse.click(pixel.x, pixel.y);
  await expect(page.locator('#city-population')).toHaveText('0');
  expect(
    (await page.evaluate(() => window.__regionEditor!.snapshot())).life
      .elapsedSeconds,
  ).toBe(0);
  await page.getByLabel('Скорость симуляции').selectOption('120');
  await page.getByRole('button', {name: 'Запустить симуляцию'}).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.__regionEditor!.snapshot())).life
          .elapsedSeconds,
    )
    .toBeGreaterThan(0);
  await page.getByRole('button', {name: 'Режим региона'}).click();
  await expect(
    page.getByRole('button', {name: 'Приостановить симуляцию'}),
  ).toBeVisible();
  await page.getByRole('button', {name: 'Режим города'}).click();
  await page.getByRole('button', {name: 'Приостановить симуляцию'}).click();
  await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.locator('#region-status')).toContainText('сохранён');
  const saved = await page.evaluate(() => window.__regionEditor!.snapshot());

  await page.reload();
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  await expect(
    page.getByRole('button', {name: 'Запустить симуляцию'}),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__regionEditor!.snapshot())).toEqual(
    saved,
  );
  await page.setViewportSize({width: 1280, height: 800});
  await expect(
    page.getByRole('button', {name: 'Сохранить', exact: true}),
  ).toBeInViewport();
  await expect(
    page.getByRole('button', {name: 'Жители города'}),
  ).toBeInViewport();
  await page.screenshot({path: test.info().outputPath('regional-life-ui.png')});
  await page.getByRole('button', {name: 'Ночь', exact: true}).click();
  await page.screenshot({
    path: test.info().outputPath('regional-life-ui-night.png'),
  });
  await page.getByRole('button', {name: 'Жители города'}).click();
  await expect(page.getByRole('dialog')).toContainText(
    'Жители пока не заселились',
  );
  expect(errors).toEqual([]);
});
