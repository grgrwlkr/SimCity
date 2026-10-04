import {expect, test, type Page} from '@playwright/test';
import type {
  Point,
  RegionState,
} from '../../../packages/app/src/region/model/types';

declare global {
  interface Window {
    __regionEditor?: {
      snapshot(): RegionState;
      project(point: Point): {x: number; y: number};
      terrainProbe(): {
        land: Point;
        secondLand: Point;
        water: Point;
        boundary: Point;
      };
      frameTimes(): readonly number[];
    };
  }
}
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

test('player founds settlements, draws roads and zones, and restores a saved region', async ({
  page,
}) => {
  const errors: string[] = [];

  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true', {
    timeout: 5000,
  });
  const probe = await page.evaluate(() =>
    window.__regionEditor!.terrainProbe(),
  );

  await page
    .getByRole('button', {name: 'Основать поселение', exact: true})
    .click();
  await page.locator('#settlement-name').fill('Север');
  await clickWorld(page, probe.land);
  await expect(page.locator('#settlement-count')).toHaveText('1');
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'city');
  await page.getByRole('button', {name: 'Режим региона', exact: true}).click();
  await page
    .getByRole('button', {name: 'Основать поселение', exact: true})
    .click();
  await page.locator('#settlement-name').fill('Юг');
  await clickWorld(page, probe.secondLand);
  await expect(page.locator('#settlement-count')).toHaveText('2');
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'city');
  await page.getByRole('button', {name: 'Режим региона', exact: true}).click();
  await page.getByRole('button', {name: 'Дорога', exact: true}).click();
  await clickWorld(page, {x: probe.land.x + 64, z: probe.land.z + 48});
  await clickWorld(page, {
    x: probe.secondLand.x - 64,
    z: probe.secondLand.z + 48,
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('#road-count')).toHaveText('3');
  await page
    .getByRole('button', {name: 'Открыть город Север', exact: true})
    .click();
  await expect(page.locator('#city-name')).toHaveText('Север');
  await page.getByRole('button', {name: 'Жилая зона', exact: true}).click();
  const from = await page.evaluate(p => window.__regionEditor!.project(p), {
    x: probe.land.x + 100,
    z: probe.land.z + 56,
  });
  const to = await page.evaluate(p => window.__regionEditor!.project(p), {
    x: probe.land.x + 250,
    z: probe.land.z + 88,
  });

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, {steps: 6});
  await page.mouse.up();
  await expect
    .poll(async () => (await snapshot(page)).parcels.length)
    .toBeGreaterThan(0);
  await page.locator('#settlement-select').selectOption({label: 'Юг'});
  await expect(page.locator('#city-name')).toHaveText('Юг');
  await page.getByRole('button', {name: 'Склад', exact: true}).click();
  await clickWorld(page, {
    x: probe.secondLand.x + 30,
    z: probe.secondLand.z + 68,
  });
  await expect(page.locator('#warehouse-count')).toHaveText('1');
  const before = await snapshot(page);

  await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.locator('#region-status')).toContainText('Регион сохранён');
  await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
  await page.locator('#save-select').selectOption(before.id);
  await page
    .getByRole('button', {name: 'Открыть сохранение', exact: true})
    .click();
  await expect(page.locator('#region-status')).toContainText(
    'Регион восстановлен',
  );
  expect(await snapshot(page)).toEqual(before);
  await page.screenshot({path: test.info().outputPath('region-editor.png')});
  await page.getByRole('button', {name: 'Ночь', exact: true}).click();
  await page.screenshot({path: test.info().outputPath('region-night.png')});
  await page.getByRole('button', {name: 'День', exact: true}).click();
  await page
    .getByRole('button', {name: 'К поселению', exact: true})
    .first()
    .click();
  await page.screenshot({path: test.info().outputPath('region-close.png')});
  expect(errors).toEqual([]);
});
test('water refusal and camera cancellation do not change the world', async ({
  page,
}) => {
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  const probe = await page.evaluate(() =>
    window.__regionEditor!.terrainProbe(),
  );
  const before = await snapshot(page);

  await page
    .getByRole('button', {name: 'Основать поселение', exact: true})
    .click();
  await clickWorld(page, probe.water);
  await expect(page.locator('#region-status')).toContainText('вод');
  expect(await snapshot(page)).toEqual(before);
  await page.getByRole('button', {name: 'Дорога', exact: true}).click();
  await clickWorld(page, probe.land);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  expect((await snapshot(page)).roads).toHaveLength(0);
  const pixel = await page.evaluate(
    p => window.__regionEditor!.project(p),
    probe.land,
  );

  await page.keyboard.down('Space');
  await page.mouse.move(pixel.x, pixel.y);
  await page.mouse.down();
  await page.mouse.move(pixel.x + 100, pixel.y + 50, {steps: 5});
  await page.mouse.up();
  await page.keyboard.up('Space');
  expect(await snapshot(page)).toEqual(before);
  await page.setViewportSize({width: 1280, height: 800});
  await page.screenshot({path: test.info().outputPath('region-desktop.png')});
});

