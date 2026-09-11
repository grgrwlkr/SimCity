// Port of crates/simcity_sim/src/game/traffic/intersection/arbiter.rs: the lanelet admission arbiter,
// the sole producer of intersection reservations. Candidates one tile before a box are resolved to
// their lanelet, ranked (width, maneuver, aging, distance, помеха-справа) and granted against the
// per-intersection ledger; a grant does not pre-lock the box, the conflict tile is taken at entry.
import type { RoadDir, TilePos } from '../commands';
import { clusterHasOpenExit } from '../intersections/index';
import type { MapGrid } from '../map/grid';
import { tileKey } from '../map/grid';
import { capacityPerLaneTile, dirLeft, dirRight, roadCellIsSome, roadLanes } from '../map/roads';
import type { LaneGraph } from '../transport/laneGraph';
import type { LaneletConflictMatrices } from '../transport/lanelet/build';
import type { LaneletGraph } from '../transport/lanelet/graph';
import { dirBetweenAdjacent } from '../transport/lanelet/pathfinding';
import type { World } from '../world';
import type { TrafficConfig } from './config';
import { STUCK_REROUTE_SECS, TILE_CENTER_TO_EDGE_TILES } from './constants';
import { isAllRed, isGreen, isLeftProtected, isYellow, type TrafficLight } from './lights';
import { maneuverKind, type ManeuverKind } from './maneuver';
import type { PathPool } from './pathPool';
import {
  approachingLanelets,
  emptyGrantMask,
  fixedElapsedSecs,
  grantMaskAdd,
  type IntersectionReservations,
} from './reservations';
import { computeExitDirection, isIntersectionTile } from './state';
import {
  laneletPlanIsCurrent,
  resolveVehicle,
  upcomingLaneletAt,
  vehicleRef,
  type VehicleTrafficState,
} from './vehicles';

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

    const grant = emptyGrantMask();
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
        ok = ledger.tryAdmitCoarse(cand.vehicle, grant);
      } else {
        // A turn facing an oncoming grant is still granted up to its wait point.
        const kind = ledger.grantEligible(cand.localIdx, matrix, grant);
        ok = kind !== undefined;
        if (kind !== undefined) grantMaskAdd(grant, matrix, cand.localIdx, kind);
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

/** Flat per-tick arbiter observability (`ArbiterTickStats`), not simulation state. */
export interface ArbiterTickStats extends ArbiterCounts {
  heldPointsMax: number;
  maxApproachingAgeMs: number;
  pedBlocked: number;
  leftProtectedActive: number;
  /** Vehicles one tile before a box: the candidate denominator. */
  candApproaching: number;
  dropUnresolvedLanelet: number;
  dropStaleLanelet: number;
  candidatesBuilt: number;
  dropOtherCollection: number;
  missingLightTreatedUnsignalized: number;
}

export function emptyArbiterStats(): ArbiterTickStats {
  return {
    ...emptyCounts(),
    heldPointsMax: 0,
    maxApproachingAgeMs: 0,
    pedBlocked: 0,
    leftProtectedActive: 0,
    candApproaching: 0,
    dropUnresolvedLanelet: 0,
    dropStaleLanelet: 0,
    candidatesBuilt: 0,
    dropOtherCollection: 0,
    missingLightTreatedUnsignalized: 0,
  };
}

const sameTile = (a: TilePos, b: TilePos) => a.x === b.x && a.y === b.y;

/**
 * `arbitrate_lanelet_reservations` (TrafficStep::Movement, after the spatial index): resets stale
 * ledgers, seeds pedestrian and in-box masks, collects the candidates one tile before each box and
 * runs the grant sweep; then ages refused approaches and tracks unresolved lanelets.
 */
export function arbitrateLaneletReservations(w: World): void {
  const now = fixedElapsedSecs(w);
  w.leftTurnDemand.ns.clear();
  w.leftTurnDemand.ew.clear();

  const matrices = w.laneletConflicts;
  const version = matrices.version;
  const llg = w.laneletGraph;
  const lanes = w.laneGraph;
  const grid = w.grid;
  const pool = w.pathPool;
  const cfg = w.trafficConfig;
  const intersections = w.intersections;
  const reservations = w.reservations;
  const cache = w.arbiterIndexCache;
  cache.ensureBuiltFor(version, llg);

  const ordered = orderedIntersectionIds(llg);
  for (const id of ordered) {
    const ledger = reservations.ledgerMut(id);
    if (ledger.builtForVersion() !== version) ledger.resetForVersion(version);
    ledger.clearInboxMask();
  }
  const pedBlocked = seedPedMasks(
    ordered,
    w.pedestrianCrossings.map((c) => [c.intersectionId, c.axisNs] as const),
    matrices,
    reservations,
  );

  const lightsById = new Map<number, TrafficLight>();
  for (const light of w.trafficLights) lightsById.set(light.intersectionId, light);
  let leftProtectedActive = 0;
  for (const light of lightsById.values()) {
    if (isLeftProtected(light, 'North') || isLeftProtected(light, 'East')) leftProtectedActive += 1;
  }

  const candidatesById = new Map<number, ArbiterGrantCandidate[]>();
  const inbox: ArbiterInboxVehicle[] = [];
  const unresolvedThisTick = new Set<number>();
  let candApproaching = 0;
  let dropUnresolved = 0;
  let dropStale = 0;
  let dropOther = 0;
  let candidatesBuilt = 0;
  let missingLight = 0;

  const v = w.vehicles;
  for (const slot of v.order) {
    const ref = vehicleRef(v, slot);
    const handle = v.pathHandle[slot]!;
    const cursor = v.pathCursor[slot]!;
    // An exhausted route still blocks its last tile, so in-box seeding falls back to it.
    const cur = pool.getTile(handle, cursor) ?? pool.getTile(handle, Math.max(pool.len(handle) - 1, 0));
    if (cur === undefined) continue;

    if (isIntersectionTile(grid, cur)) {
      const id = intersections.intersectionIdAt(cur);
      if (id !== undefined) {
        inbox.push({ vehicle: ref, seq: v.seq[slot]!, intersection: id });
        const lid = resolveInboxLanelet(pool, grid, llg, lanes, cfg, handle, cursor, id);
        const local = lid === undefined ? undefined : cache.localIdx.get(id)?.get(lid);
        // Only cars without a hold: a holder's own tiles are in the ledger and shrink as it drives on.
        const matrix = matrices.byIntersection.get(id);
        const ledger = reservations.ledgerMut(id);
        if (local !== undefined && matrix !== undefined && !ledger.holds(ref)) ledger.setInboxTiles(matrix.tiles(local));
        // A turn at its wait point finishes once no oncoming car holds the box or is about to enter it.
        const hold = ledger.holdOf(ref);
        if (hold !== undefined && !hold.committed && matrix !== undefined) {
          ledger.tryAdmit(ref, hold.localIdx, matrix, approachingLanelets(reservations, id, ref));
        }
      }
      continue;
    }
    if (v.parked[slot] === 1) continue;
    if (cursor + 1 >= pool.len(handle)) continue;
    const next = pool.getTile(handle, cursor + 1);
    if (next === undefined || !isIntersectionTile(grid, next)) continue;
    const id = intersections.intersectionIdAt(next);
    if (id === undefined) continue;
    candApproaching += 1;

    const entryDir = dirBetweenAdjacent(cur, next);
    if (entryDir === 'None') {
      dropOther += 1;
      continue;
    }
    const rem = pool.remainingFrom(handle, cursor);
    const exitDir: RoadDir = rem === undefined ? 'None' : computeExitDirection(rem, grid, next);
    let exitTile: TilePos | undefined;
    if (rem !== undefined) {
      const start = rem.findIndex((tile) => sameTile(tile, next));
      if (start >= 0) {
        let i = start;
        while (i < rem.length && isIntersectionTile(grid, rem[i]!)) i += 1;
        exitTile = rem[i];
      }
    }
    if (exitTile === undefined) {
      dropOther += 1;
      continue;
    }

    const routeManeuver = maneuverKind(cfg, entryDir, exitDir);
    // A sidecar is trusted only for the current version: lanelet ids are renumbered on every rebuild.
    const plan = v.laneletPlan[slot]!;
    const upcoming = laneletPlanIsCurrent(plan, version) ? upcomingLaneletAt(plan, cursor) : undefined;
    const resolved =
      upcoming !== undefined && upcoming[0] === id
        ? upcoming[1]
        : resolveLaneletFallback(llg, lanes, id, cur, exitTile, routeManeuver);
    const local = resolved === undefined ? undefined : cache.localIdx.get(id)?.get(resolved);
    const lanelet = resolved === undefined ? undefined : llg.get(resolved);
    let coarse = false;
    let localIdx = 0;
    let maneuver = routeManeuver;
    if (local !== undefined && lanelet !== undefined) {
      localIdx = local;
      maneuver = lanelet.maneuver;
    } else {
      // Unresolved or vanished: a coarse whole-box candidate, still tracked for the forced reroute.
      if (resolved !== undefined) dropStale += 1;
      else dropUnresolved += 1;
      unresolvedThisTick.add(ref);
      coarse = true;
    }

    const exitCell = grid.get(exitTile);
    if (
      exitCell === undefined ||
      !roadCellIsSome(exitCell.road) ||
      exitCell.road.dir === 'None' ||
      grid.idx(exitTile) === undefined ||
      capacityPerLaneTile(exitCell.road.kind) === 0
    ) {
      dropOther += 1;
      continue;
    }

    const signalized = intersections.trafficLights.has(id);
    if (signalized && !lightsById.has(id)) missingLight += 1;
    const readiness = laneletReadiness(
      signalized,
      lightsById.get(id),
      entryDir,
      exitDir,
      maneuver,
      v.trafficState[slot]!,
      cur,
      cfg.driveOnRight,
      cfg.rightTurnOnRed,
    );
    // A signalized left turn not yet eligible actuates its axis's protected-left phase next tick.
    if (signalized && maneuver === 'LeftTurn' && !readiness.ready) {
      if (entryDir === 'North' || entryDir === 'South') w.leftTurnDemand.ns.add(id);
      else w.leftTurnDemand.ew.add(id);
    }

    const curCell = grid.get(cur);
    const entryLanes = curCell === undefined ? 0 : roadLanes(curCell.road.kind);
    const aging = w.approachFairness.get(`${id}|${entryDir}`) ?? 0;
    candidatesBuilt += 1;
    let list = candidatesById.get(id);
    if (list === undefined) {
      list = [];
      candidatesById.set(id, list);
    }
    list.push({
      vehicle: ref,
      seq: v.seq[slot]!,
      localIdx,
      coarse,
      priority: candidatePriority(entryLanes, maneuver, aging),
      distToEntry: Math.min(Math.max(f32(TILE_CENTER_TO_EDGE_TILES - v.progress[slot]!), 0), 1),
      ready: readiness.ready,
      isRightOnRed: readiness.isRightOnRed,
      entryDir,
      maneuver,
    });
  }

  const counts = arbitrateGrantsInner(now, ordered, candidatesById, matrices, inbox, reservations);

  // Fairness: age approaches present but not served, reset served ones, drop absent ones.
  const present = new Set<string>();
  const served = new Set<string>();
  for (const [id, cands] of candidatesById) {
    for (const c of cands) {
      const key = `${id}|${c.entryDir}`;
      present.add(key);
      if (reservations.isReservedBy(id, c.vehicle)) served.add(key);
    }
  }
  const fairness = w.approachFairness;
  for (const key of [...fairness.keys()]) if (!present.has(key)) fairness.delete(key);
  for (const key of present) {
    if (served.has(key)) fairness.delete(key);
    else fairness.set(key, Math.min((fairness.get(key) ?? 0) + 1, 0xffff));
  }

  const tracker = w.laneletStallTracker;
  for (const ref of [...tracker.keys()]) if (!unresolvedThisTick.has(ref)) tracker.delete(ref);
  for (const ref of unresolvedThisTick) tracker.set(ref, Math.min((tracker.get(ref) ?? 0) + 1, 0xffff_ffff));

  let maxApproachingAgeMs = 0;
  for (const rows of reservations.byIntersection.values()) {
    for (const r of rows) {
      if (r.state !== 'Approaching') continue;
      maxApproachingAgeMs = Math.max(maxApproachingAgeMs, Math.trunc(Math.max(now - r.createdAtSec, 0) * 1000));
    }
  }
  w.arbiterStats = {
    ...counts,
    heldPointsMax: reservations.heldPointsMax(),
    maxApproachingAgeMs,
    pedBlocked,
    leftProtectedActive,
    candApproaching,
    dropUnresolvedLanelet: dropUnresolved,
    dropStaleLanelet: dropStale,
    candidatesBuilt,
    dropOtherCollection: dropOther,
    missingLightTreatedUnsignalized: missingLight,
  };
}

/** `check_ring_free_topology` (Update / GraphUpdate): advisory count of clusters with no open-road exit, once per version. */
export function checkRingFreeTopology(w: World): void {
  const status = w.ringTopology;
  if (status.lastVersion === w.intersections.version) return;
  status.lastVersion = w.intersections.version;
  status.clustersWithoutOpenExit = w.intersections.clusters.filter((c) => !clusterHasOpenExit(c, w.grid, w.intersections)).length;
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
