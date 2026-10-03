import {writeFile} from 'node:fs/promises';
import {expect, test, type Page} from '@playwright/test';
import {serializeRegion} from '../packages/app/src/region/model/save';
import type {Point, RegionState} from '../packages/app/src/region/model/types';
import {
  createObservationCheckpoints,
  type ObservationCheckpoint,
} from './helpers/regionalObservationFixture';

let checkpoints: ReturnType<typeof createObservationCheckpoints>;

test.use({viewport: {width: 1440, height: 1000}});
test.beforeAll(() => {
  checkpoints = createObservationCheckpoints();
});

async function snapshot(page: Page) {
  return page.evaluate(() => window.__regionEditor!.snapshot());
}

async function loadCheckpoint(page: Page, checkpoint: ObservationCheckpoint) {
  const serialized = serializeRegion(checkpoint.state);

  await writeFile(test.info().outputPath('checkpoint.json'), serialized);
  await page.goto('/');
  await page.evaluate(
    async ({id, value}) => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('simcity-regions', 1);

        open.onupgradeneeded = () => open.result.createObjectStore('regions');
        open.onerror = () =>
          reject(open.error ?? new Error('Cannot open saves'));

        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction('regions', 'readwrite');

          transaction.objectStore('regions').put(value, id);

          transaction.oncomplete = () => {
            database.close();
            resolve();
          };

          transaction.onerror = () => {
            database.close();
            reject(transaction.error ?? new Error('Cannot save checkpoint'));
          };
        };
      });
    },
    {id: checkpoint.state.id, value: serialized},
  );
  await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
  await page.locator('.save-card').click();
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  expect(await snapshot(page)).toEqual(checkpoint.state);
  await page.getByRole('button', {name: 'Режим региона'}).click();
  const city = checkpoint.state.settlements.find(
    value => value.id === checkpoint.cityId,
  )!;

  await page
    .getByRole('button', {name: `Открыть город ${city.name}`, exact: true})
    .click();
  await page.getByRole('button', {name: 'Выбор', exact: true}).click();
}

async function visibleClick(page: Page, point: Point) {
  const pixel = await page.evaluate(
    p => window.__regionEditor!.project(p),
    point,
  );

  expect(
    await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.id, pixel),
  ).toBe('region');
  await page.mouse.click(pixel.x, pixel.y);
}

async function chooseResident(
  page: Page,
  state: RegionState,
  cityId: string,
  personId: string,
) {
  const homes = new Set(
    state.life.buildings
      .filter(building => building.settlementId === cityId)
      .map(building => building.id),
  );
  const families = new Set(
    state.life.families
      .filter(
        family =>
          family.status === 'settled' &&
          family.homeId !== null &&
          homes.has(family.homeId),
      )
      .map(family => family.id),
  );
  const people = state.life.people.filter(person =>
    families.has(person.familyId),
  );
  const index = people.findIndex(person => person.id === personId);

  expect(index).toBeGreaterThanOrEqual(0);
  await page.getByRole('button', {name: 'Жители города'}).click();
  await expect(page.locator('#residents-list button')).toHaveCount(
    people.length,
  );
  await page.locator('#residents-list button').nth(index).click();
  await expect(page.locator('#selection-title')).toHaveText(
    people[index]!.name,
  );
}

async function pause(page: Page) {
  await page.getByRole('button', {name: 'Приостановить симуляцию'}).click();
  await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.locator('#region-status')).toContainText('сохранён');
}

