// Port of crates/simcity_sim/src/game/traffic/traffic_spatial_index.rs: the vehicles on each tile,
// sorted by progress, and each vehicle's same-tile leader. Rebuilt before every use in a tick.
import type { TilePos } from '../commands';
import type { MapGrid } from '../map/grid';
import type { World } from '../world';
import { VEHICLE_VISUAL_LENGTH_TILES } from './constants';
import type { PathPool } from './pathPool';
import { vehicleRef } from './vehicles';

const f32 = Math.fround;

export interface VehicleTileEntry {
  readonly vehicle: number;
  readonly progress: number;
  readonly speed: number;
}

const NO_ENTRIES: readonly VehicleTileEntry[] = [];

export class TrafficSpatialIndex {
  private gridLen = 0;
  private counts = new Uint32Array(0);
  private offsets = new Uint32Array(0);
  private touched: number[] = [];
  private entries: VehicleTileEntry[] = [];
  private readonly leaderSame = new Map<number, readonly [gapWorld: number, leaderSpeed: number]>();
  private readonly leaderSameProgress = new Map<number, number>();

  /** Vehicles without an active route (path of at most one tile, e.g. an idle fleet) are not traffic. */
  rebuild(w: World): void {
    const grid = w.grid;
    const len = grid.len();
    if (this.gridLen !== len) {
      this.gridLen = len;
      this.counts = new Uint32Array(len);
      this.offsets = new Uint32Array(len);
    } else {
      for (const idx of this.touched) {
        this.counts[idx] = 0;
        this.offsets[idx] = 0;
      }
    }
    this.touched = [];
    this.entries = [];
    this.leaderSame.clear();
    this.leaderSameProgress.clear();

    const v = w.vehicles;
    const pool = w.pathPool;
    const tileIdxOf = (slot: number): number | undefined => {
      if (pool.len(v.pathHandle[slot]!) <= 1) return undefined;
      const tile = pool.getTile(v.pathHandle[slot]!, v.pathCursor[slot]!);
      return tile === undefined ? undefined : grid.idx(tile);
    };

    for (const slot of v.order) {
      if (v.parked[slot] === 1) continue;
      const idx = tileIdxOf(slot);
      if (idx === undefined) continue;
      if (this.counts[idx] === 0) this.touched.push(idx);
      this.counts[idx] = this.counts[idx]! + 1;
    }
    if (this.touched.length === 0) return;
    this.touched.sort((a, b) => a - b);

    let total = 0;
    for (const idx of this.touched) {
      const count = this.counts[idx]!;
      this.offsets[idx] = total;
      this.counts[idx] = 0;
      total += count;
    }
    this.entries = new Array<VehicleTileEntry>(total);
    for (const slot of v.order) {
      if (v.parked[slot] === 1) continue;
      const idx = tileIdxOf(slot);
      if (idx === undefined) continue;
      const pos = this.offsets[idx]! + this.counts[idx]!;
      this.counts[idx] = this.counts[idx]! + 1;
      this.entries[pos] = {
        vehicle: vehicleRef(v, slot),
        progress: Math.min(Math.max(v.progress[slot]!, 0), 1),
        speed: Math.max(v.speed[slot]!, 0),
      };
    }

    const tileSize = f32(Math.max(w.mapConfig.tileSize, f32(0.1)));
    const vehicleLenWorld = f32(VEHICLE_VISUAL_LENGTH_TILES * tileSize);
    for (const idx of this.touched) {
      const start = this.offsets[idx]!;
      const end = start + this.counts[idx]!;
      // Rust sorts unstably by progress; equal progress keeps insertion order here.
      const slice = this.entries.slice(start, end).sort((a, b) => a.progress - b.progress);
      for (let i = 0; i < slice.length; i++) this.entries[start + i] = slice[i]!;
      for (let i = 1; i < slice.length; i++) {
        const ego = slice[i - 1]!;
        const lead = slice[i]!;
        const centerGap = f32(Math.max(f32(lead.progress - ego.progress), 0) * tileSize);
        this.leaderSame.set(ego.vehicle, [Math.max(f32(centerGap - vehicleLenWorld), 0), lead.speed]);
        this.leaderSameProgress.set(ego.vehicle, lead.progress);
      }
    }
  }

  tileHasAny(tileIdx: number): boolean {
    return (this.counts[tileIdx] ?? 0) > 0;
  }

