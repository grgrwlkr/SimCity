// Port of crates/simcity_sim/src/game/traffic/intersection/arbiter.rs: the lanelet admission arbiter,
// the sole producer of intersection reservations. Candidates one tile before a box are resolved to
// their lanelet, ranked (width, maneuver, aging, distance, помеха-справа) and granted against the
// per-intersection ledger; a grant does not pre-lock the box, the conflict tile is taken at entry.
import type { RoadDir, TilePos } from '../commands';
import type { MapGrid } from '../map/grid';
import { tileKey } from '../map/grid';
import { dirLeft, dirRight } from '../map/roads';
import type { LaneGraph } from '../transport/laneGraph';
import type { LaneletConflictMatrices } from '../transport/lanelet/build';
import type { LaneletGraph } from '../transport/lanelet/graph';
import { dirBetweenAdjacent } from '../transport/lanelet/pathfinding';
import type { World } from '../world';
import type { TrafficConfig } from './config';
import { STUCK_REROUTE_SECS } from './constants';
import { isAllRed, isGreen, isLeftProtected, isYellow, type TrafficLight } from './lights';
import { maneuverKind, type ManeuverKind } from './maneuver';
import type { PathPool } from './pathPool';
import { grantMaskSet, type IntersectionReservations } from './reservations';
import { isIntersectionTile } from './state';
import { resolveVehicle, type VehicleTrafficState } from './vehicles';

const f32 = Math.fround;

/** Intersections in strictly ascending id: the global order of the grant sweep. */
export function orderedIntersectionIds(llg: LaneletGraph): number[] {
  return [...llg.byIntersection.keys()].sort((a, b) => a - b);
}

/** `LaneletId -> local matrix row` per intersection, rebuilt only when the matrix version changes. */
export class ArbiterIndexCache {
  version = 0;
  localIdx = new Map<number, Map<number, number>>();

  ensureBuiltFor(version: number, llg: LaneletGraph): void {
    if (this.version === version && this.localIdx.size > 0) return;
    this.localIdx.clear();
    for (const [id, laneletIds] of llg.byIntersection) {
      const idx = new Map<number, number>();
      laneletIds.forEach((lid, local) => idx.set(lid, local));
      this.localIdx.set(id, idx);
    }
    this.version = version;
  }
}

export interface ArbiterGrantCandidate {
  readonly vehicle: number;
  readonly seq: number;
  /** Local matrix row of the lanelet; meaningless when `coarse`. */
  readonly localIdx: number;
  /** Unresolved lanelet: admitted through the exclusive whole-box grant. */
  readonly coarse: boolean;
  readonly priority: number;
  readonly distToEntry: number;
  readonly ready: boolean;
  readonly isRightOnRed: boolean;
  readonly entryDir: RoadDir;
  readonly maneuver: ManeuverKind;
}

export interface ArbiterInboxVehicle {
  readonly vehicle: number;
  readonly seq: number;
  readonly intersection: number;
}

/** Ticks of unresolved-lanelet approach before the reroute is forced (2 s at 10 Hz). */
export const LANELET_STALL_REROUTE_TICKS = 20;

export interface Readiness {
  readonly ready: boolean;
  readonly isRightOnRed: boolean;
}

const READY: Readiness = { ready: true, isRightOnRed: false };
const NOT_READY: Readiness = { ready: false, isRightOnRed: false };

/**
 * ПДД readiness one tile before the box. Uncontrolled, or signalized without a live light: ready.
 * Protected left for a left turn, green or yellow: ready. All-red: never. Red: only a right turn on
 * red, when the rulebook allows it, after stopping for this very stop tile.
 */
