// Live helpers (E3): see and drive the running game from Playwright without a window on screen — the TS side of
// rust-final crates/simcity_debug/src/game/live/{observe,control,capture}.rs and the naming of map/tests.rs. Everything
// goes through `window.__sim` (dev and e2e builds only) and Playwright's own page; nothing here ships in the app.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Page } from '@playwright/test';
import type { SimSpeed } from '../../packages/bridge/src/driver';
import type { ClockReply } from '../../packages/bridge/src/requests/clock';
import type { ObserveParams, ObserveReply } from '../../packages/bridge/src/requests/observe';
import { OVERLAY_MODES, type OverlayMode } from '../../packages/render/src/overlays';
import { PLAYER_OVERLAYS } from '../../packages/ui/src/DataMapPanel';

export type { ObserveParams, ObserveReply, ObserveSection } from '../../packages/bridge/src/requests/observe';

/** Opens the game (a scenario by `query`, e.g. `?scenario=city`) and waits until `__sim` answers. */
export async function openGame(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
}

/** The sections of the city asked for, from one tick of the world. */
export function observe(page: Page, params: ObserveParams): Promise<ObserveReply> {
  return page.evaluate((p) => window.__sim.observe(p), params);
}

/** The clock stood at `hour`:00 — of `day`, or of the next day that shows the hour. The clock only runs forward. */
export function setClock(page: Page, hour: number, day?: number): Promise<ClockReply> {
  return page.evaluate(([h, d]) => window.__sim.setClock(h, d), [hour, day] as const);
}

/** Lower case with spaces, underscores and dashes dropped: how a name is compared. */
const squeeze = (name: string) => name.trim().toLowerCase().replace(/[\s_-]+/g, '');

const OVERLAY_BY_NAME: ReadonlyMap<string, OverlayMode> = new Map<string, OverlayMode>([
  ...OVERLAY_MODES.map((mode) => [squeeze(mode), mode] as const),
  // The panel's own words, so a check can name a map as the player reads it.
  ...PLAYER_OVERLAYS.map(([mode, label]) => [squeeze(label), mode] as const),
  ['service', 'ServiceCoverage'],
  ['fire', 'FireHazard'],
]);

/** An overlay by any of its names — `LandValue`, `land value`, `Стоимость земли` — forgiving about case and spacing; `null` for nonsense. */
export function overlayFromName(name: string): OverlayMode | null {
  return OVERLAY_BY_NAME.get(squeeze(name)) ?? null;
}

const SPEED_BY_NAME: ReadonlyMap<string, SimSpeed> = new Map<string, SimSpeed>([
  ['paused', 'Paused'],
  ['pause', 'Paused'],
  ['стоп', 'Paused'],
  ['0', 'Paused'],
  ...(['X1', 'X3', 'X10', 'X60', 'X360'] as const).flatMap((speed) => [[squeeze(speed), speed] as const, [speed.slice(1), speed] as const]),
]);

/** A speed of the ladder by its name or the HUD's label — `X10`, `x10`, `×10`, `10`, `Стоп`, `pause`; `null` for nonsense. */
export function speedFromName(name: string): SimSpeed | null {
  return SPEED_BY_NAME.get(squeeze(name).replace(/×/g, 'x')) ?? null;
}

/** Sets the speed by name; an unknown name is refused rather than ignored. */
export async function setSpeed(page: Page, name: string): Promise<SimSpeed> {
  const speed = speedFromName(name);
  if (speed === null) throw new Error(`unknown speed ${JSON.stringify(name)}: expected Paused, X1, X3, X10, X60 or X360`);
  await page.evaluate((s) => window.__sim.setSpeed(s), speed);
  return speed;
}

/** Luma statistics of a frame: whether it is worth looking at. */
export interface FrameStats {
  readonly width: number;
  readonly height: number;
  readonly mean: number;
  readonly std: number;
  readonly min: number;
  readonly max: number;
  /** Share of pixels brighter than `BLACK_LUMA`. */
  readonly nonblackFraction: number;
}

/** Rec. 601 luma below this reads as black. */
export const BLACK_LUMA = 8;

