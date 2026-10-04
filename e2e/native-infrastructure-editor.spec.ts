import {expect, test, type Page} from '@playwright/test';
import {readFile, writeFile} from 'node:fs/promises';
import {parseGameSave, createGameSave} from '../packages/app/src/game/save';
import {documentFromDefinition} from '../packages/app/src/game/documentFromDefinition';
import {applyNativeEdit} from '../packages/app/src/game/regionDocument';
import {readNativeRegionDocument} from '../packages/app/src/game/regionDocument';
import type {NativeRegionDocument} from '../packages/app/src/game/regionDocument';
import {
  nativePortFootprint,
  nativeRailwayFootprint,
} from '../packages/app/src/city/life/nativeInfrastructure';
import {nativePortPlacementError} from '../packages/app/src/city/nativePortNavigation';
import {
  isDryFootprint,
  pointInPolygon,
} from '../packages/app/src/region/model/geometry';
import type {Point} from '../packages/app/src/region/model/types';

test.use({
  viewport: {width: 1600, height: 1000},
  reducedMotion: 'reduce',
  actionTimeout: 15000,
});
test.describe.configure({timeout: 90000});

async function documentFor(page: Page): Promise<NativeRegionDocument> {
  const saved = await page.evaluate(() => window.__cityLife.save());

  if (saved.version !== 3) {
    throw new Error('Infrastructure must use the same authored native world');
  }

  const document = readNativeRegionDocument(
    saved.definition.metadata?.['regionDocument'],
  );

  if (!document) {
    throw new Error('Missing ordinary root editor document');
  }

  return document;
}

async function worldClick(page: Page, point: Point): Promise<void> {
  await page.locator('#native-region-editor [data-action="overview"]').click();
  await page.evaluate(
    () =>
      new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const box = await page.locator('#city').boundingBox();
  const projected = await page.evaluate(
    point => window.__cityLife.project(point.x, 1, point.z),
    point,
  );

  if (!box) {
    throw new Error('Native root canvas is hidden');
  }

  const position = {x: box.x + projected.x, y: box.y + projected.y};

  expect(
    await page.evaluate(
      position => document.elementFromPoint(position.x, position.y)?.id,
      position,
    ),
  ).toBe('city');
  await page.mouse.click(position.x, position.y);
  await expect(page.locator('#native-region-editor')).not.toHaveAttribute(
    'aria-busy',
    'true',
  );
}

async function choose(page: Page, name: string): Promise<void> {
  await page
    .locator(`#native-region-editor [data-tool="${name}"]:visible`)
    .click();
}

async function start(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#open-region').click();
  await expect(page.locator('#native-region-editor')).toBeVisible();
  await expect(page.locator('#city')).toHaveAttribute(
    'data-life-ready',
    'true',
  );
  await page.evaluate(() => window.__cityLife.pause());
}

async function road(page: Page, first: Point, last: Point): Promise<void> {
  await choose(page, 'road');
  await worldClick(page, first);
  await expect(page.locator('#native-editor-status')).toContainText(
    'Начало выбрано',
  );
  await worldClick(page, last);
  await expect(page.locator('#native-editor-status')).toHaveText(
    'Изменение применено.',
  );
}

function validPort(document: NativeRegionDocument): {
  center: Point;
  yaw: number;
} {
  for (const polygon of document.terrain.water) {
    for (const point of polygon) {
      for (const yaw of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        const waterward = {x: Math.sin(yaw), z: Math.cos(yaw)};
        const center = {
          x: point.x + waterward.x * 8,
          z: point.z + waterward.z * 8,
        };
        const placement = {id: 'test-preview', center, yaw};

        if (
          !document.terrain.water.some(water =>
            pointInPolygon(
              {x: center.x + waterward.x * 40, z: center.z + waterward.z * 40},
              water,
            ),
          ) ||
          !isDryFootprint(document.terrain, nativePortFootprint(placement).land)
        ) {
          continue;
        }
        if (nativePortPlacementError(placement, document.terrain) === null) {
          return {center, yaw};
        }
      }
    }
  }

  throw new Error(
    'No legitimate source-size port shoreline found in the actual terrain',
  );
}

async function rotate(page: Page, yaw: number): Promise<void> {
  for (let turn = 0; turn < Math.round(yaw / (Math.PI / 2)); turn++) {
    await page
      .locator('#native-region-editor [data-action="rotate-placement"]')
      .click();
  }
}

async function saveReload(page: Page, name: RegExp) {
  const saved = await page.evaluate(() => window.__cityLife.save());

  await page.locator('#life-open').click();
  await page.locator('#life-save').click();
  await expect(page.locator('#life-save-status')).toContainText('сохранён');
  await page.locator('#life-close').click();
  await page.getByRole('link', {name: 'В главное меню', exact: true}).click();
  await page.locator('#menu-load-region').click();
  await page.getByRole('button', {name}).click();
  await expect(page.locator('#native-region-editor')).toBeVisible();
  expect(await page.evaluate(() => window.__cityLife.save())).toEqual(saved);

  return saved;
}

async function focusByMouse(page: Page, point: Point): Promise<void> {
  await choose(page, 'select');
  await page.locator('#native-region-editor [data-action="overview"]').click();

  for (let iteration = 0; iteration < 3; iteration++) {
    const projected = await page.evaluate(
      point => window.__cityLife.project(point.x, 1, point.z),
      point,
    );
    const box = await page.locator('#city').boundingBox();

    if (!box) {
      throw new Error('Hidden canvas');
    }

    const dx = box.width * 0.6 - projected.x;
    const dy = box.height * 0.5 - projected.y;

    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width * 0.7 + dx,
      box.y + box.height * 0.7 + dy,
      {steps: 12},
    );
    await page.mouse.up();
    await page.waitForTimeout(100);
  }

  const box = await page.locator('#city').boundingBox();

  if (!box) {
    throw new Error('Hidden canvas');
  }

  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.5);
  await page.mouse.wheel(0, -3600);
  await page.waitForTimeout(250);
}

