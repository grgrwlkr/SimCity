import {expect, test, type Page} from '@playwright/test';
import {parkingPoint, resolvePlace} from '../src/model/life/routes';
import type {Point} from '../../../packages/app/src/region/model/types';

test.use({viewport: {width: 1440, height: 1000}});

async function snapshot(page: Page) {
  return page.evaluate(() => window.__regionEditor!.snapshot());
}

async function clickWorld(page: Page, point: Point) {
  const pixel = await page.evaluate(
    p => window.__regionEditor!.project(p),
    point,
  );

  await page.mouse.click(pixel.x, pixel.y);
}

async function road(page: Page, from: Point, to: Point, count: number) {
  await page.getByRole('button', {name: 'Дорога', exact: true}).click();
  await clickWorld(page, from);
  await clickWorld(page, to);
  await page.keyboard.press('Enter');
  await expect(page.locator('#region-status')).toHaveText('Дорога построена.');
  await expect(page.locator('#road-count')).toHaveText(String(count));
}

async function zone(page: Page, name: string, from: Point, to: Point) {
  const before = (await snapshot(page)).parcels.length;

  await page.getByRole('button', {name, exact: true}).click();
  const start = await page.evaluate(
    p => window.__regionEditor!.project(p),
    from,
  );
  const end = await page.evaluate(p => window.__regionEditor!.project(p), to);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('#region-status')).toHaveText('Зона размечена.');
  await expect
    .poll(async () => (await snapshot(page)).parcels.length)
    .toBeGreaterThan(before);
}

