// Intersection reservations and the per-intersection ledger. The Rust ledger held whole lanelets until a
// car left the box; this one holds tiles: a crossing car keeps the tiles under and ahead of it and gives
// back each tile its rear has passed, so the next conflicting movement can follow it in. Vehicles are
// vehicle references (see vehicles.ts).
import type { World } from '../world';
import { rowsOverlap, type ConflictMatrix } from '../transport/lanelet/conflict';
import { VEHICLE_HALF_LENGTH_TILES } from './constants';
import type { ManeuverKind } from './maneuver';
import { resolveVehicle } from './vehicles';

export type ReservationState = 'Approaching' | 'Inside';

export interface IntersectionReservation {
  readonly vehicle: number;
  state: ReservationState;
  readonly createdAtSec: number;
  readonly maneuver: ManeuverKind;
  /** Local conflict-matrix row of the lanelet, taken at box entry; `null` for coarse and in-box rows. */
  readonly localIdx: number | null;
  /** A coarse whole-box grant: admitted at the entry gate without a per-lanelet check. */
  readonly coarse: boolean;
}

function setBit(mask: number[], bit: number): void {
  const word = bit >>> 5;
  while (mask.length <= word) mask.push(0);
  mask[word] = mask[word]! | (1 << (bit & 31));
}

function hasBit(mask: readonly number[], bit: number): boolean {
  const word = mask[bit >>> 5];
  return word !== undefined && ((word >>> (bit & 31)) & 1) === 1;
}

function popcount32(x: number): number {
  let v = x >>> 0;
  let n = 0;
  while (v !== 0) {
    v &= v - 1;
    n += 1;
  }
  return n;
}

interface Hold {
  readonly vehicle: number;
  readonly localIdx: number;
  readonly tiles: readonly number[];
  /** Tiles before this index are behind the car and released. */
  from: number;
}

/** What this tick's grants already promised: the granted lanelets, as a list and as bits. */
export interface GrantMask {
  readonly granted: number[];
  readonly lanelets: number[];
}

export function emptyGrantMask(): GrantMask {
  return { granted: [], lanelets: [] };
}

export function grantMaskAdd(grant: GrantMask, _matrix: ConflictMatrix, localIdx: number): void {
  grant.granted.push(localIdx);
  setBit(grant.lanelets, localIdx);
}

export class IntersectionLedger {
  private holdList: Hold[] = [];
  /** Tiles still held by some car (tile indices of the intersection). */
  private occupied: number[] = [];
  /** Lanelets whose holder still has tiles ahead: the side of a forced pair that blocks. */
  private semanticHeld: number[] = [];
  private pedMask: number[] = [];
  /** Tiles of in-box cars without a hold (a graph rebuild lost it), seeded per tick. */
  private inboxTiles: number[] = [];
  private builtFor = 0;
  private coarseHeld: number | null = null;

  resetForVersion(version: number): void {
    this.holdList = [];
    this.occupied = [];
    this.semanticHeld = [];
    this.pedMask = [];
    this.inboxTiles = [];
    this.coarseHeld = null;
    this.builtFor = version;
  }

  clearPedMask(): void {
    this.pedMask = [];
  }

  setPedCrosswalk(crosswalkRowIdx: number): void {
    setBit(this.pedMask, crosswalkRowIdx);
  }

  clearInboxMask(): void {
    this.inboxTiles = [];
  }

  setInboxTiles(tiles: readonly number[]): void {
    for (const tile of tiles) setBit(this.inboxTiles, tile);
  }

  builtForVersion(): number {
    return this.builtFor;
  }

  /** Admit `localIdx` iff its tiles are free, its crosswalks empty and no forced pair is held. Idempotent. */
  tryAdmit(vehicle: number, localIdx: number, matrix: ConflictMatrix): boolean {
    if (this.holdList.some((h) => h.vehicle === vehicle)) return true;
    if (!this.admissible(localIdx, matrix, undefined)) return false;
    this.holdList.push({ vehicle, localIdx, tiles: matrix.tiles(localIdx), from: 0 });
    this.rebuild();
    return true;
  }

  /** The car's rear has passed the first `count` tiles of its path: they are free for others. */
  passed(vehicle: number, count: number): void {
    const hold = this.holdList.find((h) => h.vehicle === vehicle);
    if (hold === undefined) return;
    const next = Math.min(Math.max(count, hold.from), hold.tiles.length);
    if (next === hold.from) return;
    hold.from = next;
    this.rebuild();
  }

  /** Grant-phase check without taking the box; `grant` holds what was granted this tick. */
  grantEligible(localIdx: number, matrix: ConflictMatrix, grant: GrantMask): boolean {
    return this.admissible(localIdx, matrix, grant);
  }