test('ordinary root UI places a full native port, rejects inland placement and resumes paid cargo', async ({
  page,
}, testInfo) => {
  const workers: string[] = [];
  const errors: string[] = [];

  page.on('worker', worker => workers.push(worker.url()));
  page.on('pageerror', error => errors.push(error.message));
  await start(page);
  await choose(page, 'port');
  const original = await page.evaluate(() => window.__cityLife.save());

  await worldClick(page, {x: -1000, z: -1000});
  await expect(page.locator('#native-editor-status')).toContainText(
    'водного пути',
  );
  expect(await page.evaluate(() => window.__cityLife.save())).toEqual(original);
  const selected = validPort(await documentFor(page));

  await rotate(page, selected.yaw);
  await choose(page, 'port');
  await worldClick(page, selected.center);
  await expect(page.locator('#native-editor-status')).toHaveText(
    'Изменение применено.',
  );
  const document = await documentFor(page);
  const port = document.infrastructure!.ports[0]!;
  const world = await page.evaluate(() => window.__cityLife.save());

  expect(document.infrastructure!.ports).toHaveLength(1);
  expect(port.yaw).toBe(selected.yaw);
  expect(
    Math.hypot(
      port.center.x - selected.center.x,
      port.center.z - selected.center.z,
    ),
  ).toBeLessThan(3);
  expect(world.traffic.vehicles).toHaveLength(4);
  expect(world.population.people).toEqual(original.population.people);
  expect(world.population.businesses).toHaveLength(2);
  await writeFile(
    testInfo.outputPath('native-port-placement-world.json'),
    JSON.stringify(world),
  );
  expect(port.warehouseBuildingIds).toHaveLength(2);
  expect(port.navigation?.arrivals[0].length).toBeGreaterThan(2);
  await choose(page, 'select');
  await worldClick(page, port.center);
  await expect(page.locator('#harbor-panel')).toBeVisible();
  await expect(page.locator('#harbor-panel')).toHaveAttribute(
    'data-infrastructure-id',
    port.id,
  );
  await page.evaluate(() => window.__cityLife.advance(10));
  const active = await page.evaluate(() => window.__cityLife.snapshot());

  expect(active.ports).toHaveLength(1);
  expect(active.ports![0]!.snapshot.status.created).toBeGreaterThan(0);
  expect(active.ports![0]!.snapshot.ship.visible).toBe(true);
  await saveReload(page, /Новый регион.*689856/);

  if (!port.navigation) {
    throw new Error('Root UI lost the validated water path');
  }

  const arrival = port.navigation.arrivals[0];
  const travelSeconds =
    arrival
      .slice(1)
      .reduce(
        (length, point, index) =>
          length +
          Math.hypot(point.x - arrival[index]!.x, point.z - arrival[index]!.z),
        0,
      ) / port.navigation.speed;
  const resumed = await page.evaluate(
    seconds => window.__cityLife.advance(seconds),
    travelSeconds + 120,
  );

  expect(resumed.ports![0]!.snapshot.status.delivered).toBeGreaterThan(0);
  expect(
    resumed.ports![0]!.snapshot.cargo.every(
      cargo => Number.isFinite(cargo.pose.x) && Number.isFinite(cargo.pose.z),
    ),
  ).toBe(true);
  await focusByMouse(page, port.center);
  await page.screenshot({
    path: testInfo.outputPath('native-port-source-scene.png'),
  });
  await writeFile(
    testInfo.outputPath('native-port-evidence.json'),
    JSON.stringify(
      {
        port,
        footprint: nativePortFootprint(port),
        active,
        resumed,
        workers,
        errors,
      },
      null,
      2,
    ),
  );
  expect(workers).toHaveLength(1);
  expect(errors).toEqual([]);
  expect(new URL(page.url()).pathname).toBe('/');
});

