import {expect, test} from '@playwright/test';
import {launchPackaged} from './launchPackaged';
import {
  RELEASE_APP,
  TEST_APP,
  buildInfoOf,
  makeInspectableClone,
  requireBuild,
} from './inspectableClone';

let APP = '';

test.beforeAll(async () => {
  requireBuild(TEST_APP);
  requireBuild(RELEASE_APP);
  const {test: isTest, ...tested} = buildInfoOf(TEST_APP);
  const {test: isRelease, ...release} = buildInfoOf(RELEASE_APP);

  expect({isTest, isRelease}).toEqual({isTest: true, isRelease: false});
  expect(tested).toEqual(release);
  APP = await makeInspectableClone(TEST_APP);
});

test('the hidden packaged app keeps the original city accessible through the prototype link', async () => {
  const app = await launchPackaged(APP);

  try {
    const page = await app.firstWindow({timeout: 30_000});
    const errors: string[] = [];
    const workers: string[] = [];

    page.on('pageerror', error => errors.push(error.message));
    page.on('worker', worker => workers.push(worker.url()));
    await expect(
      page.getByRole('navigation', {name: 'Главное меню'}),
    ).toBeVisible();
    const shown = await app.evaluate(({app: a, BrowserWindow}) => ({
      windows: BrowserWindow.getAllWindows().map(w => ({
        visible: w.isVisible(),
        focused: w.isFocused(),
      })),
      dock: a.dock?.isVisible() ?? false,
    }));

    expect(shown).toEqual({
      windows: [{visible: false, focused: false}],
      dock: false,
    });
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await page
      .getByRole('link', {name: 'Город у воды — прототип', exact: true})
      .click();
    await expect(page).toHaveURL('app://bundle/city/?seed=689856');
    await expect(page.locator('#city')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('#city')).toHaveAttribute(
      'data-life-ready',
      'true',
    );
    await expect(page.locator('#life-count')).toHaveText(/54[0-9]/);
    await expect(
      page.getByRole('button', {name: 'Работающий порт'}),
    ).toBeVisible();
    const painted = await app.evaluate(
      () => (globalThis as {simcityPaintCount?: number}).simcityPaintCount ?? 0,
    );

    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as {simcityPaintCount?: number}).simcityPaintCount ?? 0,
        ),
      )
      .toBeGreaterThan(painted);
    expect(
      await page.evaluate(
        () =>
          '__sim' in window ||
          '__regionEditor' in window ||
          '__cityLife' in window,
      ),
    ).toBe(false);
    await page.locator('#life-open').click();
    await page.getByLabel('Житель города', {exact: true}).selectOption('0');
    await expect(page.locator('#resident-name')).toHaveText('Андрей Соколов');
    await page.locator('#life-save').click();
    await expect(page.locator('#life-save-status')).toContainText(
      'Город сохранён',
    );
    await page.locator('#life-load').click();
    await expect(page.locator('#life-save-status')).toContainText(
      'восстановлена',
    );
    await expect(
      page.getByLabel('Продолжить движение', {exact: true}),
    ).toBeVisible();
    await page.screenshot({path: test.info().outputPath('desktop-life.png')});
    await page.getByRole('link', {name: 'В главное меню'}).click();
    await expect(
      page.getByRole('navigation', {name: 'Главное меню'}),
    ).toBeVisible();
    expect(workers).toHaveLength(1);
    expect(new URL(workers[0]!).protocol).toBe('app:');
    expect(new URL(workers[0]!).hostname).toBe('bundle');
    expect(new URL(workers[0]!).pathname).toMatch(/^\/assets\/worker-.+\.js$/);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
