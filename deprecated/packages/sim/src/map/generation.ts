// Port of crates/simcity_sim/src/game/map/generation.rs: height noise, a box blur, lakes and
// rivers traced downhill. Every draw goes through the StdRng port in the same order as Rust.
import { randomBool, rangeI32, rangeU8Inclusive, stdRngSeedFromU64 } from '../rng';
import { GRASS_CODE, type MapGrid } from './grid';

const BLUR_PASSES = 3;
const LAKE_COUNT = 6;
const RIVER_COUNT = 4;

export function generateMapIntoGrid(grid: MapGrid, seed: bigint): void {
  const rng = stdRngSeedFromU64(seed);
  const w = grid.width;
  const h = grid.height;
  const len = grid.len();

  // Base height noise; roads, zones and buildings are wiped. Density is left as it was.
  for (let i = 0; i < len; i++) {
    grid.elevation[i] = rangeU8Inclusive(rng, 0, 255);
    grid.water[i] = 0;
    grid.terrain[i] = GRASS_CODE;
    grid.roadKind[i] = 0;
    grid.roadDir[i] = 0;
    grid.roadLane[i] = 0;
    grid.roadFlow[i] = 0;
    grid.laneType[i] = 0;
    grid.zone[i] = 0;
    grid.building[i] = 0;
  }

  // Smooth heights a bit (cheap blur).
  const tmp = new Uint8Array(len);
  for (let pass = 0; pass < BLUR_PASSES; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let n = 0;
        for (const dy of [-1, 0, 1]) {
          for (const dx of [-1, 0, 1]) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            sum += grid.elevation[ny * w + nx]!;
            n += 1;
          }
        }
        tmp[y * w + x] = Math.floor(sum / Math.max(n, 1));
      }
    }
    grid.elevation.set(tmp);
  }

  // Lakes: a few random blobs.
  for (let lake = 0; lake < LAKE_COUNT; lake++) {
    const cx = rangeI32(rng, 0, w);
    const cy = rangeI32(rng, 0, h);
    const r = rangeI32(rng, 3, 10);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r) grid.water[y * w + x] = 1;
      }
    }
  }

  // Rivers: trace downhill from a few sources.
  for (let river = 0; river < RIVER_COUNT; river++) {
    let x = rangeI32(rng, 0, w);
    let y = rangeI32(rng, 0, h);
    let steps = 0;
    while (steps < w + h) {
      const i = y * w + x;
      grid.water[i] = 1;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) break;

      // Move to the lowest neighbour; a tie is taken with probability 0.35 (drawn only on a tie).
      let bestX = x;
      let bestY = y;
      let bestH = grid.elevation[i]!;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const h0 = grid.elevation[ny * w + nx]!;
        if (h0 < bestH || (h0 === bestH && randomBool(rng, 0.35))) {
          bestX = nx;
          bestY = ny;
          bestH = h0;
        }
      }
      if (bestX === x && bestY === y) break;
      x = bestX;
      y = bestY;
      steps += 1;
    }
  }
}