export function laneletReadiness(
  signalized: boolean,
  light: TrafficLight | undefined,
  entryDir: RoadDir,
  exitDir: RoadDir,
  maneuver: ManeuverKind,
  state: VehicleTrafficState,
  cur: TilePos,
  driveOnRight: boolean,
  rightTurnOnRed: boolean,
): Readiness {
  if (!signalized || light === undefined) return READY;
  if (isLeftProtected(light, entryDir) && maneuver === 'LeftTurn') return READY;
  if (isGreen(light, entryDir) || isYellow(light, entryDir)) return READY;
  if (isAllRed(light) || !rightTurnOnRed) return NOT_READY;
  const stoppedForThis =
    (state.kind === 'Stopped' || state.kind === 'WaitingForGreen') && state.stopTile.x === cur.x && state.stopTile.y === cur.y;
  if (!stoppedForThis) return NOT_READY;
  const nearSide = driveOnRight ? dirRight(entryDir) : dirLeft(entryDir);
  return exitDir === nearSide ? { ready: true, isRightOnRed: true } : NOT_READY;
}

/** Simultaneous-arrival tolerance of the pairwise помеха-справа correction, tiles. */
const RIGHT_HAND_DIST_TIE_EPS_TILES = f32(0.1);

/** Fixed direction precedence N > E > S > W: the deadlock-free base order behind the right-hand rule. */
function dirPrecedence(dir: RoadDir): number {
  switch (dir) {
    case 'North':
      return 3;
    case 'East':
      return 2;
    case 'South':
      return 1;
    default:
      return 0;
  }
}

export const MANEUVER_STEP = 16;
export const WIDTH_STEP = 4096;
export const AGING_CAP = 4000;

/** Width dominates hard; within a width class `maneuver * 16 + aging` (clamped under the width step). */
export function candidatePriority(entryLanes: number, maneuver: ManeuverKind, aging: number): number {
  const widthRank = Math.max(Math.floor(entryLanes / 2) - 1, 0);
  const maneuverRank = maneuver === 'Straight' ? 2 : maneuver === 'RightTurn' ? 1 : 0;
  const withinWidth = Math.min(maneuverRank * MANEUVER_STEP + Math.min(aging, AGING_CAP), WIDTH_STEP - 1);
  return widthRank * WIDTH_STEP + withinWidth;
}

/**
 * The lanelet a vehicle is about to enter, from route geometry: the exact (entry lane, exit lane)
 * pair first, else the unique lanelet of `maneuver` from the entry lane. Ambiguity resolves to nothing.
 */
export function resolveLaneletFallback(
  llg: LaneletGraph,
  lanes: LaneGraph,
  id: number,
  cur: TilePos,
  exitTile: TilePos,
  maneuver: ManeuverKind,
): number | undefined {
  const entryLane = lanes.posToId.get(tileKey(cur));
  if (entryLane === undefined) return undefined;
  const exitLane = lanes.posToId.get(tileKey(exitTile));
  if (exitLane !== undefined) {
    const exact = llg.laneletsFrom(entryLane).find((lid) => {
      const l = llg.get(lid);
      return l !== undefined && l.exitLane === exitLane && l.intersection === id;
    });
    if (exact !== undefined) return exact;
  }
  let found: number | undefined;
  for (const lid of llg.laneletsFrom(entryLane)) {
    const l = llg.get(lid);
    if (l === undefined || l.intersection !== id || l.maneuver !== maneuver) continue;
    if (found !== undefined) return undefined;
    found = lid;
  }
  return found;
}

