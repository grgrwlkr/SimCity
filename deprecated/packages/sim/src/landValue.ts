// Port of crates/simcity_sim/src/game/land_value.rs: land value per tile, 0..1, recomputed 64 tiles a tick. The middle
// value, up for a road beside the tile and for each service covering it, down for pollution, a locally congested
// road and crime above what a district tolerates. Until its first pass a tile reads the middle value.
import { crimeLandValuePenalty } from './cityFields';
import type { MapGrid } from './map/grid';
import { MASK_FIRE, MASK_MEDICAL, MASK_POLICE } from './services/coverage';
import type { TrafficOccupancy } from './traffic/occupancy';
import type { World } from './world';

const f32 = Math.fround;
const MIDDLE = f32(0.5);
const CHUNK_SIZE = 64;
const ROAD_BONUS = f32(0.2);
const SERVICE_BONUS = f32(0.1);
const POLLUTION_WEIGHT = f32(0.4);
const CONGESTED_SHARE = f32(0.7);
const CONGESTION_PENALTY = f32(0.2);

export class LandValueIndex {
  values = new Float32Array(0);
  /** Bumps once per published chunk. */
  version = 0;
  readonly chunkSize = CHUNK_SIZE;
  /** The chunk recomputed next. */
  currentChunk = 0;

  get(idx: number): number {
    return idx < this.values.length ? this.values[idx]! : MIDDLE;
  }

  /** The middle value for a new map, so the previous city does not feed growth for a whole pass; Rust reset to zero. */
  resetValues(): void {
    this.values.fill(MIDDLE);
    this.currentChunk = 0;
    this.version += 1;
  }
}

function dryRoadAt(grid: MapGrid, x: number, y: number): number | undefined {
  const idx = grid.idx({ x, y });
  return idx !== undefined && grid.water[idx] === 0 && grid.roadKind[idx] !== 0 ? idx : undefined;
}

/** The hottest dry road on the tile or beside it: congestion is local, not the city's average. */
function localTrafficHeat(occupancy: TrafficOccupancy, grid: MapGrid, x: number, y: number): number {
  let best = 0;
  for (const [dx, dy] of [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const idx = dryRoadAt(grid, x + dx, y + dy);
    if (idx !== undefined) best = Math.max(best, occupancy.heatIdx(idx));
  }
  return best;
}

/** `compute_land_value` (PostSimStep::LandValue): one chunk a tick. */
export function computeLandValue(w: World): void {
  const grid = w.grid;
  const len = grid.len();
  const land = w.landValue;
  if (land.values.length !== len) {
    land.values = new Float32Array(len).fill(MIDDLE);
    land.currentChunk = 0;
  }
  if (len === 0) return;

  const coverage = w.serviceCoverage;
  const occupancy = w.trafficOccupancy;
  const maxHeat = occupancy.maxHeat();
  const fields = w.cityFields.covers(len) ? w.cityFields : undefined;
  const start = land.currentChunk * land.chunkSize;
  const end = Math.min(start + land.chunkSize, len);
  for (let idx = start; idx < end; idx++) {
    const x = idx % grid.width;
    const y = Math.trunc(idx / grid.width);
    let value = MIDDLE;
    const besideRoad = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ].some(([dx, dy]) => dryRoadAt(grid, x + dx!, y + dy!) !== undefined);
    if (besideRoad) value = f32(value + ROAD_BONUS);

    let services = 0;
    if (coverage.isCovered(idx, MASK_FIRE)) services = f32(services + SERVICE_BONUS);
    if (coverage.isCovered(idx, MASK_POLICE)) services = f32(services + SERVICE_BONUS);
    if (coverage.isCovered(idx, MASK_MEDICAL)) services = f32(services + SERVICE_BONUS);
    value = f32(value + services);

    value = f32(value - f32(w.pollution.get(idx) * POLLUTION_WEIGHT));

    if (maxHeat > 0) {
      const share = Math.min(Math.max(f32(localTrafficHeat(occupancy, grid, x, y) / maxHeat), 0), 1);
      if (share > CONGESTED_SHARE) value = f32(value - CONGESTION_PENALTY);
    }

    if (fields !== undefined) value = f32(value - crimeLandValuePenalty(fields.get('Crime', idx)));

    land.values[idx] = Math.min(Math.max(value, 0), 1);
  }

  land.currentChunk += 1;
  if (land.currentChunk * land.chunkSize >= len) land.currentChunk = 0;
  land.version += 1;
}