test('two player-built cities develop, trade, upgrade and resume a saved living region', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];

  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');

  for (const town of [
    {name: 'Речной', center: {x: -650, z: 0}},
    {name: 'Заречье', center: {x: -150, z: 0}},
  ]) {
    await page.getByRole('button', {name: 'Режим региона'}).click();
    await page
      .getByRole('button', {name: 'Основать поселение', exact: true})
      .click();
    await page.locator('#settlement-name').fill(town.name);
    await clickWorld(page, town.center);
    await expect(page.locator('#city-name')).toHaveText(town.name);
  }

  await page.getByRole('button', {name: 'Режим региона'}).click();
  await road(page, {x: -586, z: 48}, {x: -214, z: 48}, 3);
  await road(page, {x: -2000, z: 48}, {x: -714, z: 48}, 4);
  await page.getByRole('button', {name: 'Внешний въезд', exact: true}).click();
  await clickWorld(page, {x: -2000, z: 48});
  await expect(page.locator('#region-status')).toHaveText(
    'Внешний въезд обозначен.',
  );
  expect((await snapshot(page)).externalEntries).toHaveLength(1);
  await page
    .getByRole('button', {name: 'Открыть город Речной', exact: true})
    .click();
  await zone(page, 'Жилая зона', {x: -910, z: 56}, {x: -730, z: 88});
  await zone(page, 'Торговая зона', {x: -560, z: 56}, {x: -410, z: 88});
  await page.getByRole('button', {name: 'Склад', exact: true}).click();
  await clickWorld(page, {x: -520, z: 25});
  await expect(page.locator('#warehouse-count')).toHaveText('1');
  await page.getByRole('button', {name: 'Режим региона'}).click();
  await page
    .getByRole('button', {name: 'Открыть город Заречье', exact: true})
    .click();
  await zone(page, 'Производственная зона', {x: -214, z: 56}, {x: -86, z: 88});
  await page.getByRole('button', {name: 'Выбор', exact: true}).click();
  await page.getByLabel('Скорость симуляции').selectOption('120');
  await page.getByRole('button', {name: 'Запустить симуляцию'}).click();
  await expect
    .poll(
      async () => {
        const current = await snapshot(page);

        return current.life.families.filter(
          family => family.status === 'settled',
        ).length;
      },
      {timeout: 100_000, intervals: [500]},
    )
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await snapshot(page)).life.completedDeliveries, {
      timeout: 60_000,
      intervals: [500],
    })
    .toBeGreaterThan(0);
  await page.getByRole('button', {name: 'Режим региона'}).click();
  await page
    .getByRole('button', {name: 'Открыть город Речной', exact: true})
    .click();
  await page.getByText('Развитие ратуши', {exact: true}).click();
  await expect(page.locator('#upgrade-town-hall')).toBeEnabled({
    timeout: 60_000,
  });

  // A queued fast tick can finish the observed trip before pause reaches the worker.
  // Save drains that queue; retry via real controls until a live trip remains paused.
  for (let attempt = 0; attempt < 5; attempt++) {
    await expect
      .poll(async () => (await snapshot(page)).life.trips.length, {
        timeout: 30_000,
        intervals: [100],
      })
      .toBeGreaterThan(0);
    await page.getByLabel('Скорость симуляции').selectOption('1');
    await page.getByRole('button', {name: 'Приостановить симуляцию'}).click();
    await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
    await expect(page.locator('#region-status')).toContainText('сохранён');

    if ((await snapshot(page)).life.trips.length > 0) {
      break;
    }
    if (attempt < 4) {
      await page.getByLabel('Скорость симуляции').selectOption('120');
      await page.getByRole('button', {name: 'Запустить симуляцию'}).click();
    }
  }

  expect((await snapshot(page)).life.trips.length).toBeGreaterThan(0);
  await page.locator('#upgrade-town-hall').click();
  await expect(page.locator('#city-radius')).toHaveText('450 м');
  const developed = await snapshot(page);

  expect(
    developed.life.families.some(family => family.status === 'settled'),
  ).toBe(true);
  expect(developed.life.completedDeliveries).toBeGreaterThan(0);
  expect(
    developed.life.buildings.some(
      building => building.kind === 'industrial' && building.stage === 'ready',
    ),
  ).toBe(true);
  const home = developed.life.buildings.find(
    building => building.kind === 'residential' && building.stage === 'ready',
  );
  const homeLot = developed.parcels.find(parcel => parcel.id === home?.lotId);

  expect(homeLot).toBeDefined();
  await clickWorld(page, homeLot!.center);
  await expect(page.locator('#selection-title')).toHaveText('Жилой дом');
  await expect(page.locator('#selection-detail')).toContainText('Жители:');
  const parked = developed.life.cars.flatMap(car => {
    const place = car.parkedAt
      ? resolvePlace({...developed}, car.parkedAt)
      : null;

    if (!place || car.parkingSlot === null) {
      return [];
    }

    const point = parkingPoint(place, car.parkingSlot);

    return Math.abs(point.x + 650) < 280 && Math.abs(point.z) < 280
      ? [point]
      : [];
  });

  if (parked[0]) {
    await clickWorld(page, parked[0]);
    await expect(page.locator('#selection-title')).toHaveText(
      'Семейный автомобиль',
    );
    await expect(page.locator('#selection-detail')).toContainText('Семья:');
  }

  await page.getByRole('button', {name: 'Жители города'}).click();
  const residents = page.locator('#residents-list button');
  const firstName = await residents.first().innerText();

  await residents.first().click();
  await expect(page.locator('#selection-title')).toHaveText(firstName);
  await expect(page.locator('#selection-detail')).toContainText('Дом: Речной');
  await expect(page.locator('#selection-detail')).toContainText(
    'Бюджет семьи:',
  );
  await page.screenshot({
    path: test.info().outputPath('regional-living-day.png'),
  });
  await page.setViewportSize({width: 1280, height: 800});
  await page.getByRole('button', {name: 'Ночь', exact: true}).click();
  await page.screenshot({
    path: test.info().outputPath('regional-living-night.png'),
  });
  await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.locator('#region-status')).toContainText('сохранён');
  const saved = await snapshot(page);

  await test.info().attach('saved-living-region', {
    body: JSON.stringify(saved),
    contentType: 'application/json',
  });
  expect(saved.life.trips.length).toBeGreaterThan(0);
  await page.getByRole('link', {name: 'В главное меню'}).click();
  await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
  await page.getByRole('button', {name: /Речной, Заречье.*689856/}).click();
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#main-menu')).toBeHidden();
  await expect(
    page.getByRole('button', {name: 'Запустить симуляцию'}),
  ).toBeVisible();
  expect(await snapshot(page)).toEqual(saved);
  await page.getByLabel('Скорость симуляции').selectOption('120');
  await page.getByRole('button', {name: 'Запустить симуляцию'}).click();
  await expect
    .poll(async () => (await snapshot(page)).life.elapsedSeconds)
    .toBeGreaterThan(saved.life.elapsedSeconds);
  await page.getByRole('button', {name: 'Приостановить симуляцию'}).click();
  const resumed = await snapshot(page);

  expect(resumed.life.people.map(person => person.id)).toEqual(
    saved.life.people.map(person => person.id),
  );
  expect(errors).toEqual([]);
});
