// `bun tools/rust-layout.ts`: the Rust reference for the stage 1½ layout gate, taken from a hidden
// live game (skill `simcity-live`, `SIMCITY_WINDOW=hidden BRP_EXTRAS_PORT=15801 cargo run --features dev`)
// that runs the test city. Writes e2e/fixtures/rust-layout.json: the layout class of every tile as it
// reads in a Rust frame.
//
// The tile -> pixel mapping of the frame is measured, not derived from the camera: an orthographic
// view of the ground plane is affine, so erasing four known road tiles one at a time and taking the
// centroid of the pixels that changed gives four point pairs, fitted by least squares.
//
// It erases those four tiles in the running game: shut the instance down afterwards.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { layoutClass, tileClass, type LayoutClass } from '../packages/render/src/palette';

const PORT = process.env.BRP_EXTRAS_PORT ?? '15801';
const SIZE = 3200;
/** North up: the boom sits south of the focus (yaw -π/2), as steep as the rig allows. */
const CAMERA = { focus: [0, 0], yaw: -Math.PI / 2, pitch: 1.35, zoom: 3.0 };
/** Not test-results/: Playwright empties that directory on every run. */
const OUT = resolve('target/rust-layout');
const FIXTURE = resolve('e2e/fixtures/rust-layout.json');
/** Half-size of the pixel window whose median colour stands for a tile. */
const WINDOW = 2;
const PROTOTYPES: Record<LayoutClass, number> = { road: 3, water: 2, other: 6 };
/** A tile whose best match is not clearly better than the best match of another class stays unread. */
const AMBIGUITY = 0.8;

interface RoadFixture {
  width: number;
  height: number;
  rawGrid: Record<string, string>;
}

async function rpc<T>(method: string, params?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${PORT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error !== undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

/** A map edit reaches the picture a few frames after the command applies; settle generously. */
const SETTLE_FRAMES = 30;

async function capture(name: string): Promise<string> {
  const path = `${OUT}/${name}.png`;
  const r = await rpc<{ looks_rendered: boolean }>('simcity/capture', {
    path,
    width: SIZE,
    height: SIZE,
    settle_frames: SETTLE_FRAMES,
  });
  if (!r.looks_rendered) throw new Error(`${name}: the frame does not look rendered`);
  return path;
}

const hexToBytes = (text: string) => Uint8Array.from({ length: text.length / 2 }, (_, i) => parseInt(text.slice(2 * i, 2 * i + 2), 16));

/** Least-squares affine map `(tx, ty) -> p` from point pairs. */
function fitAffine(tiles: Array<[number, number]>, values: number[]): [number, number, number] {
  // Normal equations for p = a*tx + b*ty + c.
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const v = [0, 0, 0];
  tiles.forEach(([x, y], i) => {
    const row = [x, y, 1];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) m[r]![c]! += row[r]! * row[c]!;
      v[r]! += row[r]! * values[i]!;
    }
  });
  for (let col = 0; col < 3; col++) {
    const pivot = m[col]![col]!;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / pivot;
      for (let c = 0; c < 3; c++) m[r]![c]! -= f * m[col]![c]!;
      v[r]! -= f * v[col]!;
    }
  }
  return [v[0]! / m[0]![0]!, v[1]! / m[1]![1]!, v[2]! / m[2]![2]!];
}

type Rgb = readonly [number, number, number];
const dist = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Deterministic k-means: seeds spread over the samples sorted by brightness. */
function kMeans(samples: Rgb[], k: number): Rgb[] {
  const sorted = [...samples].sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  let centers: Rgb[] = Array.from({ length: Math.min(k, sorted.length) }, (_, i) => sorted[Math.floor(((i + 0.5) * sorted.length) / k)]!);
  for (let iter = 0; iter < 20; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const s of samples) {
      let best = 0;
      centers.forEach((c, i) => {
        if (dist(s, c) < dist(s, centers[best]!)) best = i;
      });
      const acc = sums[best]!;
      acc[0]! += s[0];
      acc[1]! += s[1];
      acc[2]! += s[2];
      acc[3]! += 1;
    }
    centers = centers.map((c, i) => {
      const [r, g, b, n] = sums[i]!;
      return n === 0 ? c : ([r! / n!, g! / n!, b! / n!] as const);
    });
  }
  return centers;
}

const road = JSON.parse(readFileSync('packages/sim/test/fixtures/road-routes.json', 'utf8')) as RoadFixture;
const W = road.width;
const H = road.height;
const g = road.rawGrid;
const map = {
  width: W,
  height: H,
  tileSize: 16,
  mapEditVersion: 0,
  graphVersion: 0,
  layers: {
    water: hexToBytes(g.water!),
    roadKind: hexToBytes(g.roadKind!),
    roadDir: hexToBytes(g.roadDir!),
    zone: hexToBytes(g.zone!),
    building: hexToBytes(g.building!),
  },
};
const gridClass = Array.from({ length: W * H }, (_, i) => layoutClass(tileClass(map, i)));

// Calibration tiles: the road tiles nearest the four corners of the road network.
const roads: Array<[number, number]> = [];
for (let i = 0; i < W * H; i++) if (gridClass[i] === 'road') roads.push([i % W, Math.floor(i / W)]);
const pick = (score: (t: [number, number]) => number) => roads.reduce((best, t) => (score(t) > score(best) ? t : best));
const calibration = [pick(([x, y]) => -x - y), pick(([x, y]) => x - y), pick(([x, y]) => x + y), pick(([x, y]) => -x + y)];