test('lost capture cancels a placement before mouse release', async ({
  page,
}) => {
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  const probe = await page.evaluate(() =>
    window.__regionEditor!.terrainProbe(),
  );

  await page
    .getByRole('button', {name: 'Основать поселение', exact: true})
    .click();
  const pixel = await page.evaluate(
    p => window.__regionEditor!.project(p),
    probe.land,
  );

  await page.mouse.move(pixel.x, pixel.y);
  await page.mouse.down();
  // Activate pending capture before explicitly losing it on a later event.
  await page.mouse.move(pixel.x + 1, pixel.y);
  await page.evaluate(() => {
    const canvas = document.querySelector('#region');

    if (canvas instanceof HTMLCanvasElement) {
      canvas.releasePointerCapture(1);
    }
  });
  await page.mouse.up();
  await page.waitForTimeout(150);
  expect((await snapshot(page)).settlements).toHaveLength(0);
});

test('Space pressed during a construction drag starts panning and prevents building', async ({
  page,
}) => {
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  const probe = await page.evaluate(() =>
    window.__regionEditor!.terrainProbe(),
  );

  await page.getByRole('button', {name: 'Дорога', exact: true}).click();
  const before = await page.evaluate(
    p => window.__regionEditor!.project(p),
    probe.land,
  );

  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await page.keyboard.down('Space');
  await page.mouse.move(before.x + 100, before.y + 50, {steps: 8});
  await page.mouse.up();
  await page.keyboard.up('Space');
  const after = await page.evaluate(
    p => window.__regionEditor!.project(p),
    probe.land,
  );

  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(
    20,
  );
  await page.keyboard.press('Enter');
  expect((await snapshot(page)).roads).toHaveLength(0);
});

test('automatic restore keeps editing disabled until storage completes', async ({
  page,
}) => {
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  const probe = await page.evaluate(() =>
    window.__regionEditor!.terrainProbe(),
  );

  await page
    .getByRole('button', {name: 'Основать поселение', exact: true})
    .click();
  await page.locator('#settlement-name').fill('Сохранённый');
  await clickWorld(page, probe.land);
  await expect(page.locator('#settlement-count')).toHaveText('1');
  await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.locator('#region-status')).toContainText('Регион сохранён');
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      IDBTransaction.prototype,
      'oncomplete',
    );

    if (!descriptor?.set) {
      throw new Error('Missing transaction completion setter');
    }

    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      ...descriptor,
      set(this: IDBTransaction, callback: ((event: Event) => void) | null) {
        descriptor.set?.call(
          this,
          callback
            ? function (this: IDBTransaction, event: Event) {
                document.body.dataset['storagePending'] = 'true';
                setTimeout(() => callback.call(this, event), 700);
              }
            : null,
        );
      },
    });
  });
  await page.reload({waitUntil: 'domcontentloaded'});
  await expect(page.locator('body')).toHaveAttribute(
    'data-storage-pending',
    'true',
  );
  await expect(page.locator('#main-menu')).toBeVisible();
  await expect(page.locator('#game-shell')).toHaveAttribute('inert', '');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'false', {
    timeout: 100,
  });
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  expect((await snapshot(page)).settlements.map(s => s.name)).toEqual([
    'Сохранённый',
  ]);
});

