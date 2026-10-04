import {readFile, writeFile} from 'node:fs/promises';
import {expect, test, type Page} from '@playwright/test';
import {parseGameSave} from '../packages/app/src/game/save';
import type {LifeFrame} from '../packages/app/src/city/life/types';

test.use({viewport: {width: 1600, height: 1000}});

async function frameIntervals(page: Page, duration: number): Promise<number[]> {
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
    duration,
  );
}

function movedResidents(before: LifeFrame, after: LifeFrame): number[] {
  const old = new Map(before.people.map(person => [person.id, person]));

  return after.people
    .filter(person => {
      const prior = old.get(person.id);

      return (
        prior !== undefined &&
        Math.hypot(person.x - prior.x, person.z - prior.z) > 0.01
      );
    })
    .map(person => person.id);
}

test('a real active native region sustains 30 FPS near both cities', async ({
  page,
}) => {
  const input = process.env.NATIVE_REGION_PERFORMANCE_SAVE;

  if (!input) {
    test.skip(
      true,
      'Supply an actual active native game save, not a fabricated population',
    );

    return;
  }

  test.setTimeout(180_000);
  const raw = await readFile(input, 'utf8');
  const game = parseGameSave(raw);

  expect(game.world.version).toBe(3);
  expect(game.world.population.people.length).toBeGreaterThanOrEqual(1000);

  if (game.world.version !== 3) {
    throw new Error('An authored v3 save is required');
  }

  expect(game.world.definition.layout.buildings.length).toBeGreaterThanOrEqual(
    200,
  );
  expect(
    game.world.population.people.some(person => person.trip !== null),
  ).toBe(true);
  const errors: string[] = [];
  const workers: string[] = [];

  page.on('pageerror', error => errors.push(error.message));
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
  await page.locator('.save-card').click();
  await expect(page.locator('#city')).toHaveAttribute(
    'data-life-ready',
    'true',
    {timeout: 30_000},
  );
  await expect(page.locator('#native-region-editor')).toBeVisible();
  await page.locator('#native-region-editor [data-mode="region"]').click();
  const names = await page
    .locator('#native-town-list button')
    .allTextContents();

  expect(names.length).toBeGreaterThanOrEqual(2);
  const results: Array<Record<string, unknown>> = [];

  for (const [index, name] of names.slice(0, 2).entries()) {
    await page.locator('#native-region-editor [data-mode="region"]').click();
    await page
      .locator('#native-town-list')
      .getByRole('button', {name, exact: true})
      .click();
    await page.locator('#motion').click();
    await expect(page.locator('#motion')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await frameIntervals(page, 2000);
    const before = await page.evaluate(() => window.__cityLife.snapshot());

    await page.screenshot({
      path: test.info().outputPath(`native-city-${index}-before.png`),
    });
    const intervals = await frameIntervals(page, 8000);
    const after = await page.evaluate(() => window.__cityLife.snapshot());

    await page.screenshot({
      path: test.info().outputPath(`native-city-${index}-after.png`),
    });
    expect(intervals.length).toBeGreaterThanOrEqual(200);
    const meanMs =
      intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
    const sorted = [...intervals].sort((a, b) => a - b);
    const moved = movedResidents(before, after);
    const environment = await page.evaluate(() => {
      const canvas = document.getElementById('city') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl2');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      const renderer: unknown = debug
        ? gl?.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : null;

      return {
        dpr: devicePixelRatio,
        viewport: {width: innerWidth, height: innerHeight},
        canvas: {width: canvas.width, height: canvas.height},
        renderer: typeof renderer === 'string' ? renderer : null,
      };
    });
    const visibleMoved = await page.evaluate(ids => {
      const frame = window.__cityLife.snapshot();
      const moved = new Set(ids);

      return frame.people
        .filter(person => {
          const vehicle = frame.cars.find(
            car => car.driver === person.id && car.visible,
          );

          if (!moved.has(person.id) || (!person.visible && !vehicle)) {
            return false;
          }

          const pixel = window.__cityLife.project(person.x, person.y, person.z);

          return (
            pixel.x >= 0 &&
            pixel.x <= innerWidth &&
            pixel.y >= 0 &&
            pixel.y <= innerHeight
          );
        })
        .map(person => person.id);
    }, moved);
    const result = {
      city: name,
      fps: 1000 / meanMs,
      meanMs,
      p95Ms: sorted[Math.floor((sorted.length - 1) * 0.95)],
      maxMs: sorted.at(-1),
      intervals,
      physicalSeconds: after.seconds - before.seconds,
      walking: after.walking,
      driving: after.driving,
      movedIds: moved,
      visibleMovedIds: visibleMoved,
      people: after.population,
      environment,
    };

    results.push(result);
    await writeFile(
      test.info().outputPath(`native-city-${index}-metrics.json`),
      JSON.stringify(result, null, 2),
    );
    expect
      .soft(
        after.seconds - before.seconds,
        'Native worker must advance during rendered frames',
      )
      .toBeGreaterThan(0);
    expect
      .soft(
        moved.length,
        'Actual resident positions must move during measurement',
      )
      .toBeGreaterThan(0);
    expect
      .soft(
        visibleMoved.length,
        'Traffic must be visible in the measured city, not only elsewhere in the region',
      )
      .toBeGreaterThan(0);
    expect
      .soft(1000 / meanMs, 'All frame stalls are included in the mean FPS')
      .toBeGreaterThanOrEqual(30);
    await page.locator('#motion').click();
    await expect(page.locator('#motion')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }

  await writeFile(
    test.info().outputPath('native-region-performance.json'),
    JSON.stringify(results, null, 2),
  );
  expect(workers).toHaveLength(1);
  expect(errors).toEqual([]);
});
