import {expect, test} from '@playwright/test';

test.use({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});

test('construction opens directly with a ready-to-play fenced site', async ({
  page,
}) => {
  await page.goto('/city/?seed=689856&view=construction');
  await expect(page.locator('#city')).toHaveAttribute('data-ready', 'true');
  await expect(
    page.getByRole('region', {name: 'Строительство здания', exact: true}),
  ).toBeVisible();
  await expect(page.getByLabel('Готовность здания')).toHaveValue('0');
  await expect(
    page.getByRole('button', {name: 'Продолжить строительство', exact: true}),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('construction-preview.png'),
  });
});

test('construction grows from an empty site, pauses and restores the original building', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];

  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({time: new Date('2026-10-02T00:00:00Z')});
  await page.goto('/city/?seed=689856');
  await expect(page.locator('#city')).toHaveAttribute('data-ready', 'true');
  await page.clock.pauseAt(new Date('2026-10-02T00:01:00Z'));
  await page.getByLabel('Здание в городе').selectOption('building-1-6-1-1');
  await expect(
    page.getByRole('button', {name: 'Показать строительство', exact: true}),
  ).toBeVisible();
  await page
    .getByRole('button', {name: 'Показать строительство', exact: true})
    .click();
  await page.clock.runFor(100);
  const panel = page.getByRole('region', {
    name: 'Строительство здания',
    exact: true,
  });
  const progress = page.getByLabel('Готовность здания');

  await expect(panel).toBeVisible();
  await expect(progress).toHaveValue('0');
  const sceneImage = () =>
    page.locator('#city').screenshot({
      mask: [
        page.locator(
          '.masthead, .inspector, .district-list, .zoom-controls, .bottom-panel, #construction-panel',
        ),
      ],
    });
  const empty = await sceneImage();

  await page.screenshot({
    path: test.info().outputPath('construction-empty.png'),
  });
  await progress.fill('20');
  await page.clock.runFor(100);
  await page.screenshot({
    path: test.info().outputPath('construction-hoisting.png'),
  });
  await progress.fill('50');
  await page.clock.runFor(100);
  const half = await sceneImage();

  expect(half.equals(empty)).toBe(false);
  await page.screenshot({
    path: test.info().outputPath('construction-half.png'),
  });
  await page.clock.runFor(1500);
  expect((await sceneImage()).equals(half)).toBe(true);
  await progress.fill('100');
  await page.clock.runFor(100);
  const finished = await sceneImage();

  expect(finished.equals(half)).toBe(false);
  await page.screenshot({
    path: test.info().outputPath('construction-finished.png'),
  });
  await page
    .getByRole('button', {name: 'Закрыть строительство', exact: true})
    .click();
  await page.clock.runFor(100);
  await expect(panel).toBeHidden();
  await page
    .getByRole('button', {name: 'Показать строительство', exact: true})
    .click();
  await progress.fill('50');
  await page.clock.runFor(100);
  expect((await sceneImage()).equals(half)).toBe(true);
  await page
    .getByRole('button', {name: 'Продолжить строительство', exact: true})
    .click();
  await page.clock.runFor(1200);
  expect(Number(await progress.inputValue())).toBeGreaterThan(50);
  await page
    .getByRole('button', {name: 'Остановить движение', exact: true})
    .click();
  const paused = await sceneImage();
  const value = await progress.inputValue();

  await page.clock.runFor(1000);
  await expect(progress).toHaveValue(value);
  expect((await sceneImage()).equals(paused)).toBe(true);
  await page.getByRole('button', {name: 'Башня', exact: true}).click();
  await progress.fill('50');
  await page.clock.runFor(100);
  await page.screenshot({
    path: test.info().outputPath('construction-tower.png'),
  });
  await page.getByRole('button', {name: 'Промышленность', exact: true}).click();
  await page.clock.runFor(100);
  await page.screenshot({
    path: test.info().outputPath('construction-industrial-site.png'),
  });
  await progress.fill('50');
  await page.clock.runFor(100);
  await page.screenshot({
    path: test.info().outputPath('construction-industry.png'),
  });
  await page.getByRole('button', {name: 'Ночь', exact: true}).click();
  await page.clock.runFor(100);
  await page.screenshot({
    path: test.info().outputPath('construction-night.png'),
  });
  await page.setViewportSize({width: 1280, height: 800});
  await expect(page.locator('#city')).toHaveAttribute('width', '1280');
  await page.clock.runFor(100);
  await expect(progress).toBeInViewport();
  await expect(
    page.getByRole('button', {name: 'Закрыть строительство', exact: true}),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('construction-desktop.png'),
  });
  await page
    .getByRole('button', {name: 'Закрыть строительство', exact: true})
    .click();
  await page.getByRole('button', {name: 'Другой город'}).click();
  await page.clock.runFor(100);
  await expect(panel).toBeHidden();
  await page.getByRole('button', {name: 'Строительство', exact: true}).click();
  await page.clock.runFor(100);
  await expect(panel).toBeVisible();
  await expect(progress).toHaveValue('0');
  expect(errors).toEqual([]);
});
