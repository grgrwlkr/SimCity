import {expect, test, type Page} from '@playwright/test';
import {readNativeRegionDocument} from '../packages/app/src/game/regionDocument';
import type {NativeRegionDocument} from '../packages/app/src/game/regionDocument';
import type {Point} from '../packages/app/src/region/model/types';
import {readFile, writeFile} from 'node:fs/promises';
import {parseGameSave} from '../packages/app/src/game/save';
import {repairLegacyHallRoads} from '../packages/app/src/game/repairLegacyHallRoads';
import {
  buildRoadGraph,
  findRoadPath,
} from '../packages/app/src/region/model/roads';

test.use({viewport: {width: 1600, height: 1000}, reducedMotion: 'reduce'});
test.describe.configure({timeout: 120_000});

test('the real acceptance world opens through the ordinary save catalogue', async ({
  page,
}) => {
  const path = process.env.NATIVE_REGION_ACCEPTANCE_SAVE;

  if (!path) {
    test.skip(
      true,
      'NATIVE_REGION_ACCEPTANCE_SAVE supplies the preserved real acceptance save',
    );

    return;
  }

  const raw = await readFile(path, 'utf8');
  const game = repairLegacyHallRoads(parseGameSave(raw));

  if (game.world.version !== 3) {
    throw new Error('The acceptance save must be an authored native region');
  }

  expect(game.world.population.people.length).toBeGreaterThanOrEqual(1000);
  const buildingCount = game.world.definition.layout.buildings.length;

  expect(buildingCount).toBeGreaterThanOrEqual(200);
  const workers: string[] = [];

  page.on('worker', worker => workers.push(worker.url()));
  await page.goto('/');
  await page.evaluate(
    async record => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('simcity-regions', 1);

        request.onupgradeneeded = () =>
          request.result.createObjectStore('regions');
        request.onerror = () =>
          reject(request.error ?? new Error('Open failed'));

        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('regions', 'readwrite');

          transaction.objectStore('regions').put(record.raw, record.id);

          transaction.oncomplete = () => {
            db.close();
            resolve();
          };

          transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? new Error('Write failed'));
          };
        };
      });
    },
    {id: game.id, raw},
  );
  await page.locator('#menu-load-region').click();
  await page.getByRole('button', {name: /Живой регион.*689856/}).click();
  await expect(page.locator('#main-menu')).toBeHidden({timeout: 30_000});
  await expect(page.locator('#city')).toHaveAttribute(
    'data-life-ready',
    'true',
  );
  await expect(page.locator('#life-count')).toHaveText('1000');
  await expect(page.locator('#object-count')).toContainText(
    `${buildingCount} зданий`,
  );
  const restored = await page.evaluate(() => window.__cityLife.save());

  expect(JSON.parse(JSON.stringify(restored)) as unknown).toEqual(game.world);
  expect(workers).toHaveLength(1);
  expect(workers[0]).toContain('/city/life/worker.ts');
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.locator('#native-region-editor')).toBeVisible();
  await page.locator('#native-region-editor [data-mode="region"]').click();
  await expect(page.locator('#native-town-list button')).toHaveCount(2);
  await page.locator('#native-region-editor [data-action="overview"]').click();
  await road(page, {x: -1850, z: -600}, {x: -1850, z: -700});
  const edited = await page.evaluate(() => window.__cityLife.save());

  expect(edited.population.people).toEqual(restored.population.people);
  expect(edited.population.families).toEqual(restored.population.families);
  expect(edited.population.cars).toEqual(restored.population.cars);
  expect(edited.parking.filter(slot => slot.occupant !== null)).toEqual(
    restored.parking.filter(slot => slot.occupant !== null),
  );

  if (edited.version !== 3) {
    throw new Error('The edited acceptance world lost its authored definition');
  }

  expect(edited.definition.calendar).toEqual({
    startingMinute: 360,
    secondsPerMinute: 60,
  });
  expect(
    edited.definition.profile.places
      .filter(place => place.kind === 'home')
      .map(place => place.id),
  ).toEqual(
    game.world.version === 3
      ? game.world.definition.profile.places
          .filter(place => place.kind === 'home')
          .map(place => place.id)
      : [],
  );
  expect(edited.tick).toBe(restored.tick);
  expect(workers).toHaveLength(1);
});

