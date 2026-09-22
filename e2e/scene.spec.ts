// Stage R2: the scene the player sees, forced with `?renderer=scene` (automation opens the debug renderer by default).
// The frame is not empty and carries buildings, the draw calls do not grow with the number of buildings, and the atlas
// read on the GPU at its last mip keeps every cell to itself.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ATLAS_CELLS, atlasCellIndex, buildAtlasImage } from '../packages/render/src/atlas';
import type { SceneStats } from '../packages/render/src/scene/sceneRenderer';
import { MAX_CELL_LOD, atlasMipChain } from '../packages/render/src/scene/atlasTexture';
import { tileToWorld } from '../packages/sim/src/index';

type LayerName = 'height' | 'water' | 'terrain' | 'roadKind' | 'roadDir' | 'roadLane' | 'roadFlow' | 'laneType' | 'zone' | 'density' | 'building';
const road = JSON.parse(readFileSync(new URL('../packages/sim/test/fixtures/road-routes.json', import.meta.url), 'utf8')) as {
  width: number;
  height: number;
  rawGrid: Record<LayerName, string>;
};

test.use({ viewport: { width: 800, height: 800 } });
// SwiftShader draws the lit scene on the processor: a frame takes far longer than the debug renderer's flat one.
test.describe.configure({ timeout: 240_000 });

const sceneStats = (page: Page) => page.evaluate(() => window.__sim.renderStats()) as Promise<SceneStats>;

async function openScene(page: Page, query = ''): Promise<void> {
  // A shader that fails to build surfaces only here: the frame just stops.
  page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
  page.on('console', (m) => void ((m.type() === 'error' || m.type() === 'warning') && console.log(`console: ${m.text()}`)));
  await page.goto(`/?renderer=scene${query}`);
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
  await page.addStyleTag({ content: '#root { visibility: hidden; }' });
}

async function loadGrid(page: Page, grid: Record<LayerName, string>): Promise<void> {
  const { height, ...rest } = grid;
  await page.evaluate(async (layers) => {
    await window.__sim.setSpeed('Paused');
    await window.__sim.setState('InGame');
    await window.__sim.loadGridHex(layers);
    await window.__sim.step(1);
  }, { elevation: height, ...rest });
}

/** Resolves once the scene has drawn the current map a few frames after the call. */
async function waitForDrawn(page: Page): Promise<SceneStats> {
  const since = (await sceneStats(page)).frames;
  await expect
    .poll(() => page.evaluate(async () => [await window.__sim.snapshot(), await window.__sim.renderStats()] as const).then(([s, r]) => r.mapEditVersion === s.mapEditVersion), { timeout: 60_000 })
    .toBe(true);
  await expect.poll(() => sceneStats(page).then((s) => s.frames), { timeout: 60_000 }).toBeGreaterThan(since + 3);
  return sceneStats(page);
}

/** Share of pixels off the most common colour, and how many distinct colours the frame has. */
async function frameVariety(page: Page, png: Buffer): Promise<{ offMode: number; colours: number }> {
  return page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const counts = new Map<number, number>();
    for (let o = 0; o < data.length; o += 4) {
      const key = (data[o]! << 16) | (data[o + 1]! << 8) | data[o + 2]!;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const mode = Math.max(...counts.values());
    return { offMode: 1 - mode / (data.length / 4), colours: counts.size };
  }, png.toString('base64'));
}

/** RGB of the screenshot at CSS points. */
async function pixelsAt(page: Page, png: Buffer, points: ReadonlyArray<{ x: number; y: number }>): Promise<Array<[number, number, number]>> {
  return page.evaluate(
    async ({ b64, points }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const scale = bitmap.width / document.getElementById('view')!.clientWidth;
      return points.map((p) => {
        const d = ctx.getImageData(Math.floor(p.x * scale), Math.floor(p.y * scale), 1, 1).data;
        return [d[0]!, d[1]!, d[2]!] as [number, number, number];
      });
    },
    { b64: png.toString('base64'), points },
  );
}

const hex = (s: string) => Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16));
/** `1 + BUILDING_KINDS.indexOf('FireStation')`: the fixture's fire station tiles. */
const FIRE_STATION = 4;

