import {expect, test} from '@playwright/test';
import type {LifeFrame} from '../packages/app/src/city/life/types';
import type {CityLife} from '../packages/app/src/city/life/world';

type Save = ReturnType<CityLife['save']>;
type LifeHarness = {
  snapshot(): LifeFrame;
  advance(seconds: number): Promise<LifeFrame>;
  save(): Promise<Save>;
  load(save: unknown): Promise<void>;
};

test.use({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});

test('railway carries a family, closes crossings, departs and restores the same moving city', async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];

  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/city/?seed=689856&view=railway');
  await expect(page.locator('#city')).toHaveAttribute(
    'data-life-ready',
    'true',
  );
  await expect(
    page.getByRole('button', {name: 'ЖД вокзал', exact: true}),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('region', {name: 'Работа вокзала'}),
  ).toBeVisible();
  const advance = (seconds: number) =>
    page.evaluate(
      s =>
        (window as unknown as {__cityLife: LifeHarness}).__cityLife.advance(s),
      seconds,
    );
  const save = () =>
    page.evaluate(() =>
      (window as unknown as {__cityLife: LifeHarness}).__cityLife.save(),
    );

  await page.screenshot({path: test.info().outputPath('railway-station.png')});
  const arriving = await advance(22);

  expect(arriving.railway.train.phase).toBe('arriving');
  expect(arriving.railway.crossings.some(c => c.openness < 1)).toBe(true);
  await page.screenshot({path: test.info().outputPath('railway-arriving.png')});
  let boarding = arriving;

  for (let i = 0; i < 200 && boarding.railway.train.phase !== 'boarding'; i++) {
    boarding = await advance(0.5);
  }

  expect(boarding.railway.train.doorsOpen).toBe(true);
  expect(boarding.railway.train.passengers).toBe(3);
  await advance(2.5);
  await expect(page.locator('#railway-arrivals')).toHaveText('1');
  await expect(page.locator('#railway-passengers')).toHaveText('3');
  await page.screenshot({
    path: test.info().outputPath('railway-passengers.png'),
  });
  const before = await save();

  await advance(6);
  const uninterrupted = await save();

  await page.evaluate(
    data =>
      (window as unknown as {__cityLife: LifeHarness}).__cityLife.load(data),
    before,
  );
  await advance(6);
  expect(await save()).toEqual(uninterrupted);
  const frozen = await page.locator('#city').screenshot();

  await page.waitForTimeout(300);
  expect((await page.locator('#city').screenshot()).equals(frozen)).toBe(true);
  await page.getByRole('button', {name: 'Ночь', exact: true}).click();
  await page.screenshot({path: test.info().outputPath('railway-night.png')});
  let departing = await advance(15);

  expect(departing.railway.train.phase).toBe('leaving');
  expect(departing.railway.train.passengers).toBe(0);
  await page.screenshot({
    path: test.info().outputPath('railway-departing.png'),
  });

  for (let i = 0; i < 40 && departing.railwayStatus.departures === 0; i++) {
    departing = await advance(2);
  }

  expect(departing.railwayStatus.departures).toBe(1);
  await page.setViewportSize({width: 1280, height: 800});
  await expect(page.locator('#railway-panel')).toBeInViewport();
  await expect(page.locator('#life-time')).toBeInViewport();
  await page.screenshot({path: test.info().outputPath('railway-desktop.png')});
  await page.getByRole('button', {name: 'Весь город', exact: true}).click();
  await page.getByRole('button', {name: 'День', exact: true}).click();
  await page.screenshot({path: test.info().outputPath('city-expanded.png')});
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator('#scene-error')).toBeHidden();
  expect(errors).toEqual([]);
});