async function readDocument(page: Page): Promise<NativeRegionDocument> {
  const saved = await page.evaluate(() => window.__cityLife.save());

  if (saved.version !== 3) {
    throw new Error('Root region must use the authored native save');
  }

  const document = readNativeRegionDocument(
    saved.definition.metadata?.['regionDocument'],
  );

  if (!document) {
    throw new Error('The native editor document is missing');
  }

  return document;
}

async function clickWorld(page: Page, point: Point) {
  const project = async () => {
    await page.evaluate(
      () =>
        new Promise<void>(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const pixel = await page.evaluate(
      point => window.__cityLife.project(point.x, 1, point.z),
      point,
    );
    const box = await page.locator('#city').boundingBox();

    if (!box) {
      throw new Error('The native canvas is hidden');
    }

    const surface = await page.evaluate(
      pixel => document.elementFromPoint(pixel.x, pixel.y)?.id ?? null,
      {x: box.x + pixel.x, y: box.y + pixel.y},
    );

    return {x: box.x + pixel.x, y: box.y + pixel.y, surface};
  };
  let pixel = await project();

  if (pixel.surface !== 'city') {
    await page
      .locator('#native-region-editor [data-action="overview"]')
      .click();
    pixel = await project();
  }

  expect(
    pixel.surface,
    `World point ${JSON.stringify(point)} projects to ${JSON.stringify(pixel)}`,
  ).toBe('city');
  await page.mouse.click(pixel.x, pixel.y);
  await expect(page.locator('#native-region-editor')).not.toHaveAttribute(
    'aria-busy',
    'true',
  );
}

async function tool(page: Page, name: string) {
  await page
    .locator(`#native-region-editor [data-tool="${name}"]:visible`)
    .click();
}

async function road(page: Page, a: Point, b: Point) {
  await tool(page, 'road');
  await clickWorld(page, a);
  await expect(page.locator('#native-editor-status')).toContainText(
    'Начало выбрано',
  );
  await clickWorld(page, b);
  await expect(page.locator('#native-editor-status')).toHaveText(
    'Изменение применено.',
  );
}

async function start(page: Page) {
  await page.goto('/');
  await page.locator('#open-region').click();
  await expect(page.locator('#city')).toHaveAttribute(
    'data-life-ready',
    'true',
  );
  await expect(page.locator('#native-region-editor')).toBeVisible();
  await page.evaluate(() => window.__cityLife.pause());
}

async function found(page: Page, name: string, center: Point) {
  await page.locator('#native-region-editor [data-mode="region"]').click();
  await page.locator('#native-region-editor [data-action="overview"]').click();
  await page.locator('#native-town-name').fill(name);
  await tool(page, 'found');
  await clickWorld(page, center);
  await expect(page.locator('#native-town-heading')).toHaveText(name);
  await expect(page.locator('#native-town-radius')).toContainText('300 м');
}

test('new root region builds finite native homes and resumes an unfinished construction', async ({
  page,
}) => {
  const workers: string[] = [];

  page.on('worker', worker => workers.push(worker.url()));
  await start(page);
  const empty = await page.evaluate(() => window.__cityLife.save());

  expect(empty.population.people).toEqual([]);
  expect(empty.population.units).toEqual([]);
  expect(empty.traffic.vehicles).toEqual([]);
  await found(page, 'Север', {x: -1300, z: -500});
  const town = (await readDocument(page)).settlements[0]!;
  const center = {x: town.center.x, z: town.center.z + 120};

  await road(
    page,
    {x: center.x - 64, z: center.z - 22},
    {x: center.x + 64, z: center.z - 22},
  );
  await road(
    page,
    {x: center.x - 64, z: center.z + 22},
    {x: center.x + 64, z: center.z + 22},
  );
  await road(
    page,
    {x: center.x + 64, z: town.center.z + 48},
    {x: center.x + 64, z: center.z + 22},
  );
  await tool(page, 'houses');
  await clickWorld(page, center);
  await expect(page.locator('#native-editor-status')).toHaveText(
    'Изменение применено.',
  );
  expect((await readDocument(page)).blocks).toHaveLength(1);
  await page.evaluate(() => window.__cityLife.advance(59));
  const unfinished = await page.evaluate(() => window.__cityLife.save());

  expect(unfinished.population.units).toEqual([]);
  expect(unfinished.population.people).toEqual([]);
  await page.locator('#life-open').click();
  await page.locator('#life-save').click();
  await expect(page.locator('#life-save-status')).toContainText('сохранён');
  await page.locator('#life-close').click();
  await page.getByRole('link', {name: 'В главное меню', exact: true}).click();
  await page.locator('#menu-load-region').click();
  await page.getByRole('button', {name: /Север.*689856/}).click();
  await expect(page.locator('#native-region-editor')).toBeVisible();
  expect(await page.evaluate(() => window.__cityLife.save())).toEqual(
    unfinished,
  );
  await page.evaluate(() => window.__cityLife.advance(2));
  const ready = await page.evaluate(() => window.__cityLife.save());

  expect(ready.population.units.length).toBeGreaterThan(0);
  expect(ready.population.people).toEqual([]);
  expect(ready.parking.length).toBeGreaterThan(0);
  expect(ready.population.units.every(unit => unit.tenant === null)).toBe(true);

  if (ready.version !== 3) {
    throw new Error('Expected the authored native region');
  }

  const house = ready.definition.layout.buildings.find(
    building => building.plot,
  )!;

  await tool(page, 'select');
  await page.locator('#building-select').selectOption(house.id);
  await page.locator('#build-selected').click();
  await expect(page.locator('#construction-panel')).toBeVisible();
  await page.locator('#close-construction').click();
  await expect(page.locator('#native-game-view')).not.toHaveClass(
    /is-building/,
  );
  await page.locator('#life-open').click();
  await expect(page.locator('#residents-panel')).toBeVisible();
  await expect(page.locator('#life-save')).toBeVisible();
  await page.locator('#life-save').click();
  await expect(page.locator('#life-save-status')).toContainText('сохранён');
  expect(await page.evaluate(() => window.__cityLife.save())).toEqual(ready);
  expect(workers).toHaveLength(1);
  expect(workers[0]).toContain('/city/life/worker.ts');
  expect(new URL(page.url()).pathname).toBe('/');
});

test('two cities share the native world while radius and manual upgrade guards preserve it', async ({
  page,
}) => {
  const workers: string[] = [];

  page.on('worker', worker => workers.push(worker.url()));
  await start(page);
  await found(page, 'Север', {x: -1300, z: -500});
  await found(page, 'Юг', {x: -500, z: -650});
  const document = await readDocument(page);
  const first = document.settlements[0]!;
  const second = document.settlements[1]!;

  await page.locator('#native-region-editor [data-mode="region"]').click();
  await page.locator('#native-region-editor [data-action="overview"]').click();
  await road(
    page,
    {x: first.center.x + 64, z: first.center.z + 48},
    {x: second.center.x - 64, z: second.center.z + 48},
  );
  const connected = await readDocument(page);

  expect(connected.settlements.map(town => town.name)).toEqual(['Север', 'Юг']);
  expect(connected.roads).toHaveLength(3);
  const connector = connected.roads.at(-1)!;
  const firstRoad = connected.roads.find(
    road => road.id === first.townHall!.roadId,
  )!;
  const secondRoad = connected.roads.find(
    road => road.id === second.townHall!.roadId,
  )!;

  expect(
    findRoadPath(
      buildRoadGraph(connected.roads),
      firstRoad.points.at(-1)!,
      secondRoad.points[0]!,
    ),
  ).not.toBeNull();
  expect(
    Math.abs(connector.points[0]!.x - connector.points[1]!.x),
  ).toBeGreaterThan(100);
  expect(
    Math.abs(connector.points[0]!.z - connector.points[1]!.z),
  ).toBeGreaterThan(100);
  await page
    .locator('#native-town-list')
    .getByRole('button', {name: 'Север', exact: true})
    .click();
  await page.locator('#native-region-editor [data-action="overview"]').click();
  const before = await page.evaluate(() => window.__cityLife.save());

  await tool(page, 'homes');
  await clickWorld(page, {x: first.center.x + 450, z: first.center.z});
  await expect(page.locator('#native-editor-status')).toContainText('радиусе');
  expect(await page.evaluate(() => window.__cityLife.save())).toEqual(before);
  await page.locator('#native-region-editor summary').click();
  await page.locator('#native-region-editor [data-action="upgrade"]').click();
  await expect(page.locator('#native-editor-status')).toContainText('готовых');
  expect(await page.evaluate(() => window.__cityLife.save())).toEqual(before);
  expect(workers).toHaveLength(1);
});

test('an authored entry brings a native family and real parked cars survive ordinary save loading', async ({
  page,
}) => {
  const workers: string[] = [];

  page.on('worker', worker => workers.push(worker.url()));
  await start(page);
  await found(page, 'У въезда', {x: -1300, z: -500});
  const town = (await readDocument(page)).settlements[0]!;
  const point = (x: number, z: number): Point => ({
    x: town.center.x + x,
    z: town.center.z + z,
  });

  await road(page, point(-64, 98), point(164, 98));
  await road(page, point(-64, 142), point(164, 142));
  await road(page, point(64, 48), point(164, 48));
  await road(page, point(164, 48), point(164, 242));
  await road(page, point(-64, 48), point(-64, 242));
  await road(page, point(-64, 198), point(164, 198));
  await road(page, point(-64, 242), point(164, 242));
  await tool(page, 'houses');
  await clickWorld(page, point(0, 120));
  await expect(page.locator('#native-editor-status')).toHaveText(
    'Изменение применено.',
  );
  await tool(page, 'shops');
  await clickWorld(page, point(100, 120));
  await expect(page.locator('#native-editor-status')).toHaveText(
    'Изменение применено.',
  );
  await tool(page, 'shops');
  await clickWorld(page, point(100, 220));
  await expect(page.locator('#native-editor-status')).toHaveText(
    'Изменение применено.',
  );
  await page.evaluate(() => window.__cityLife.advance(61));
  const ready = await page.evaluate(() => window.__cityLife.save());

  expect(ready.population.people).toEqual([]);
  expect(ready.population.units.length).toBeGreaterThan(0);
  await page.locator('#native-region-editor [data-mode="region"]').click();
  await page.locator('#native-region-editor [data-action="overview"]').click();
  const starter = (await readDocument(page)).roads.find(
    road => road.id === town.townHall!.roadId,
  )!;

  const boundary = {x: -1996, z: town.center.z + 48};

  await road(page, boundary, starter.points[0]!);
  await tool(page, 'entry');
  await clickWorld(page, boundary);
  await expect(page.locator('#native-editor-status')).toHaveText(
    'Изменение применено.',
  );
  expect((await readDocument(page)).entries).toHaveLength(1);
  await page.evaluate(() => window.__cityLife.advance(5));
  const arrival = await page.evaluate(() => window.__cityLife.save());
  const arrivalPath = test.info().outputPath('authored-arrival-save.json');

  await writeFile(arrivalPath, JSON.stringify(arrival));
  await test.info().attach('authored-arrival-save', {
    path: arrivalPath,
    contentType: 'application/json',
  });

  expect(arrival.population.families).toHaveLength(1);
  expect(arrival.population.people.length).toBeGreaterThanOrEqual(3);
  expect(
    arrival.population.people.some(person =>
      person.trip?.reason.includes('микроавтобус'),
    ),
  ).toBe(true);

  for (let step = 0; step < 6; step++) {
    await page.evaluate(() => window.__cityLife.advance(180));

    if (
      (await page.evaluate(() => window.__cityLife.save())).population
        .families[0]!.arrived
    ) {
      break;
    }
  }

  expect(
    (await page.evaluate(() => window.__cityLife.save())).population
      .families[0]!.arrived,
  ).toBe(true);

  for (let step = 0; step < 9; step++) {
    const current = await page.evaluate(() => window.__cityLife.save());

    if (current.population.cars.length > 0) {
      break;
    }

    await page.evaluate(() => window.__cityLife.advance(300));
  }

  const owned = await page.evaluate(() => window.__cityLife.save());

  expect(owned.population.cars.length).toBeGreaterThan(0);
  await page.evaluate(() => window.__cityLife.advance(180));
  const parked = await page.evaluate(() => window.__cityLife.save());

  expect(
    parked.population.cars.some(
      car => car.slot !== null && parked.parking[car.slot]?.occupant === car.id,
    ),
  ).toBe(true);
  await page.locator('#life-open').click();
  await page.locator('#life-save').click();
  await expect(page.locator('#life-save-status')).toContainText('сохранён');
  await page.locator('#life-close').click();
  await page.getByRole('link', {name: 'В главное меню', exact: true}).click();
  await page.locator('#menu-load-region').click();
  await page.getByRole('button', {name: /У въезда.*689856/}).click();
  await expect(page.locator('#native-region-editor')).toBeVisible();
  expect(await page.evaluate(() => window.__cityLife.save())).toEqual(parked);
  expect(workers).toHaveLength(1);
});