/** Luma statistics of RGBA pixels; two passes, so a flat frame's spread is exactly zero. */
export function frameStats(width: number, height: number, rgba: ArrayLike<number>): FrameStats {
  const n = width * height;
  if (n === 0 || rgba.length !== n * 4) throw new RangeError(`a ${width}×${height} frame needs ${n * 4} bytes, got ${rgba.length}`);
  const luma = new Float64Array(n);
  let [sum, min, max, nonblack] = [0, Infinity, -Infinity, 0];
  for (let i = 0; i < n; i++) {
    const v = 0.299 * rgba[4 * i]! + 0.587 * rgba[4 * i + 1]! + 0.114 * rgba[4 * i + 2]!;
    luma[i] = v;
    sum += v;
    min = Math.min(min, v);
    max = Math.max(max, v);
    if (v > BLACK_LUMA) nonblack += 1;
  }
  const mean = sum / n;
  let variance = 0;
  for (const v of luma) variance += (v - mean) ** 2;
  return { width, height, mean, std: Math.sqrt(variance / n), min: Math.round(min), max: Math.round(max), nonblackFraction: nonblack / n };
}

/** A frame worth looking at: drawn, and not one flat colour. Check it before trusting a picture. */
export function looksRendered(stats: FrameStats): boolean {
  return stats.std > 1 && stats.nonblackFraction > 0.01;
}

export interface CaptureOptions {
  /** With the HUD, as the player sees the page; without (the default), the map alone. */
  readonly ui?: boolean;
  /** Where to write the PNG; must end in `.png`. Its folders are made. Without it the PNG only comes back. */
  readonly path?: string;
  /** Frames the renderer must draw after the call before the shot, so the picture is of the world now. */
  readonly settleFrames?: number;
  /** How long to wait for those frames before giving up. */
  readonly timeoutMs?: number;
}

export interface Capture {
  readonly png: Buffer;
  readonly path: string | null;
  readonly ui: boolean;
  /** Frames the renderer drew between the call and the shot. */
  readonly settledFrames: number;
  readonly stats: FrameStats;
  readonly looksRendered: boolean;
}

/** The HUD lives in `#root` over the map's canvas `#view` (packages/app/index.html). */
const HIDE_HUD = '#root { visibility: hidden !important; }';

/**
 * One frame of the game as a PNG with its statistics. The screenshot is Playwright's, headless and offscreen: nothing
 * reaches the screen, and the window never needs to be in front. `ui: false` shoots the map's canvas with the HUD hidden
 * for the shot only; `ui: true` the whole page at the device's scale.
 */
export async function capture(page: Page, options: CaptureOptions = {}): Promise<Capture> {
  const { ui = false, path, settleFrames = 2, timeoutMs = 30_000 } = options;
  if (typeof ui !== 'boolean') throw new TypeError(`\`ui\` must be true or false, got ${JSON.stringify(ui)}`);
  if (path !== undefined && !path.toLowerCase().endsWith('.png')) throw new TypeError(`\`path\` must end in .png, got ${JSON.stringify(path)}`);
  const settledFrames = await page.evaluate(
    async ([wanted, limitMs]) => {
      const start = (await window.__sim.renderStats()).frames;
      const until = performance.now() + limitMs;
      for (;;) {
        const drawn = (await window.__sim.renderStats()).frames - start;
        if (drawn >= wanted) return drawn;
        if (performance.now() > until) throw new Error(`capture: the renderer drew ${drawn} of ${wanted} frames in ${limitMs} ms`);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    },
    [settleFrames, timeoutMs] as const,
  );
  const png = ui ? await page.screenshot({ animations: 'disabled' }) : await page.locator('#view').screenshot({ style: HIDE_HUD, animations: 'disabled' });
  // The browser decodes the PNG; the raw pixels come back as base64, which crosses far cheaper than a list of numbers.
  const { width, height, rgba } = await page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const url = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(new Blob([data]));
    });
    return { width: bitmap.width, height: bitmap.height, rgba: url.slice(url.indexOf(',') + 1) };
  }, png.toString('base64'));
  const stats = frameStats(width, height, Buffer.from(rgba, 'base64'));
  if (path !== undefined) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, png);
  }
  return { png, path: path ?? null, ui, settledFrames, stats, looksRendered: looksRendered(stats) };
}
