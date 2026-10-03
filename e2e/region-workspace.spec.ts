import {expect, test, type Page} from '@playwright/test';
import type {Point} from '../packages/app/src/region/model/types';

test.use({viewport: {width: 1440, height: 1000}});

async function clickWorld(page: Page, point: Point) {
  const pixel = await page.evaluate(
    p => window.__regionEditor!.project(p),
    point,
  );

  await page.mouse.click(pixel.x, pixel.y);
}

test('region and city menus separate planning from building and cancel drafts', async ({
  page,
}) => {
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  await expect(
    page.getByRole('button', {name: 'Режим региона'}),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', {name: 'Жилая зона', exact: true}),
  ).toBeHidden();
  const probe = await page.evaluate(() =>
    window.__regionEditor!.terrainProbe(),
  );

  await page
    .getByRole('button', {name: 'Основать поселение', exact: true})
    .click();
  await page.locator('#settlement-name').fill('Речной');
  await clickWorld(page, probe.land);
  await expect(page.locator('#city-name')).toHaveText('Речной');
  await expect(
    page.getByRole('button', {name: 'Режим города'}),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', {name: 'Жилая зона', exact: true}),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {name: 'Основать поселение', exact: true}),
  ).toBeHidden();
  await expect(page.locator('#city-radius')).toHaveText('300 м');
  const before = await page.evaluate(() => window.__regionEditor!.snapshot());

  await page.getByRole('button', {name: 'Дорога', exact: true}).click();
  await clickWorld(page, {x: probe.land.x + 64, z: probe.land.z + 48});
  await clickWorld(page, {x: probe.land.x + 160, z: probe.land.z + 48});
  await page.getByRole('button', {name: 'Режим региона'}).click();
  await page.locator('#region').focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__regionEditor!.snapshot())).toEqual(
    before,
  );
  await expect(
    page.getByRole('button', {name: 'Внешний въезд', exact: true}),
  ).toBeVisible();
  await page.screenshot({path: test.info().outputPath('region-workspace.png')});
  await page
    .getByRole('button', {name: 'Открыть город Речной', exact: true})
    .click();
  await expect(page.locator('#city-name')).toHaveText('Речной');
  await page.screenshot({path: test.info().outputPath('city-workspace.png')});
  await page.setViewportSize({width: 1280, height: 800});
  await page.screenshot({
    path: test.info().outputPath('city-workspace-compact.png'),
  });
});

test('city limits block local roads and empty parcels do not unlock town hall upgrades', async ({
  page,
}) => {
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  const {land} = await page.evaluate(() =>
    window.__regionEditor!.terrainProbe(),
  );

  await page
    .getByRole('button', {name: 'Основать поселение', exact: true})
    .click();
  await clickWorld(page, land);
  await expect(page.locator('#city-radius')).toHaveText('300 м');
  await page.getByText('Развитие ратуши', {exact: true}).click();
  await expect(page.locator('#upgrade-town-hall')).toBeDisabled();
  const founded = await page.evaluate(() => window.__regionEditor!.snapshot());
  const start = {x: land.x + 64, z: land.z + 48};
  const end = {x: land.x + 390, z: land.z + 48};

  await page.getByRole('button', {name: 'Дорога', exact: true}).click();
  await clickWorld(page, start);
  await clickWorld(page, end);
  await page.keyboard.press('Enter');
  await expect(page.locator('#region-status')).toContainText(
    'За границей города',
  );
  expect(await page.evaluate(() => window.__regionEditor!.snapshot())).toEqual(
    founded,
  );
  await page.getByRole('button', {name: 'Режим региона'}).click();
  await page.getByRole('button', {name: 'Дорога', exact: true}).click();
  await clickWorld(page, start);
  await clickWorld(page, end);
  await page.keyboard.press('Enter');
  await expect(page.locator('#road-count')).toHaveText('2');
  await page.getByRole('button', {name: 'Режим города'}).click();
  await page.getByRole('button', {name: 'Жилая зона', exact: true}).click();
  const from = await page.evaluate(p => window.__regionEditor!.project(p), {
    x: land.x + 80,
    z: land.z + 56,
  });
  const to = await page.evaluate(p => window.__regionEditor!.project(p), {
    x: land.x + 250,
    z: land.z + 88,
  });

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('#upgrade-town-hall')).toBeDisabled();
  await expect(page.locator('#region-status')).toHaveText('Зона размечена.');
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.__regionEditor!.snapshot())).parcels
          .length,
    )
    .toBeGreaterThan(0);
  await expect(page.locator('#upgrade-requirements')).toContainText(
    'Готовые здания с подъездом: 0 / 8',
  );
  const upgraded = await page.evaluate(() => window.__regionEditor!.snapshot());

  expect(upgraded.parcels.length).toBeGreaterThan(0);
  expect(upgraded.settlements[0]!.townHall?.level).toBe(1);
  await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.locator('#region-status')).toContainText('сохранён');
  await page.reload();
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#city-radius')).toHaveText('300 м');
  expect(await page.evaluate(() => window.__regionEditor!.snapshot())).toEqual(
    upgraded,
  );
  await page.getByText('Развитие ратуши', {exact: true}).click();
  await page.getByRole('button', {name: 'Ночь', exact: true}).click();
  await page.screenshot({
    path: test.info().outputPath('city-upgraded-night.png'),
  });
  await page.getByRole('button', {name: 'День', exact: true}).click();
  await page.screenshot({path: test.info().outputPath('city-upgraded.png')});
});