test('sceneDrawsTheTestCity', async ({ page }, testInfo) => {
  await openScene(page);
  await loadGrid(page, road.rawGrid);
  const cam = await page.evaluate(() => window.__sim.fitMap());
  const stats = await waitForDrawn(page);
  console.log(`scene stats: ${JSON.stringify(stats)}`);
  expect(stats.renderer).toBe('scene');
  expect(stats.buildings, 'buildings on the map').toBeGreaterThan(0);
  // Counted on the meshes that are in the scene graph, not on the records the scene keeps.
  expect(stats.buildingInstancesDrawn, 'every building is an instance the frame draws').toBe(stats.buildings);
  expect(stats.props, 'street furniture in the frame').toBeGreaterThan(0);
  expect(stats.drawCalls).toBeGreaterThan(0);
  const png = await page.locator('#view').screenshot({ path: testInfo.outputPath('scene-test-city.png') });
  // A fire station's roof is red where the ground under it is grey pavement: read the tile centres (between the rails and
  // rungs of the ladder glyph) back from the frame.
  const cfg = { width: road.width, height: road.height, tileSize: 16 };
  const fire = hex(road.rawGrid.building).flatMap((b, i) => (b === FIRE_STATION ? [i] : []));
  expect(fire.length).toBeGreaterThan(0);
  const points = fire.map((i) => {
    const w = tileToWorld(cfg, { x: i % cfg.width, y: Math.floor(i / cfg.width) });
    return { x: cam.width / 2 + (w.x - cam.centerX) / cam.worldPerPixel, y: cam.height / 2 - (w.y - cam.centerY) / cam.worldPerPixel };
  });
  const red = (await pixelsAt(page, png, points)).filter(([r, g]) => r - g > 60).length;
  expect(red, `${red} of ${fire.length} fire station tiles read red`).toBeGreaterThanOrEqual(fire.length * 0.8);
  const variety = await frameVariety(page, png);
  testInfo.annotations.push({ type: 'scene', description: JSON.stringify({ drawCalls: stats.drawCalls, buildings: stats.buildings, buildingBatches: stats.buildingBatches, props: stats.props, backend: stats.backend, ...variety }) });

  // Close up, in the perspective half of the zoom: walls show, and the furniture is big enough to read.
  const fitted = await page.evaluate(() => window.__sim.camera());
  await page.evaluate((c) => window.__sim.setCamera({ centerX: c.centerX, centerY: c.centerY, worldPerPixel: 0.35 }), fitted);
  await waitForDrawn(page);
  const close = await frameVariety(page, await page.locator('#view').screenshot({ path: testInfo.outputPath('scene-test-city-close.png') }));
  console.log(`scene variety: far ${JSON.stringify(variety)} close ${JSON.stringify(close)}`);
  expect(variety.offMode, 'most of the frame is not one flat colour').toBeGreaterThan(0.5);
  // Flat fills would give a colour per ground class and a few for the props; the atlas detail gives many more.
  expect(close.colours, 'the atlas breaks up the fills').toBeGreaterThan(60);
});

