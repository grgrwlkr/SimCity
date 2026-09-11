// Port of crates/simcity_sim/src/game/transport/lane_pathfinding.rs: congestion-aware lane edge
// costs (f32, as Rust computes them) and the admissible heuristic of the combined lane+lanelet A*.
import type { RoadKind, TilePos } from '../commands';
import type { MapGrid } from '../map/grid';
import { capacityPerLaneTile, roadDesirability, roadSpeedLimit } from '../map/roads';
import type { TrafficOccupancy } from '../traffic/occupancy';
import type { LaneGraph } from './laneGraph';
import type { PathfindingConfig } from './pathfinding';

const f32 = Math.fround;
export const U32_MAX = 0xffff_ffff;
const MASK64 = (1n << 64n) - 1n;

/** Max additive tie-break in integer A* units; base lane costs are ~25 for TwoLane. */
export const LANE_JITTER_RANGE = 8;
/** Minimum per-tile base cost over all road kinds (SixLane: floor(1/80 / 1.6 * 1000) = 7). */
export const MIN_PER_TILE_BASE = 7;

export interface LaneCostCtx {
  readonly grid: MapGrid;
  readonly traffic: TrafficOccupancy;
  readonly cfg: PathfindingConfig;
  /** Per-trip tie-break seed, u64; `0n` disables the jitter. */
  readonly jitterSeed: bigint;
}

/** `x as u32` for an f32: truncates, saturates, NaN becomes 0. */
export function f32ToU32(x: number): number {
  if (!(x > 0)) return 0;
  return x >= U32_MAX ? U32_MAX : Math.trunc(x);
}

export function satAddU32(a: number, b: number): number {
  return Math.min(a + b, U32_MAX);
}

export function satMulU32(a: number, b: number): number {
  return Math.min(a * b, U32_MAX);
}

/** Integer cost of entering lane `nextId`, keyed on its tile's occupancy, plus the per-trip jitter. */
export function laneEdgeCost(ctx: LaneCostCtx, graph: LaneGraph, nextId: number): number {
  const lane = graph.getLane(nextId);
  if (lane === undefined) return 1;
  const kind = lane.kind;

  const speed = f32(Math.max(roadSpeedLimit(kind), 1));
  const capacity = f32(Math.max(capacityPerLaneTile(kind), 1));
  const desirability = f32(Math.max(roadDesirability(kind), f32(0.1)));

  const i = ctx.grid.idx(lane.pos);
  const occupancy = f32(i === undefined ? 0 : (ctx.traffic.perTickVehicles[i] ?? 0));
  const congestion = Math.min(Math.max(f32(occupancy / capacity), 0), f32(Math.max(ctx.cfg.congestionMax, 0)));

  const baseCost = f32(f32(1 / speed) * f32(1 / desirability));
  const congestionFactor = f32(1 + f32(ctx.cfg.congestionK * congestion));
  const raw = f32(f32(baseCost * congestionFactor) * f32(Math.max(ctx.cfg.costScale, 1)));

  return satAddU32(f32ToU32(Math.max(raw, 1)), laneJitter(ctx.jitterSeed, nextId));
}

/** Uncongested per-tile cost of a road kind; prices lanelet internal tiles. */
export function baseTileCost(kind: RoadKind, cfg: PathfindingConfig): number {
  const speed = f32(Math.max(roadSpeedLimit(kind), 1));
  const desirability = f32(Math.max(roadDesirability(kind), f32(0.1)));
  const raw = f32(f32(f32(1 / speed) * f32(1 / desirability)) * f32(Math.max(cfg.costScale, 1)));
  return f32ToU32(Math.max(raw, 1));
}

/** Deterministic per-edge tie-break: a splitmix64-style mix of `(seed, id)`, in `0..LANE_JITTER_RANGE`. */
export function laneJitter(seed: bigint, id: number): number {
  if (seed === 0n) return 0;
  let z = seed ^ ((BigInt(id) * 0x9e37_79b9_7f4a_7c15n) & MASK64);
  z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK64;
  z ^= z >> 31n;
  return Number(z % BigInt(LANE_JITTER_RANGE));
}

/** Manhattan distance scaled by `MIN_PER_TILE_BASE`, so it stays a lower bound on real edge costs. */
export function heuristicTiles(a: TilePos, b: TilePos): number {
  return satMulU32(Math.abs(a.x - b.x) + Math.abs(a.y - b.y), MIN_PER_TILE_BASE);
}
