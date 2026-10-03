import {expect, test} from '@playwright/test';
import {createLifeProfile} from '../packages/app/src/city/life/network';
import {generateCity} from '../packages/app/src/city/generator';

test.use({viewport: {width: 1280, height: 900}, reducedMotion: 'reduce'});

test('compact curb parking stays readable beside houses and inside the city', async ({
  page,
}) => {
  const errors: string[] = [];

  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/city/?seed=689856&view=houses');
  await expect(page.locator('#city')).toHaveAttribute(
    'data-life-ready',
    'true',
  );
  const profile = createLifeProfile(generateCity('689856'));
  const state = await page.evaluate(() => window.__cityLife.save());
  const slot = state.parking
    .filter(
      s =>
        s.occupant !== null &&
        profile.facilities[s.facility]!.kind === 'street',
    )
    .sort(
      (a, b) =>
        Math.abs(a.position.x + 119) +
        Math.abs(a.position.z - 102) -
        Math.abs(b.position.x + 119) -
        Math.abs(b.position.z - 102),
    )[0]!;
  const facility = profile.facilities[slot.facility]!;
  const centerOn = async (x: number, z: number) => {
    const point = await page.evaluate(
      ({x, z}) => window.__cityLife.project(x, 1, z),
      {x, z},
    );

    // OrbitControls applies panSpeed=0.8 to pointer travel.
    await page.mouse.move(570, 490);
    await page.mouse.down({button: 'left'});
    await page.mouse.move(
      570 + (640 - point.x) / 0.8,
      490 + (450 - point.y) / 0.8,
      {steps: 10},
    );
    await page.mouse.up({button: 'left'});
    await expect
      .poll(async () => {
        const p = await page.evaluate(
          ({x, z}) => window.__cityLife.project(x, 1, z),
          {x, z},
        );

        return Math.hypot(p.x - 640, p.y - 450);
      })
      .toBeLessThan(7);
  };

  await centerOn(facility.entrance.x, facility.entrance.z);
  await page.screenshot({
    path: test.info().outputPath('compact-curb-houses.png'),
  });
  const interior = profile.facilities.find(
    f => f.kind === 'street' && f.blockId === 'street/0/17/2',
  )!;

  expect(interior).toBeDefined();
  await page.getByLabel('Вернуть камеру', {exact: true}).click();
  await page.getByLabel('Вид сверху', {exact: true}).click();

  for (let i = 0; i < 5; i++) {
    await page.getByLabel('Приблизить', {exact: true}).click();
  }

  await centerOn(interior.entrance.x, interior.entrance.z);
  await page.screenshot({
    path: test.info().outputPath('compact-curb-park.png'),
  });
  await page.evaluate(() => window.__cityLife.advance(40));
  await page.screenshot({
    path: test.info().outputPath('compact-curb-park-moving.png'),
  });
  await page.getByRole('button', {name: 'Ночь', exact: true}).click();
  await page.screenshot({
    path: test.info().outputPath('compact-curb-night.png'),
  });
  await expect(page.locator('#scene-error')).toBeHidden();
  expect(errors).toEqual([]);
});