test('sceneDrawCallsDoNotGrowWithBuildings', async ({ page }, testInfo) => {
  await openScene(page);
  await loadGrid(page, road.rawGrid);
  await page.evaluate(() => window.__sim.fitMap());
  const before = await waitForDrawn(page);

  // Three hundred more buildings of the kind the city already has most of: five times the buildings, no new shape. Few
  // enough that a mesh per building would still draw in time, so a regression shows in the count and not as a timeout.
  const [roadKind, water, building] = [hex(road.rawGrid.roadKind), hex(road.rawGrid.water), hex(road.rawGrid.building)];
  const counts = new Map<number, number>();
  for (const b of building) if (b !== 0) counts.set(b, (counts.get(b) ?? 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  let added = 0;
  const built = building.map((b, i) => (b === 0 && roadKind[i] === 0 && water[i] === 0 && added < 300 ? (added++, common) : b));
  await loadGrid(page, { ...road.rawGrid, building: built.map((b) => b.toString(16).padStart(2, '0')).join('') });
  const after = await waitForDrawn(page);

  const line = `${before.buildings} buildings: ${before.drawCalls} draw calls; ${after.buildings} buildings: ${after.drawCalls}`;
  console.log(`scene drawCalls: ${line}`);
  testInfo.annotations.push({ type: 'drawCalls', description: line });
  expect(after.buildings).toBe(before.buildings + 300);
  expect(after.buildingInstancesDrawn).toBe(after.buildings);
  expect(after.drawCalls, 'draw calls do not grow with the buildings').toBeLessThanOrEqual(before.drawCalls);
  expect(after.buildingBatches).toBe(before.buildingBatches);
});

test('sceneAtlasCellsDoNotBleedOnTheLastMip', async ({ page }, testInfo) => {
  await openScene(page);
  const SIDE = 48;
  const probe = new URL('../packages/render/src/scene/atlasProbe.ts', import.meta.url).pathname;
  const backend = await page.evaluate(
    async ({ probe, side }) => {
      const canvas = document.createElement('canvas');
      canvas.id = 'atlas-probe';
      canvas.style.cssText = `position:fixed;left:0;top:0;width:${side * 7}px;height:${side}px;z-index:10`;
      document.body.append(canvas);
      const { drawAtlasProbe } = (await import(/* @vite-ignore */ `/@fs${probe}`)) as typeof import('../packages/render/src/scene/atlasProbe');
      return drawAtlasProbe(canvas, side, 64);
    },
    { probe, side: SIDE },
  );
  const png = await page.locator('#atlas-probe').screenshot({ path: testInfo.outputPath('atlas-probe.png') });
  const pixels = await page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, red: Array.from(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data.filter((_, i) => i % 4 === 0)) };
  }, png.toString('base64'));

  // What each cell is at the last level of the chain, as the sRGB output shows it.
  const last = atlasMipChain(buildAtlasImage())[MAX_CELL_LOD]!;
  const encode = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  const scale = pixels.width / (SIDE * ATLAS_CELLS.length);
  const report = ATLAS_CELLS.map((cell, i) => {
    const [col, row] = atlasCellIndex(cell);
    const expected = encode(last.data[(row * last.width + col) * 4]! / 255);
    let lo = 255;
    let hi = 0;
    // One pixel in from the square's edge: the squares meet each other there, not the atlas.
    for (let y = Math.ceil(scale); y < pixels.height - Math.ceil(scale); y++) {
      for (let x = Math.ceil((i * SIDE + 1) * scale); x < Math.floor(((i + 1) * SIDE - 1) * scale); x++) {
        const v = pixels.red[y * pixels.width + x]!;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    return { cell, expected: Math.round(expected), lo, hi };
  });
  testInfo.annotations.push({ type: 'atlas', description: `${backend}: ${JSON.stringify(report)}` });
  for (const r of report) {
    expect(r.lo, `${r.cell}: ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(r.expected - 3);
    expect(r.hi, `${r.cell}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(r.expected + 3);
  }
  expect(report.find((r) => r.cell === 'Plain')!.lo, 'white Plain stays white beside grey Asphalt and Water').toBe(255);
});

// The shader's clamp itself, between two levels: a 90-pixel square with the cell repeated 64 times puts the sampler at
// lod ≈ 6.5, where it blends levels 6 and 7. On an atlas whose Plain cell alone is white, a clamp by half a texel of the
// finer level lets the coarser one read a fifth of a texel of black next door: Plain drops below 255 at its edges and
// its neighbours light up.
test('sceneAtlasClampHoldsBetweenTwoLevels', async ({ page }, testInfo) => {
  await openScene(page);
  const SIDE = 90;
  const probe = new URL('../packages/render/src/scene/atlasProbe.ts', import.meta.url).pathname;
  const backend = await page.evaluate(
    async ({ probe, side }) => {
      const canvas = document.createElement('canvas');
      canvas.id = 'atlas-probe';
      canvas.style.cssText = `position:fixed;left:0;top:0;width:${side * 7}px;height:${side}px;z-index:10`;
      document.body.append(canvas);
      const { drawAtlasProbe } = (await import(/* @vite-ignore */ `/@fs${probe}`)) as typeof import('../packages/render/src/scene/atlasProbe');
      return drawAtlasProbe(canvas, side, 64, 'Plain');
    },
    { probe, side: SIDE },
  );
  const png = await page.locator('#atlas-probe').screenshot({ path: testInfo.outputPath('atlas-probe-fractional.png') });
  const red = await page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, values: Array.from(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data.filter((_, i) => i % 4 === 0)) };
  }, png.toString('base64'));
  const scale = red.width / (SIDE * ATLAS_CELLS.length);
  const report = ATLAS_CELLS.map((cell, i) => {
    let lo = 255;
    let hi = 0;
    for (let y = Math.ceil(scale); y < red.height - Math.ceil(scale); y++) {
      for (let x = Math.ceil((i * SIDE + 1) * scale); x < Math.floor(((i + 1) * SIDE - 1) * scale); x++) {
        lo = Math.min(lo, red.values[y * red.width + x]!);
        hi = Math.max(hi, red.values[y * red.width + x]!);
      }
    }
    return { cell, lo, hi };
  });
  testInfo.annotations.push({ type: 'atlas', description: `${backend}: ${JSON.stringify(report)}` });
  console.log(`atlas fractional: ${backend} ${JSON.stringify(report)}`);
  for (const r of report) {
    if (r.cell === 'Plain') expect(r.lo, `Plain stays white: ${JSON.stringify(r)}`).toBe(255);
    else expect(r.hi, `${r.cell} stays black beside a white Plain: ${JSON.stringify(r)}`).toBeLessThanOrEqual(1);
  }
});