  tileCount(tileIdx: number): number {
    return this.counts[tileIdx] ?? 0;
  }

  /** `(progress, speed)` of the vehicle nearest the tile's entry. */
  tileMinProgressSpeed(tileIdx: number): readonly [number, number] | undefined {
    const first = this.tileFirst(tileIdx);
    return first === undefined ? undefined : [first.progress, first.speed];
  }

  tileFirst(tileIdx: number): VehicleTileEntry | undefined {
    const count = this.counts[tileIdx];
    if (count === undefined || count === 0) return undefined;
    return this.entries[this.offsets[tileIdx]!];
  }

  /** The tile's vehicles by progress; `undefined` off the grid. */
  tileEntries(tileIdx: number): readonly VehicleTileEntry[] | undefined {
    const count = this.counts[tileIdx];
    if (count === undefined) return undefined;
    if (count === 0) return NO_ENTRIES;
    const start = this.offsets[tileIdx]!;
    return this.entries.slice(start, start + count);
  }

  /** `(gap_world, leader_speed)` of the vehicle directly ahead on the same tile. */
  leaderSameTile(vehicle: number): readonly [number, number] | undefined {
    return this.leaderSame.get(vehicle);
  }

  leaderSameTileProgress(vehicle: number): number | undefined {
    return this.leaderSameProgress.get(vehicle);
  }

  tileHasProgressWithin(tileIdx: number, center: number, radius: number): boolean {
    const slice = this.tileEntries(tileIdx);
    if (slice === undefined || slice.length === 0) return false;
    const lo = Math.min(Math.max(f32(center - radius), 0), 1);
    const hi = Math.min(Math.max(f32(center + radius), 0), 1);
    const first = slice.find((e) => !(e.progress < lo));
    return first !== undefined && first.progress <= hi;
  }

  /** Leader ahead on the current or next route tile: `(gap_tiles, leader_speed)`. */
  leaderAhead(
    grid: MapGrid,
    pool: PathPool,
    egoTile: TilePos,
    egoProgress: number,
    pathHandle: number,
    pathCursor: number,
  ): readonly [number, number] | undefined {
    let best: readonly [number, number] | undefined;
    const tileIdx = grid.idx(egoTile);
    if (tileIdx !== undefined) {
      const lead = (this.tileEntries(tileIdx) ?? NO_ENTRIES).find((e) => !(e.progress <= egoProgress));
      if (lead !== undefined) best = [Math.max(f32(lead.progress - egoProgress), 0), lead.speed];
    }
    const next = pool.getTile(pathHandle, pathCursor + 1);
    const nextIdx = next === undefined ? undefined : grid.idx(next);
    const first = nextIdx === undefined ? undefined : this.tileFirst(nextIdx);
    if (first !== undefined) {
      const g = f32(f32(1 - egoProgress) + first.progress);
      if (best === undefined || !(best[0] <= g)) best = [Math.max(g, 0), first.speed];
    }
    return best;
  }

  leaderAheadEntity(
    grid: MapGrid,
    pool: PathPool,
    ego: number,
    egoTile: TilePos,
    egoProgress: number,
    pathHandle: number,
    pathCursor: number,
  ): readonly [vehicle: number, gapTiles: number, speed: number] | undefined {
    const tileIdx = grid.idx(egoTile);
    if (tileIdx === undefined) return undefined;
    const slice = this.tileEntries(tileIdx);
    if (slice === undefined || slice.length === 0) return undefined;
    const i0 = slice.findIndex((e) => !(e.progress <= egoProgress));
    if (i0 >= 0) {
      for (const e of slice.slice(i0)) {
        if (e.vehicle !== ego) return [e.vehicle, Math.max(f32(e.progress - egoProgress), 0), e.speed];
      }
    }
    const next = pool.getTile(pathHandle, pathCursor + 1);
    if (next !== undefined) {
      const nextIdx = grid.idx(next);
      if (nextIdx === undefined) return undefined;
      const first = this.tileFirst(nextIdx);
      if (first !== undefined) return [first.vehicle, Math.max(f32(f32(1 - egoProgress) + first.progress), 0), first.speed];
    }
    return undefined;
  }
}

/** `build_traffic_spatial_index` (and its pre-lane-change twin). */
export function buildTrafficSpatialIndex(w: World): void {
  w.spatialIndex.rebuild(w);
}