  /**
   * Free tiles, empty crosswalks, no forced pair held. Cars on the same lanelet never block each other
   * here: they follow one another through the box and car following keeps them apart.
   */
  private admissible(localIdx: number, matrix: ConflictMatrix, grant: GrantMask | undefined): boolean {
    if (this.coarseHeld !== null) return false;
    const mine: number[] = [];
    for (const tile of matrix.tiles(localIdx)) {
      if (hasBit(this.inboxTiles, tile)) return false;
      setBit(mine, tile);
    }
    for (const hold of this.holdList) {
      if (hold.localIdx === localIdx) continue;
      for (let i = hold.from; i < hold.tiles.length; i++) if (hasBit(mine, hold.tiles[i]!)) return false;
    }
    if (grant !== undefined) {
      for (const other of grant.granted) {
        if (other === localIdx) continue;
        for (const tile of matrix.tiles(other)) if (hasBit(mine, tile)) return false;
      }
    }
    if (rowsOverlap(matrix.row(localIdx), this.pedMask)) return false;
    const semantic = matrix.semanticRow(localIdx);
    if (rowsOverlap(semantic, this.semanticHeld)) return false;
    return grant === undefined || !rowsOverlap(semantic, grant.lanelets);
  }

  private boxIsClear(): boolean {
    const empty = (mask: number[]) => mask.every((w) => w === 0);
    return this.coarseHeld === null && empty(this.occupied) && empty(this.pedMask) && empty(this.inboxTiles);
  }

  /** Whole-box admission for a vehicle without a resolvable lanelet: only into a clear box, with no precise grant this tick. */
  tryAdmitCoarse(vehicle: number, grant: GrantMask): boolean {
    if (this.coarseHeld === vehicle) return true;
    if (!this.boxIsClear() || grant.granted.length > 0) return false;
    this.coarseHeld = vehicle;
    return true;
  }

  release(vehicle: number): void {
    if (this.coarseHeld === vehicle) this.coarseHeld = null;
    const before = this.holdList.length;
    this.holdList = this.holdList.filter((h) => h.vehicle !== vehicle);
    if (this.holdList.length !== before) this.rebuild();
  }

  private rebuild(): void {
    this.occupied = [];
    this.semanticHeld = [];
    for (const hold of this.holdList) {
      if (hold.from >= hold.tiles.length) continue;
      for (let i = hold.from; i < hold.tiles.length; i++) setBit(this.occupied, hold.tiles[i]!);
      setBit(this.semanticHeld, hold.localIdx);
    }
  }

  holderCount(): number {
    return this.holdList.length;
  }

  holds(vehicle: number): boolean {
    return this.coarseHeld === vehicle || this.holdList.some((h) => h.vehicle === vehicle);
  }

  /** The hold of `vehicle`: its lanelet and how many of its tiles are already behind it. */
  holdOf(vehicle: number): { readonly localIdx: number; readonly from: number } | undefined {
    const hold = this.holdList.find((h) => h.vehicle === vehicle);
    return hold === undefined ? undefined : { localIdx: hold.localIdx, from: hold.from };
  }

  /** The tiles `vehicle` still holds (not yet behind it). */
  heldTiles(vehicle: number): readonly number[] {
    const hold = this.holdList.find((h) => h.vehicle === vehicle);
    return hold === undefined ? [] : hold.tiles.slice(hold.from);
  }

  /** Tiles currently held. */
  activePoints(): number {
    return this.occupied.reduce((n, w) => n + popcount32(w), 0);
  }

  fingerprintState(): unknown {
    return [
      this.holdList.map((h) => [h.vehicle, h.localIdx, h.from]),
      this.pedMask,
      this.inboxTiles,
      this.builtFor,
      this.coarseHeld,
    ];
  }
}

export class IntersectionReservations {
  readonly byIntersection = new Map<number, IntersectionReservation[]>();
  private readonly ledgers = new Map<number, IntersectionLedger>();

  ledgerMut(id: number): IntersectionLedger {
    let ledger = this.ledgers.get(id);
    if (ledger === undefined) {
      ledger = new IntersectionLedger();
      this.ledgers.set(id, ledger);
    }
    return ledger;
  }

  ledger(id: number): IntersectionLedger | undefined {
    return this.ledgers.get(id);
  }

  heldPointsMax(): number {
    return Math.max(0, ...[...this.ledgers.values()].map((l) => l.activePoints()));
  }

  isReserved(id: number): boolean {
    return (this.byIntersection.get(id)?.length ?? 0) > 0;
  }

  isReservedBy(id: number, vehicle: number): boolean {
    return this.byIntersection.get(id)?.some((r) => r.vehicle === vehicle) ?? false;
  }

  /** The box-entry gate lookup: `vehicle`'s reservation at `id`, if any. */
  entryReservation(id: number, vehicle: number): { readonly localIdx: number | null; readonly coarse: boolean } | undefined {
    const r = this.byIntersection.get(id)?.find((x) => x.vehicle === vehicle);
    return r === undefined ? undefined : { localIdx: r.localIdx, coarse: r.coarse };
  }

