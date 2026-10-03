import {readFile, writeFile} from 'node:fs/promises';
import {expect, test, type Page} from '@playwright/test';
import {parseRegion} from '../packages/app/src/region/model/save';
import {gameMinute} from '../packages/app/src/region/model/life/economy';
import {regionalPopulation} from '../packages/app/src/region/model/life/residents';
import type {RegionState} from '../packages/app/src/region/model/types';

interface FrameMetrics {
  view: string;
  fps: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  intervalsMs: number[];
  elapsedGameSeconds: number;
  activeTripsBefore: number;
  activeTripsAfter: number;
  movingTripIds: string[];
}

test.use({viewport: {width: 1440, height: 1000}});

async function snapshot(page: Page): Promise<RegionState> {
  return page.evaluate(() => window.__regionEditor!.snapshot());
}

async function seedSave(page: Page, id: string, value: string): Promise<void> {
  await page.evaluate(
    async record => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('simcity-regions', 1);

        open.onupgradeneeded = () => open.result.createObjectStore('regions');
        open.onerror = () =>
          reject(open.error ?? new Error('Cannot open saves'));

        open.onsuccess = () => {
          const db = open.result;
          const transaction = db.transaction('regions', 'readwrite');

          transaction.objectStore('regions').put(record.value, record.id);

          transaction.oncomplete = () => {
            db.close();
            resolve();
          };

          transaction.onerror = () => {
            db.close();
            reject(
              transaction.error ?? new Error('Cannot prepare saved region'),
            );
          };
        };
      });
    },
    {id, value},
  );
}

/** Collect every frame during the window, including stalls and long outliers. */
async function frames(page: Page, milliseconds: number): Promise<number[]> {
  return page.evaluate(
    duration =>
      new Promise<number[]>(resolve => {
        const intervals: number[] = [];
        let started: number | null = null;
        let previous: number | null = null;
        const sample = (now: number) => {
          started ??= now;

          if (previous !== null) {
            intervals.push(now - previous);
          }

          previous = now;

          if (now - started >= duration) {
            resolve(intervals);
          } else {
            requestAnimationFrame(sample);
          }
        };

        requestAnimationFrame(sample);
      }),
    milliseconds,
  );
}

async function measure(page: Page, view: string): Promise<FrameMetrics> {
  await frames(page, 1500);
  const before = await snapshot(page);

  await page.screenshot({path: test.info().outputPath(`${view}-before.png`)});
  const intervalsMs = await frames(page, 5000);
  const after = await snapshot(page);

  await page.screenshot({path: test.info().outputPath(`${view}-after.png`)});
  expect(intervalsMs.length).toBeGreaterThan(0);
  const meanMs =
    intervalsMs.reduce((sum, interval) => sum + interval, 0) /
    intervalsMs.length;
  const sorted = [...intervalsMs].sort((a, b) => a - b);
  const oldTrips = new Map(before.life.trips.map(trip => [trip.id, trip]));
  const movingTripIds = after.life.trips
    .filter(trip => {
      const old = oldTrips.get(trip.id);

      return (
        old !== undefined &&
        (Math.abs(trip.distance - old.distance) > 0.01 ||
          Math.hypot(trip.pose.x - old.pose.x, trip.pose.z - old.pose.z) > 0.01)
      );
    })
    .map(trip => trip.id);
  const result: FrameMetrics = {
    view,
    fps: 1000 / meanMs,
    meanMs,
    p95Ms: sorted[Math.floor((sorted.length - 1) * 0.95)]!,
    maxMs: sorted.at(-1)!,
    intervalsMs,
    elapsedGameSeconds: after.life.elapsedSeconds - before.life.elapsedSeconds,
    activeTripsBefore: before.life.trips.length,
    activeTripsAfter: after.life.trips.length,
    movingTripIds,
  };

  await writeFile(
    test.info().outputPath(`${view}-frames.json`),
    JSON.stringify(result, null, 2),
  );
  await writeFile(
    test.info().outputPath(`${view}-motion.json`),
    JSON.stringify(
      {before: before.life.trips, after: after.life.trips},
      null,
      2,
    ),
  );
  expect
    .soft(
      result.elapsedGameSeconds,
      `${view}: simulation must advance during frame measurement`,
    )
    .toBeGreaterThan(0);
  expect
    .soft(
      result.movingTripIds.length,
      `${view}: actual trip positions must change`,
    )
    .toBeGreaterThan(0);
  expect
    .soft(
      result.fps,
      `${view}: mean FPS including all stalls (p95 ${result.p95Ms.toFixed(1)} ms)`,
    )
    .toBeGreaterThanOrEqual(30);

  return result;
}