/** The lanelet an in-box vehicle is traversing: the approach tile before the cluster and the exit after it. */
export function resolveInboxLanelet(
  pool: PathPool,
  grid: MapGrid,
  llg: LaneletGraph,
  lanes: LaneGraph,
  cfg: TrafficConfig,
  handle: number,
  cursor: number,
  id: number,
): number | undefined {
  const len = pool.len(handle);
  let k = cursor;
  let lastCluster: TilePos | undefined;
  while (k < len) {
    const tile = pool.getTile(handle, k);
    if (tile === undefined) return undefined;
    if (!isIntersectionTile(grid, tile)) break;
    lastCluster = tile;
    k += 1;
  }
  const exitTile = pool.getTile(handle, k);
  if (exitTile === undefined) return undefined;
  const diagonalSafe = lastCluster === undefined ? 'None' : dirBetweenAdjacent(lastCluster, exitTile);
  const exitDir: RoadDir = diagonalSafe !== 'None' ? diagonalSafe : (grid.get(exitTile)?.road.dir ?? 'None');
  let j = cursor;
  while (j > 0) {
    j -= 1;
    const tile = pool.getTile(handle, j);
    if (tile === undefined) return undefined;
    if (!isIntersectionTile(grid, tile)) {
      const next = pool.getTile(handle, j + 1);
      const entryDir = next === undefined ? 'None' : dirBetweenAdjacent(tile, next);
      return resolveLaneletFallback(llg, lanes, id, tile, exitTile, maneuverKind(cfg, entryDir, exitDir));
    }
  }
  return undefined;
}

/**
 * Seeds every ledger's per-tick pedestrian mask: a crossing along N/S occupies the West and East
 * crosswalks, along E/W the North and South ones. Returns the activated crosswalk count.
 */
export function seedPedMasks(
  orderedIds: readonly number[],
  crossings: ReadonlyArray<readonly [intersectionId: number, axisNs: boolean]>,
  matrices: LaneletConflictMatrices,
  reservations: IntersectionReservations,
): number {
  for (const id of orderedIds) reservations.ledgerMut(id).clearPedMask();
  let activated = 0;
  for (const [id, axisNs] of crossings) {
    const sides = matrices.crosswalkSides.get(id);
    const matrix = matrices.byIntersection.get(id);
    if (sides === undefined || matrix === undefined) continue;
    const base = matrix.crosswalkBase();
    sides.forEach((side, i) => {
      const active = axisNs ? side === 'West' || side === 'East' : side === 'North' || side === 'South';
      if (!active) return;
      reservations.ledgerMut(id).setPedCrosswalk(base + i);
      activated += 1;
    });
  }
  return activated;
}

export interface ArbiterCounts {
  admitted: number;
  refused: number;
  rtorGrants: number;
  yieldRefusals: number;
  refusedMatrix: number;
  coarseAdmits: number;
  admittedStraight: number;
  admittedRight: number;
  admittedLeft: number;
  admittedUturn: number;
}

function emptyCounts(): ArbiterCounts {
  return {
    admitted: 0,
    refused: 0,
    rtorGrants: 0,
    yieldRefusals: 0,
    refusedMatrix: 0,
    coarseAdmits: 0,
    admittedStraight: 0,
    admittedRight: 0,
    admittedLeft: 0,
    admittedUturn: 0,
  };
}

function countAdmit(counts: ArbiterCounts, cand: ArbiterGrantCandidate): void {
  if (cand.coarse) counts.coarseAdmits += 1;
  else if (cand.maneuver === 'Straight') counts.admittedStraight += 1;
  else if (cand.maneuver === 'RightTurn') counts.admittedRight += 1;
  else if (cand.maneuver === 'LeftTurn') counts.admittedLeft += 1;
  else if (cand.maneuver === 'UTurn') counts.admittedUturn += 1;
}

const bySeqThenRef = (a: { seq: number; vehicle: number }, b: { seq: number; vehicle: number }) =>
  a.seq - b.seq || a.vehicle - b.vehicle;

/**
 * Grant core: safety-net Inside rows for in-box vehicles, then per intersection in ascending id the
 * ranked candidates are granted against the ledger. Ledgers must already be reset to the current
 * matrix version. Independent of input order.
 */