test('ordinary root UI preserves full school/park/railway placement and resumes an actual native train', async ({
  page,
}, testInfo) => {
  const workers: string[] = [];
  const errors: string[] = [];

  page.on('worker', worker => workers.push(worker.url()));
  page.on('pageerror', error => errors.push(error.message));
  await start(page);
  await page.locator('#native-town-name').fill('Инфраструктура');
  await choose(page, 'found');
  await worldClick(page, {x: -1200, z: -600});
  await expect(page.locator('#native-town-heading')).toHaveText(
    'Инфраструктура',
  );
  const town = (await documentFor(page)).settlements[0]!;
  const center = {x: town.center.x, z: town.center.z + 120};

  await road(
    page,
    {x: center.x - 80, z: center.z - 22},
    {x: center.x + 150, z: center.z - 22},
  );
  await road(
    page,
    {x: center.x - 80, z: center.z + 22},
    {x: center.x + 150, z: center.z + 22},
  );
  await choose(page, 'school');
  await worldClick(page, center);
  await expect(page.locator('#native-editor-status')).toHaveText(
    'Изменение применено.',
  );
  await choose(page, 'park');
  await worldClick(page, {x: center.x + 100, z: center.z});
  await expect(page.locator('#native-editor-status')).toHaveText(
    'Изменение применено.',
  );
  await page.evaluate(() => window.__cityLife.advance(61));
  const schoolPark = await page.evaluate(() => window.__cityLife.save());

  if (schoolPark.version !== 3) {
    throw new Error('Lost native authored world');
  }

  expect(
    schoolPark.definition.profile.places.some(place => place.kind === 'school'),
  ).toBe(true);
  expect(
    schoolPark.definition.profile.places.some(place => place.kind === 'park'),
  ).toBe(true);
  const doc = await documentFor(page);

  expect(
    doc.blocks[0]!.templates.every(
      template => template.width > 0 && template.depth > 0 && template.kit,
    ),
  ).toBe(true);
  expect(doc.spaces).toHaveLength(1);
  await page.screenshot({
    path: testInfo.outputPath('native-school-park-root.png'),
  });
  await page.locator('#native-region-editor [data-mode="region"]').click();
  await choose(page, 'railway');
  const before = await page.evaluate(() => window.__cityLife.save());

  await worldClick(page, town.center);
  await expect(page.locator('#native-editor-status')).toContainText('занято');
  expect(await page.evaluate(() => window.__cityLife.save())).toEqual(before);
  await choose(page, 'railway');
  const stationCenter = {x: -1000, z: -1000};

  await worldClick(page, stationCenter);
  await expect(page.locator('#native-editor-status')).toHaveText(
    'Изменение применено.',
  );
  const station = (await documentFor(page)).infrastructure!.railways[0]!;

  await page.evaluate(() => window.__cityLife.advance(15));
  const arriving = await page.evaluate(() => window.__cityLife.snapshot());

  expect(arriving.railways).toHaveLength(1);
  expect(arriving.railways![0]!.snapshot.train.phase).toBe('arriving');
  await saveReload(page, /Инфраструктура.*689856/);
  const boarding = await page.evaluate(() => window.__cityLife.advance(25));

  expect(boarding.railways![0]!.status.arrivals).toBeGreaterThan(0);
  expect(boarding.railways![0]!.snapshot.train.doorsOpen).toBe(true);
  await choose(page, 'select');
  await worldClick(page, station.center);
  await expect(page.locator('#railway-panel')).toBeVisible();
  await expect(page.locator('#railway-panel')).toHaveAttribute(
    'data-infrastructure-id',
    station.id,
  );
  await focusByMouse(page, station.center);
  await page.screenshot({
    path: testInfo.outputPath('native-railway-source-scene.png'),
  });
  await writeFile(
    testInfo.outputPath('native-services-evidence.json'),
    JSON.stringify(
      {
        station,
        footprint: nativeRailwayFootprint(station),
        doc,
        schoolPark,
        arriving,
        boarding,
        workers,
        errors,
      },
      null,
      2,
    ),
  );
  expect(workers).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('an ordinary clone of the living region gains native services while preserving all original residents and accounts', async ({
  page,
}, testInfo) => {
  const path = process.env.NATIVE_INFRASTRUCTURE_LIVING_SAVE;

  if (!path) {
    test.skip(
      true,
      'NATIVE_INFRASTRUCTURE_LIVING_SAVE supplies an untouched living envelope',
    );

    return;
  }

  const source = parseGameSave(await readFile(path, 'utf8'));
  const id = 'native-living-region-with-services';
  const clone = createGameSave(id, 'Живой регион', source.world);
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
    {id, raw: JSON.stringify(clone)},
  );
  await page.locator('#menu-load-region').click();
  await page.getByRole('button', {name: /Живой регион.*689856/}).click();
  await expect(page.locator('#native-region-editor')).toBeVisible();
  await page.evaluate(() => window.__cityLife.pause());
  const original = await page.evaluate(() => window.__cityLife.save());

  if (original.version !== 3) {
    throw new Error('Living native fixture is not authored');
  }

  expect(original.population.people.length).toBe(1000);
  let doc =
    readNativeRegionDocument(
      original.definition.metadata?.['regionDocument'],
    ) ?? documentFromDefinition(original.definition, id);
  const town = doc.settlements[0]!;
  const findSpace = (kind: 'school' | 'park'): Point => {
    for (let x = -240; x <= 240; x += 40) {
      for (let z = -240; z <= 240; z += 40) {
        const center = {x: town.center.x + x, z: town.center.z + z};

        try {
          applyNativeEdit(
            doc,
            kind === 'school'
              ? {
                  type: 'block',
                  center,
                  settlementId: town.id,
                  district: 'commercial',
                  service: 'school',
                }
              : {type: 'park', center, settlementId: town.id},
            original.population.treasury,
            original.tick * 0.05,
          );

          return center;
        } catch {
          // Candidate is rejected by the same footprint/radius/road validator as UI.
        }
      }
    }

    throw new Error(
      `No valid full native ${kind} footprint in the actual town`,
    );
  };

  await page
    .locator('#native-town-list')
    .getByRole('button', {name: town.name, exact: true})
    .click();
  const school = findSpace('school');

  await choose(page, 'school');
  await worldClick(page, school);
  await expect(page.locator('#native-editor-status')).toHaveText(
    'Изменение применено.',
  );
  doc = await documentFor(page);
  await choose(page, 'park');
  await worldClick(page, findSpace('park'));
  await expect(page.locator('#native-editor-status')).toHaveText(
    'Изменение применено.',
  );
  doc = await documentFor(page);
  await page.locator('#native-region-editor [data-mode="region"]').click();
  const port = validPort(doc);

  await rotate(page, port.yaw);
  await choose(page, 'port');
  await worldClick(page, port.center);
  await expect(page.locator('#native-editor-status')).toHaveText(
    'Изменение применено.',
  );
  await rotate(page, Math.PI * 2 - port.yaw);
  await choose(page, 'railway');
  await worldClick(page, {x: -1000, z: -1000});
  await expect(page.locator('#native-editor-status')).toHaveText(
    'Изменение применено.',
  );
  const edited = await page.evaluate(() => window.__cityLife.save());

  expect(edited.population.people).toEqual(original.population.people);
  expect(edited.population.families).toEqual(original.population.families);
  expect(edited.population.cars).toEqual(original.population.cars);
  expect(edited.tick).toBe(original.tick);
  expect(edited.population.treasury).toBeLessThan(original.population.treasury);
  await page.locator('#life-open').click();
  await page.locator('#life-save').click();
  await expect(page.locator('#life-save-status')).toContainText('сохранён');
  await page.locator('#life-close').click();
  await page.screenshot({
    path: testInfo.outputPath('living-native-region-with-services.png'),
  });
  const exported = createGameSave(id, 'Живой регион', edited);
  const output = process.env.NATIVE_INFRASTRUCTURE_OUTPUT_SAVE;

  if (output) {
    await writeFile(output, JSON.stringify(exported));
  }

  await writeFile(
    testInfo.outputPath('living-native-service-receipt.json'),
    JSON.stringify(
      {
        sourceId: source.id,
        cloneId: id,
        population: edited.population.people.length,
        originalTreasury: original.population.treasury,
        editedTreasury: edited.population.treasury,
        unchangedPeople: true,
        unchangedFamilies: true,
        unchangedCars: true,
        document: await documentFor(page),
        workers,
      },
      null,
      2,
    ),
  );
  expect(workers).toHaveLength(1);
});