  /** Drops every reservation row and every ledger. */
  reset(): void {
    this.byIntersection.clear();
    this.ledgers.clear();
  }

  fingerprintState(): unknown {
    const ids = (m: Map<number, unknown>) => [...m.keys()].sort((a, b) => a - b);
    return {
      rows: ids(this.byIntersection).map((id) => [id, this.byIntersection.get(id)]),
      ledgers: ids(this.ledgers).map((id) => [id, this.ledgers.get(id)!.fingerprintState()]),
    };
  }
}

export function releaseIntersectionHolds(reservations: IntersectionReservations, dropped: ReadonlyArray<readonly [number, number]>): void {
  for (const [id, vehicle] of dropped) reservations.ledger(id)?.release(vehicle);
}

/** Below this speed an Approaching holder is not moving into the box. */
const STALE_APPROACH_SPEED_EPS = Math.fround(0.1);
/** How long a stationary Approaching holder may keep its claim, s. */
const STALE_APPROACH_RELEASE_SECS = 1.5;
/** How long any Approaching claim may wait for entry, s. */
const APPROACH_TIMEOUT_SECS = 6;

/** Fixed-step elapsed seconds inside the current tick: ticks so far, this one included. */
export function fixedElapsedSecs(w: World): number {
  return ((w.tick + 1) * 100_000_000) / 1e9;
}

/**
 * How many leading tiles of the held lanelet the car's rear has passed, read off its route: a tile
 * counts once the rear is beyond its far edge. A path tile the route does not contain stops the count
 * (the hold then lasts until the car leaves the box, as before).
 */
function tilesPassed(w: World, id: number, localIdx: number, slot: number): number {
  const laneletId = w.laneletGraph.ofIntersection(id)[localIdx];
  const lanelet = laneletId === undefined ? undefined : w.laneletGraph.get(laneletId);
  if (lanelet === undefined) return 0;
  const v = w.vehicles;
  const handle = v.pathHandle[slot]!;
  const cursor = v.pathCursor[slot]!;
  const rear = cursor + v.progress[slot]! - VEHICLE_HALF_LENGTH_TILES;
  const len = w.pathPool.len(handle);
  let j = Math.max(cursor - lanelet.internalPath.length - 1, 0);
  let passed = 0;
  for (const tile of lanelet.internalPath) {
    while (j < len) {
      const at = w.pathPool.getTile(handle, j);
      if (at !== undefined && at.x === tile.x && at.y === tile.y) break;
      j += 1;
    }
    if (j >= len || rear < j + 0.5) break;
    passed += 1;
    j += 1;
  }
  return passed;
}

/** `cleanup_intersection_reservations` (TrafficStep::Movement, after moveVehicles). */
export function cleanupIntersectionReservations(w: World): void {
  const now = fixedElapsedSecs(w);
  const v = w.vehicles;
  const dropped: Array<readonly [number, number]> = [];
  const ids = [...w.reservations.byIntersection.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const list = w.reservations.byIntersection.get(id);
    if (list === undefined) continue;
    const kept = list.filter((r) => {
      const keep = reservationSurvives(w, r, id, now);
      if (!keep) dropped.push([id, r.vehicle]);
      return keep;
    });
    if (kept.length === 0) w.reservations.byIntersection.delete(id);
    else w.reservations.byIntersection.set(id, kept);
    // Hand back the tiles each surviving holder has driven past.
    const ledger = w.reservations.ledger(id);
    if (ledger === undefined) continue;
    for (const r of kept) {
      const hold = ledger.holdOf(r.vehicle);
      const slot = resolveVehicle(v, r.vehicle);
      if (hold === undefined || slot === undefined) continue;
      ledger.passed(r.vehicle, tilesPassed(w, id, hold.localIdx, slot));
    }
  }
  releaseIntersectionHolds(w.reservations, dropped);

  function reservationSurvives(world: World, r: IntersectionReservation, id: number, nowSecs: number): boolean {
    const slot = resolveVehicle(v, r.vehicle);
    if (slot === undefined) return false;
    const handle = v.pathHandle[slot]!;
    const cursor = v.pathCursor[slot]!;
    if (cursor >= world.pathPool.len(handle)) return false;
    const cur = world.pathPool.getTile(handle, cursor);
    if (cur === undefined) return false;
    const curId = world.intersections.intersectionIdAt(cur);
    if (curId === id) r.state = 'Inside';
    if (r.state === 'Approaching') {
      const next = world.pathPool.getTile(handle, cursor + 1);
      const nextId = next === undefined ? undefined : world.intersections.intersectionIdAt(next);
      if (nextId !== id) return false;
      if (v.speed[slot]! < STALE_APPROACH_SPEED_EPS && nowSecs - r.createdAtSec > STALE_APPROACH_RELEASE_SECS) return false;
      if (nowSecs - r.createdAtSec > APPROACH_TIMEOUT_SECS) return false;
      return true;
    }
    return curId === id;
  }
}