export function arbitrateGrantsInner(
  now: number,
  orderedIds: readonly number[],
  candidatesById: ReadonlyMap<number, readonly ArbiterGrantCandidate[]>,
  matrices: LaneletConflictMatrices,
  inbox: readonly ArbiterInboxVehicle[],
  reservations: IntersectionReservations,
): ArbiterCounts {
  const counts = emptyCounts();

  for (const iv of [...inbox].sort(bySeqThenRef)) {
    if (reservations.isReservedBy(iv.intersection, iv.vehicle)) continue;
    rowsOf(reservations, iv.intersection).push({
      vehicle: iv.vehicle,
      state: 'Inside',
      createdAtSec: now,
      maneuver: 'Other',
      localIdx: null,
      coarse: false,
    });
  }

  for (const id of orderedIds) {
    const cands = candidatesById.get(id);
    if (cands === undefined || cands.length === 0) continue;
    const matrix = matrices.byIntersection.get(id);
    if (matrix === undefined) continue;
    const ledger = reservations.ledgerMut(id);

    const order = [...cands].sort(
      (a, b) =>
        b.priority - a.priority ||
        (a.distToEntry < b.distToEntry ? -1 : a.distToEntry > b.distToEntry ? 1 : 0) ||
        dirPrecedence(b.entryDir) - dirPrecedence(a.entryDir) ||
        bySeqThenRef(a, b),
    );
    // Pairwise помеха-справа: of two otherwise equal neighbours, the one with the rival on its right yields.
    for (let i = 0; i + 1 < order.length; i++) {
      const a = order[i]!;
      const b = order[i + 1]!;
      const tied = a.priority === b.priority && Math.abs(f32(a.distToEntry - b.distToEntry)) <= RIGHT_HAND_DIST_TIE_EPS_TILES;
      if (tied && b.entryDir === dirLeft(a.entryDir)) {
        order[i] = b;
        order[i + 1] = a;
      }
    }

    const grantMask: number[] = [];
    for (const cand of order) {
      if (!cand.ready) {
        counts.refused += 1;
        counts.yieldRefusals += 1;
        continue;
      }
      // Right turn on red is a yield maneuver: only into an otherwise clear cluster.
      if (cand.isRightOnRed && reservations.isReserved(id)) {
        counts.refused += 1;
        continue;
      }
      if (reservations.isReservedBy(id, cand.vehicle) || ledger.holds(cand.vehicle)) continue;
      let ok: boolean;
      if (cand.coarse) {
        ok = ledger.tryAdmitCoarse(cand.vehicle, grantMask);
      } else {
        ok = ledger.grantEligible(matrix.row(cand.localIdx), grantMask);
        if (ok) grantMaskSet(grantMask, cand.localIdx);
      }
      if (!ok) {
        counts.refused += 1;
        counts.refusedMatrix += 1;
        continue;
      }
      rowsOf(reservations, id).push({
        vehicle: cand.vehicle,
        state: 'Approaching',
        createdAtSec: now,
        maneuver: cand.maneuver,
        localIdx: cand.coarse ? null : cand.localIdx,
        coarse: cand.coarse,
      });
      counts.admitted += 1;
      countAdmit(counts, cand);
      if (cand.isRightOnRed) counts.rtorGrants += 1;
    }
  }
  return counts;
}

function rowsOf(reservations: IntersectionReservations, id: number) {
  let rows = reservations.byIntersection.get(id);
  if (rows === undefined) {
    rows = [];
    reservations.byIntersection.set(id, rows);
  }
  return rows;
}

/** Mandatory merge: a vehicle unresolved for `LANELET_STALL_REROUTE_TICKS` gets its stuck timer maxed. */
export function nudgeLaneletStallReroute(w: World): void {
  const v = w.vehicles;
  for (const [ref, ticks] of w.laneletStallTracker) {
    if (ticks < LANELET_STALL_REROUTE_TICKS) continue;
    const slot = resolveVehicle(v, ref);
    if (slot === undefined || v.hasStuckTimer[slot] !== 1) continue;
    v.stuckSecs[slot] = Math.max(v.stuckSecs[slot]!, STUCK_REROUTE_SECS);
  }
}