test('a real car and its intercity driver remain visible while their selected route advances', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints.commute;

  await loadCheckpoint(page, checkpoint);
  const before = await snapshot(page);
  const trip = before.life.trips.find(value => value.id === checkpoint.tripId)!;
  const car = before.life.cars.find(value => value.id === trip.vehicleId)!;
  const driver = before.life.people.find(
    value => value.id === checkpoint.actorId,
  )!;
  const origin = before.life.buildings.find(value => value.id === trip.fromId)!;
  const destination = before.life.buildings.find(
    value => value.id === trip.toId,
  )!;

  expect(origin.settlementId).not.toBe(destination.settlementId);
  expect(car.driverId).toBe(driver.id);
  await visibleClick(
    page,
    before.life.traffic!.vehicles[car.trafficIndex]!.pose,
  );
  await expect(page.locator('#selection-title')).toHaveText(
    'Семейный автомобиль',
  );
  await expect(page.locator('#selection-detail')).toContainText(
    `Водитель: ${driver.name}`,
  );
  await page.screenshot({path: test.info().outputPath('actual-car-card.png')});
  await chooseResident(page, before, checkpoint.cityId, driver.id);
  await expect(page.locator('#selection-detail')).toContainText(
    'Дом: Лесной. Работа: Заречный.',
  );
  await expect(page.locator('#selection-detail')).toContainText('В пути:');
  await page.screenshot({
    path: test.info().outputPath('selected-intercity-before.png'),
  });
  await page.getByLabel('Скорость симуляции').selectOption('1');
  await page.getByRole('button', {name: 'Запустить симуляцию'}).click();
  await expect
    .poll(
      async () => {
        const current = (await snapshot(page)).life.trips.find(
          value => value.id === trip.id,
        );

        return current
          ? Math.hypot(
              current.pose.x - trip.pose.x,
              current.pose.z - trip.pose.z,
            )
          : 0;
      },
      {intervals: [100]},
    )
    .toBeGreaterThan(8);
  await pause(page);
  const after = await snapshot(page);
  const moved = after.life.trips.find(value => value.id === trip.id)!;

  expect(moved).toBeDefined();
  expect(moved.actorId).toBe(driver.id);
  expect(moved.vehicleId).toBe(car.id);
  expect(
    Math.hypot(moved.pose.x - trip.pose.x, moved.pose.z - trip.pose.z),
  ).toBeGreaterThan(8);
  await visibleClick(
    page,
    after.life.traffic!.vehicles[car.trafficIndex]!.pose,
  );
  await expect(page.locator('#selection-title')).toHaveText(
    'Семейный автомобиль',
  );
  await chooseResident(page, after, checkpoint.cityId, driver.id);
  await page.screenshot({
    path: test.info().outputPath('selected-intercity-after.png'),
  });
  await writeFile(
    test.info().outputPath('same-actor-motion.json'),
    JSON.stringify(
      {
        driverId: driver.id,
        carId: car.id,
        tripId: trip.id,
        before: trip,
        after: moved,
      },
      null,
      2,
    ),
  );
});

test('a saved loaded truck unloads the same order into its actual shop stock', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints.delivery;

  await loadCheckpoint(page, checkpoint);
  const before = await snapshot(page);
  const order = before.life.deliveries.find(
    value => value.id === checkpoint.actorId,
  )!;
  const trip = before.life.trips.find(value => value.id === checkpoint.tripId)!;
  const target = before.life.buildings.find(
    value => value.id === order.targetId,
  )!;

  expect(order.state).toBe('in-transit');
  expect(order.cargo).toBeGreaterThan(0);
  await visibleClick(
    page,
    before.life.traffic!.vehicles[trip.trafficIndex!]!.pose,
  );
  await expect(page.locator('#selection-title')).toHaveText('Доставка товара');
  await expect(page.locator('#selection-detail')).toContainText(
    `Груз: ${order.cargo}, заказ: ${order.quantity}`,
  );
  await page.screenshot({
    path: test.info().outputPath('loaded-order-before.png'),
  });
  await page.getByLabel('Скорость симуляции').selectOption('1');
  await page.getByRole('button', {name: 'Запустить симуляцию'}).click();
  await expect(page.locator('#selection-detail')).toContainText('Разгрузка', {
    timeout: 20_000,
  });
  await pause(page);
  const unloading = await snapshot(page);
  const unloadingOrder = unloading.life.deliveries.find(
    value => value.id === order.id,
  )!;

  expect(unloadingOrder.state).toBe('unloading');
  expect(unloadingOrder.cargo).toBe(order.cargo);
  expect(
    unloading.life.buildings.find(value => value.id === target.id)!.inventory,
  ).toBe(target.inventory);
  await page.screenshot({
    path: test.info().outputPath('same-order-unloading.png'),
  });
  await page.getByRole('button', {name: 'Запустить симуляцию'}).click();
  await expect(page.locator('#selection-detail')).toContainText('Доставлено', {
    timeout: 10_000,
  });
  await pause(page);
  const delivered = await snapshot(page);
  const completed = delivered.life.deliveries.find(
    value => value.id === order.id,
  )!;
  const stocked = delivered.life.buildings.find(
    value => value.id === target.id,
  )!;

  expect(completed.state).toBe('delivered');
  expect(completed.cargo).toBe(0);
  expect(stocked.inventory).toBe(target.inventory + order.cargo);
  await page.screenshot({
    path: test.info().outputPath('same-order-delivered.png'),
  });
  const lot = delivered.parcels.find(value => value.id === stocked.lotId)!;

  await visibleClick(page, lot.center);
  await expect(page.locator('#selection-title')).toHaveText('Магазин');
  await expect(page.locator('#selection-detail')).toContainText(
    `Запас: ${stocked.inventory} /`,
  );
  await page.screenshot({
    path: test.info().outputPath('receiving-shop-stock.png'),
  });
  await writeFile(
    test.info().outputPath('delivery-stock-transition.json'),
    JSON.stringify(
      {
        orderId: order.id,
        targetId: target.id,
        before: {order, inventory: target.inventory},
        unloading: {order: unloadingOrder, inventory: target.inventory},
        delivered: {order: completed, inventory: stocked.inventory},
      },
      null,
      2,
    ),
  );
});