function intercityTrips(state: RegionState): number {
  const cities = new Map(
    state.life.buildings.map(building => [building.id, building.settlementId]),
  );

  return state.life.trips.filter(trip => {
    const origin = cities.get(trip.fromId);
    const destination = cities.get(trip.toId);

    return (
      origin !== undefined &&
      destination !== undefined &&
      origin !== destination
    );
  }).length;
}

test('a saved region with 1000 residents and 200 buildings sustains 30 FPS with real traffic', async ({
  page,
}) => {
  test.skip(
    !process.env.REGION_PERF_SAVE,
    'Set REGION_PERF_SAVE to a real simulated v3 region save',
  );
  test.setTimeout(180_000);
  const file = process.env.REGION_PERF_SAVE;

  if (!file) {
    throw new Error('REGION_PERF_SAVE is required');
  }

  // The opt-in fixture must exist and validate; no fabricated fallback population.
  const raw = await readFile(file, 'utf8');
  const envelope: unknown = JSON.parse(raw);

  expect(envelope).toMatchObject({
    kind: 'simcity-region',
    version: 3,
    state: {schemaVersion: 3},
  });
  const stored = parseRegion(raw);

  expect(regionalPopulation(stored)).toBeGreaterThanOrEqual(1000);
  expect(
    stored.life.buildings.filter(building => building.stage === 'ready').length,
  ).toBeGreaterThanOrEqual(200);
  expect(stored.settlements.length).toBeGreaterThanOrEqual(2);
  const errors: string[] = [];

  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await seedSave(page, stored.id, raw);
  await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
  await expect(page.locator('.save-card')).toHaveCount(1);
  await page.locator('.save-card').click();
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  expect(await snapshot(page)).toEqual(stored);
  await page.getByLabel('Скорость симуляции').selectOption('120');
  await page.getByRole('button', {name: 'Запустить симуляцию'}).click();
  await expect
    .poll(
      async () => {
        const current = await snapshot(page);
        const minute = gameMinute(current) % 1440;

        return (
          intercityTrips(current) > 0 ||
          (minute >= 520 && minute <= 535 && current.life.trips.length > 0)
        );
      },
      {timeout: 100_000, intervals: [250]},
    )
    .toBe(true);
  await page.getByRole('button', {name: 'Приостановить симуляцию'}).click();
  // Saving shares the worker queue and waits for the one already submitted batch.
  await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.locator('#region-status')).toContainText('сохранён');
  await page.getByLabel('Скорость симуляции').selectOption('1');
  await page.getByRole('button', {name: 'Запустить симуляцию'}).click();
  const results: FrameMetrics[] = [];

  for (const [index, city] of stored.settlements.slice(0, 2).entries()) {
    await page.getByRole('button', {name: 'Режим региона'}).click();
    await page
      .getByRole('button', {name: `Открыть город ${city.name}`, exact: true})
      .click();
    await page
      .getByRole('button', {name: 'Приблизить', exact: true})
      .click({clickCount: 2});
    results.push(await measure(page, `city-${index + 1}`));
  }

  await page.getByRole('button', {name: 'Приостановить симуляцию'}).click();
  await writeFile(
    test.info().outputPath('regional-performance.json'),
    JSON.stringify(
      {
        fixture: file,
        residents: regionalPopulation(stored),
        readyBuildings: stored.life.buildings.filter(
          building => building.stage === 'ready',
        ).length,
        results,
      },
      null,
      2,
    ),
  );
  expect(errors).toEqual([]);
});