mkdirSync(OUT, { recursive: true });
await rpc('simcity/sim', { speed: 'paused', hour: 12 });
const pose = await rpc('simcity/camera', CAMERA);
const shots = [await capture('base')];
for (const [k, [x, y]] of calibration.entries()) {
  await rpc('simcity/command', { command: { EraseTile: { pos: { x, y } } } });
  shots.push(await capture(`erase-${k}`));
}

const browser = await chromium.launch();
const page = await browser.newPage();
const images = shots.map((p) => readFileSync(p).toString('base64'));
await page.evaluate(async (b64s) => {
  const decoded: ImageData[] = [];
  for (const b64 of b64s) {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    decoded.push(ctx.getImageData(0, 0, bitmap.width, bitmap.height));
  }
  (globalThis as unknown as { frames_: ImageData[] }).frames_ = decoded;
}, images);

const centroids = await page.evaluate(() => {
  const frames = (globalThis as unknown as { frames_: ImageData[] }).frames_;
  return frames.slice(1).map((after, k) => {
    const before = frames[k]!;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < after.height; y++) {
      for (let x = 0; x < after.width; x++) {
        const o = (y * after.width + x) * 4;
        const d =
          Math.abs(after.data[o]! - before.data[o]!) +
          Math.abs(after.data[o + 1]! - before.data[o + 1]!) +
          Math.abs(after.data[o + 2]! - before.data[o + 2]!);
        // The sim is paused, so only the edit changes pixels; asphalt to grass is only ~70 apart.
        if (d > 24) {
          sx += x + 0.5;
          sy += y + 0.5;
          n += 1;
        }
      }
    }
    return { x: sx / n, y: sy / n, pixels: n };
  });
});
console.log(JSON.stringify({ calibration, centroids }));
for (const [k, c] of centroids.entries()) {
  if (!(c.pixels > 20)) throw new Error(`erasing ${calibration[k]} changed ${c.pixels} pixels: the command did not apply`);
}

const ax = fitAffine(calibration, centroids.map((c) => c.x));
const ay = fitAffine(calibration, centroids.map((c) => c.y));
const residual = Math.max(
  ...calibration.map(([x, y], k) => Math.hypot(ax[0] * x + ax[1] * y + ax[2] - centroids[k]!.x, ay[0] * x + ay[1] * y + ay[2] - centroids[k]!.y)),
);
const pixelsPerTile = Math.hypot(ax[0], ay[0]);
if (!(ax[0] > 0 && ay[1] < 0)) throw new Error(`the Rust frame is not east-right / north-up: x ${ax}, y ${ay}`);
if (residual > pixelsPerTile / 3) throw new Error(`calibration residual ${residual.toFixed(2)} px exceeds a third of a tile (${pixelsPerTile.toFixed(2)} px)`);

const colors = await page.evaluate(
  ({ ax, ay, W, H, window }) => {
    const base = (globalThis as unknown as { frames_: ImageData[] }).frames_[0]!;
    const out: number[] = [];
    const channel: number[] = [];
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        const cx = Math.floor(ax[0] * tx + ax[1] * ty + ax[2]);
        const cy = Math.floor(ay[0] * tx + ay[1] * ty + ay[2]);
        for (let c = 0; c < 3; c++) {
          channel.length = 0;
          for (let dy = -window; dy <= window; dy++) {
            for (let dx = -window; dx <= window; dx++) {
              channel.push(base.data[((cy + dy) * base.width + (cx + dx)) * 4 + c]!);
            }
          }
          channel.sort((a, b) => a - b);
          out.push(channel[channel.length >> 1]!);
        }
      }
    }
    return out;
  },
  { ax, ay, W, H, window: WINDOW },
);
await browser.close();

const tileColor = (i: number): Rgb => [colors[3 * i]!, colors[3 * i + 1]!, colors[3 * i + 2]!];
const prototypes = (Object.keys(PROTOTYPES) as LayoutClass[]).flatMap((cls) =>
  kMeans(
    gridClass.flatMap((c, i) => (c === cls ? [tileColor(i)] : [])),
    PROTOTYPES[cls],
  ).map((color) => ({ cls, color })),
);

const letter: Record<LayoutClass, string> = { road: 'r', water: 'w', other: 'o' };
let classes = '';
let readable = 0;
let agree = 0;
for (let i = 0; i < W * H; i++) {
  const c = tileColor(i);
  const ranked = prototypes.map((p) => ({ ...p, d: dist(c, p.color) })).sort((a, b) => a.d - b.d);
  const best = ranked[0]!;
  const rival = ranked.find((p) => p.cls !== best.cls)!;
  if (best.d > AMBIGUITY * rival.d) {
    classes += '?';
    continue;
  }
  classes += letter[best.cls];
  readable += 1;
  if (best.cls === gridClass[i]) agree += 1;
}

const report = {
  source: 'tools/rust-layout.ts: hidden live game, test city, paused at 12:00',
  camera: pose,
  frame: { width: SIZE, height: SIZE },
  calibration: {
    tiles: calibration,
    pixels: centroids,
    affineX: ax,
    affineY: ay,
    pixelsPerTile: Number(pixelsPerTile.toFixed(3)),
    maxResidualPx: Number(residual.toFixed(3)),
  },
  readableTiles: readable,
  agreementWithRustGrid: Number((agree / readable).toFixed(4)),
  /** Row by row from y = 0: r road, w water, o other, ? unreadable. */
  classes,
};
writeFileSync(FIXTURE, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, classes: undefined, frames: shots }, null, 2));
