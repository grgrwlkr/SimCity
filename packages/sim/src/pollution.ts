// Port of crates/simcity_sim/src/game/pollution.rs: open factories pollute the tiles within ten of their anchor.
// One chunk of 32 tiles is recomputed a tick, zeroed and refilled in the same tick, so a reader never sees a
// polluted tile at zero for a whole pass.
import { isOperational } from './buildings/building';
import { sqrtF32 } from './math';
import type { World } from './world';

const f32 = Math.fround;

/** Tiles from a factory's anchor its pollution reaches. */
export const POLLUTION_RADIUS = 10;
const CHUNK_SIZE = 32;
const INTENSITY = f32(0.3);

/** `PollutionIndex`: pollution per tile, 0..1. */
export class PollutionIndex {
  values = new Float32Array(0);
  /** Bumps once per published chunk. */
  version = 0;
  readonly chunkSize = CHUNK_SIZE;
  /** The chunk recomputed next. */
  currentChunk = 0;

  get(idx: number): number {
    return idx < this.values.length ? this.values[idx]! : 0;
  }

  /** Clean air for a new map, so the previous city does not feed land value for a whole pass. */
  resetValues(): void {
    this.values.fill(0);
    this.currentChunk = 0;
    this.version += 1;
  }
}

/**
 * `compute_pollution` (PostSimStep::Pollution). A chunk is a contiguous row-major range, so only the rows of a
 * factory's disc that fall in it are scanned. Rust counted factories still under construction.
 */
export function computePollution(w: World): void {
  const pollution = w.pollution;
  const grid = w.grid;
  const len = grid.len();
  if (pollution.values.length !== len) {
    pollution.values = new Float32Array(len);
    pollution.currentChunk = 0;
  }
  if (len === 0) return;

  const start = pollution.currentChunk * pollution.chunkSize;
  const end = Math.min(start + pollution.chunkSize, len);
  pollution.values.fill(0, start, end);

  const width = Math.max(grid.width, 1);
  const firstRow = Math.trunc(start / width);
  const lastRow = Math.trunc((end - 1) / width);
  const r = POLLUTION_RADIUS;
  for (const b of w.buildings.all()) {
    if (b.kind !== 'Industrial' || !isOperational(b)) continue;
    const { x: ax, y: ay } = b.anchor;
    for (let dy = Math.max(-r, firstRow - ay); dy <= Math.min(r, lastRow - ay); dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const idx = grid.idx({ x: ax + dx, y: ay + dy });
        if (idx === undefined || idx < start || idx >= end) continue;
        const distance = sqrtF32(dx * dx + dy * dy);
        if (distance > r) continue;
        const intensity = f32(1 - f32(distance / r));
        pollution.values[idx] = Math.min(f32(pollution.values[idx]! + f32(intensity * INTENSITY)), 1);
      }
    }
  }

  pollution.currentChunk += 1;
  if (pollution.currentChunk * pollution.chunkSize >= len) pollution.currentChunk = 0;
  pollution.version += 1;
}
