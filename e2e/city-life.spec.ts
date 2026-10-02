import { expect, test } from '@playwright/test';
import type { LifeFrame } from '../packages/app/src/city/life/types';
import type { CityLife } from '../packages/app/src/city/life/world';
type Save = ReturnType<CityLife['save']>;
declare global {
  interface Window {
    __cityLife: {
      snapshot(): LifeFrame;
      advance(seconds: number): Promise<LifeFrame>;
      save(): Promise<Save>;
      load(save: unknown): Promise<void>;
      select(id: number): void;
      pause(): void;
      project(x: number, y: number, z: number): { x: number; y: number };
    };
  }
}
test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });

test('a resident owns a real car, commutes, earns and returns with persistent identity', async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/city/?seed=689856&view=houses');
  await expect(page.locator('#city')).toHaveAttribute('data-life-ready', 'true');
  const initial = await page.evaluate(() => window.__cityLife.save());
  expect(initial.population.people).toHaveLength(540);
  const carOwner = initial.population.people[0]!,
    family = initial.population.families[carOwner.family]!;
  expect(family.cars).toHaveLength(1);
  await page.locator('#life-open').click();
  await page.getByLabel('Житель города', { exact: true }).selectOption(String(carOwner.id));
  await expect(page.locator('#resident-name')).toHaveText(carOwner.name);
  await expect(page.locator('#resident-family button')).toHaveCount(3);
  await page.locator('#resident-follow').click();
  const a = await page.evaluate(() => window.__cityLife.advance(24));
  expect(a.selected?.person.trip?.purpose).toBe('work');
  expect(a.selected?.person.activity).toBe('drive');
  expect(a.cars.find((c) => c.id === family.cars[0])?.driver).toBe(carOwner.id);
  await expect(page.locator('#top-view')).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const f = window.__cityLife.snapshot(),
          p = f.people.find((p) => p.id === 0)!;
        const screen = window.__cityLife.project(p.x, p.y, p.z);
        return Math.hypot(screen.x - innerWidth / 2, screen.y - innerHeight / 2);
      }),
    )
    .toBeLessThan(6);
  await page.screenshot({ path: test.info().outputPath('life-commute.png') });
  const b = await page.evaluate(() => window.__cityLife.advance(15));
  expect(b.people.find((p) => p.id === carOwner.id)?.x).not.toBe(a.people.find((p) => p.id === carOwner.id)?.x);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const f = window.__cityLife.snapshot(),
          p = f.people.find((p) => p.id === 0)!;
        const screen = window.__cityLife.project(p.x, p.y, p.z);
        return Math.hypot(screen.x - innerWidth / 2, screen.y - innerHeight / 2);
      }),
    )
    .toBeLessThan(6);
  await page.screenshot({ path: test.info().outputPath('life-commute-next.png') });
  const atWork = await page.evaluate(() => window.__cityLife.advance(560));
  expect(atWork.selected?.person.activity).toBe('work');
  const ownedCar = atWork.cars.find((c) => c.id === family.cars[0])!;
  expect(ownedCar.visible).toBe(false); // Parked in the actual underground garage.
  expect(atWork.selected?.cars[0]?.place).toContain('Паркинг');
  await page.locator('#parking-toggle').click();
  await expect(page.getByRole('region', { name: 'Парковки города', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('life-parking.png') });
  await page.locator('#parking-close').click();
  const evening = await page.evaluate(() => window.__cityLife.advance(2401));
  expect(evening.selected?.person.activity).toBe('home');
  expect(evening.selected?.person.earnings).toBeGreaterThan(0);
  expect(evening.selected?.cars[0]?.id).toBe(family.cars[0]);
  expect(evening.selected?.person.history.some((e) => e.text.includes('зарплата'))).toBe(true);
  const cityDay = await page.evaluate(() => window.__cityLife.save());
  expect(cityDay.population.people.some((p) => p.history.some((e) => e.text.includes('Куплены продукты')))).toBe(true);
  expect(evening.arrived).toBeGreaterThan(0);
  await page.locator('#life-save').click();
  await expect(page.locator('#life-save-status')).toContainText('Город сохранён');
  const before = await page.evaluate(() => window.__cityLife.save());
  await page.reload();
  await expect(page.locator('#city')).toHaveAttribute('data-life-ready', 'true');
  await page.locator('#life-open').click();
  await page.locator('#life-load').click();
  await expect(page.locator('#life-save-status')).toContainText('восстановлена');
  const after = await page.evaluate(() => window.__cityLife.save());
  expect(after).toEqual(before);
  await page.getByLabel('Житель города', { exact: true }).selectOption('0');
  await page.getByRole('button', { name: 'Ночь', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('life-family-night.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('#resident-name')).toBeInViewport();
  await expect(page.locator('#life-time')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('life-family-desktop.png') });
  expect(errors).toEqual([]);
});

test('pause stops the worker and speed controls advance its clock', async ({ page }) => {
  await page.goto('/city/?seed=689856');
  await expect(page.locator('#city')).toHaveAttribute('data-life-ready', 'true');
  const before = await page.evaluate(() => window.__cityLife.snapshot().seconds);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__cityLife.snapshot().seconds)).toBe(before);
  await page.locator('[data-speed="20"]').click();
  await expect.poll(() => page.evaluate(() => window.__cityLife.snapshot().seconds)).toBeGreaterThan(before + 2);
  await page.getByLabel('Остановить движение', { exact: true }).click();
  await page.waitForTimeout(150);
  const saved = await page.evaluate(() => window.__cityLife.snapshot().seconds);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__cityLife.snapshot().seconds)).toBe(saved);
  await expect(page.locator('#scene-error')).toBeHidden();
});
