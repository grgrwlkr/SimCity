// `bun run --cwd packages/desktop build:icon`: build/icon.svg -> build/icon.icns.
// sips cannot read SVG, so headless Chromium (the Playwright one the e2e already uses) rasterises
// the 1024 master with a transparent background; sips scales it to the iconset sizes and
// iconutil packs build/icon.icns, which package.json names explicitly in `mac.icon` (by default
// electron-builder would convert build/icon.svg itself). macOS only.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const build = fileURLToPath(new URL('../build/', import.meta.url));
const work = fileURLToPath(new URL('../release/.icon-work/', import.meta.url));
const iconset = `${work}icon.iconset/`;
const master = `${work}icon-1024.png`;

rmSync(work, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  const svg = readFileSync(`${build}icon.svg`, 'utf8');
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.locator('svg').screenshot({ path: master, omitBackground: true });
} finally {
  await browser.close();
}

for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
    const px = String(size * scale);
    execFileSync('sips', ['-z', px, px, master, '--out', iconset + name], { stdio: 'ignore' });
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', `${build}icon.icns`]);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${build}icon.icns`);