test('town hall owns its starter road and reserves its future building land', async ({
  page,
}) => {
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  const probe = await page.evaluate(() =>
    window.__regionEditor!.terrainProbe(),
  );

  await page
    .getByRole('button', {name: 'Основать поселение', exact: true})
    .click();
  await page.locator('#settlement-name').fill('Речной');
  await clickWorld(page, probe.land);
  await expect(page.locator('#settlement-count')).toHaveText('1');
  await expect(page.locator('#road-count')).toHaveText('1');
  const founded = await snapshot(page);

  await page.getByRole('button', {name: 'Выбор', exact: true}).click();
  await clickWorld(page, probe.land);
  await expect(page.locator('#selection-title')).toContainText('Ратуша');
  await expect(page.locator('#selection-detail')).toContainText('96 × 80');
  await page.getByRole('button', {name: 'Дорога', exact: true}).click();
  await clickWorld(page, {x: probe.land.x - 40, z: probe.land.z});
  await clickWorld(page, {x: probe.land.x + 40, z: probe.land.z});
  await page.keyboard.press('Enter');
  await expect(page.locator('#region-status')).toContainText('занято');
  expect(await snapshot(page)).toEqual(founded);
  await page.getByRole('button', {name: 'Снос', exact: true}).click();
  await clickWorld(page, {x: probe.land.x, z: probe.land.z + 48});
  await expect(page.locator('#settlement-count')).toHaveText('0');
  await expect(page.locator('#road-count')).toHaveText('0');
});

test('WASD and QE move the camera without editing the map or stealing text input', async ({
  page,
}) => {
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  const probe = await page.evaluate(() =>
    window.__regionEditor!.terrainProbe(),
  );
  const initial = await snapshot(page);
  const before = await page.evaluate(
    p => window.__regionEditor!.project(p),
    probe.land,
  );

  await page.locator('#region').focus();
  await page.keyboard.down('KeyW');
  await page.waitForFunction(
    ({point, old}) => {
      const now = window.__regionEditor!.project(point);

      return Math.hypot(now.x - old.x, now.y - old.y) > 10;
    },
    {point: probe.land, old: before},
  );
  await page.keyboard.up('KeyW');
  const moved = await page.evaluate(
    p => window.__regionEditor!.project(p),
    probe.land,
  );

  expect(Math.hypot(moved.x - before.x, moved.y - before.y)).toBeGreaterThan(
    10,
  );
  await page.keyboard.down('KeyQ');
  await page.waitForFunction(
    ({point, old}) => {
      const now = window.__regionEditor!.project(point);

      return Math.hypot(now.x - old.x, now.y - old.y) > 8;
    },
    {point: probe.land, old: moved},
  );
  await page.keyboard.up('KeyQ');
  await page
    .getByRole('button', {name: 'Основать поселение', exact: true})
    .click();
  await page.locator('#settlement-name').fill('');
  const beforeTyping = await page.evaluate(
    p => window.__regionEditor!.project(p),
    probe.land,
  );

  await page.keyboard.type('wasdqe');
  await expect(page.locator('#settlement-name')).toHaveValue('wasdqe');
  const editing = await page.evaluate(
    p => window.__regionEditor!.project(p),
    probe.land,
  );

  expect(editing.x).toBeCloseTo(beforeTyping.x, 5);
  expect(editing.y).toBeCloseTo(beforeTyping.y, 5);
  expect(await snapshot(page)).toEqual(initial);
});