test('sceneDrawsTheMetropolis', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const size = process.env.SCENE_METROPOLIS_SIZE ?? '128';
  await openScene(page, `&scenario=metropolis&size=${size}`);
  await expect.poll(() => sceneStats(page).then((s) => s.buildings), { timeout: 150_000 }).toBeGreaterThan(0);
  await page.evaluate(() => window.__sim.setSpeed('Paused'));
  const stats = await waitForDrawn(page);
  await page.screenshot({ path: testInfo.outputPath('scene-metropolis.png') });
  testInfo.annotations.push({ type: 'metropolis', description: JSON.stringify({ size, drawCalls: stats.drawCalls, buildings: stats.buildings, buildingBatches: stats.buildingBatches, props: stats.props }) });
  expect(stats.buildingBatches, 'a batch per shape, not per building').toBeLessThan(stats.buildings);
});

// Not a gate: the frame rate of the scene, for the plan of R3. Run alone on the GPU:
// `E2E_PERF=1 E2E_GPU=1 bunx playwright test e2e/scene.spec.ts --grep @perf --workers=1`.
test.describe('@perf scene frame rate', () => {
  test.skip(process.env.E2E_PERF !== '1', 'measurements run alone: E2E_PERF=1');
  test.describe.configure({ timeout: 300_000 });

  /** Frames drawn over ten seconds of wall clock, and the draw calls of the last one. */
  async function measure(page: Page): Promise<{ fps: number; drawCalls: number; buildings: number; props: number; backend: string }> {
    const a = await sceneStats(page);
    const t0 = Date.now();
    await page.waitForTimeout(10_000);
    const b = await sceneStats(page);
    return { fps: Math.round(((b.frames - a.frames) * 1000) / (Date.now() - t0)), drawCalls: b.drawCalls, buildings: b.buildings, props: b.props, backend: b.backend };
  }

  test('sceneFrameRateOnTheTestCityAndTheMetropolis', async ({ page }, testInfo) => {
    await openScene(page);
    await loadGrid(page, road.rawGrid);
    await page.evaluate(() => window.__sim.fitMap());
    await waitForDrawn(page);
    const city = await measure(page);
    await openScene(page, '&scenario=metropolis');
    await expect.poll(() => sceneStats(page).then((s) => s.buildings), { timeout: 240_000 }).toBeGreaterThan(0);
    await waitForDrawn(page);
    const metropolis = await measure(page);
    await page.screenshot({ path: testInfo.outputPath('scene-metropolis-full.png') });
    const cam = await page.evaluate(() => window.__sim.camera());
    await page.evaluate((c) => window.__sim.setCamera({ centerX: c.centerX, centerY: c.centerY, worldPerPixel: 0.5 }), cam);
    await waitForDrawn(page);
    const metropolisClose = await measure(page);
    await page.screenshot({ path: testInfo.outputPath('scene-metropolis-close.png') });
    console.log(`scene fps close: ${JSON.stringify(metropolisClose)}`);
    // One edit in view: a tile erased under the camera. The map applied on load is the whole map; this one is one chunk.
    const loadMs = (await sceneStats(page)).setMapMs;
    const tile = await page.evaluate((c) => window.__sim.pickTile(c.width / 2, c.height / 2), cam);
    await page.evaluate(async (pos) => {
      await window.__sim.setSpeed('Paused');
      await window.__sim.cmd({ EraseTile: { pos } });
      await window.__sim.step(1);
    }, tile!);
    const edited = await waitForDrawn(page);
    console.log(`scene setMap: ${JSON.stringify({ loadMs, editMs: edited.setMapMs, tile })}`);
    console.log(`scene fps: ${JSON.stringify({ city, metropolis })}`);
  });
});
