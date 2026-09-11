// Port of crates/simcity_sim/src/game/traffic/intersection/reservations.rs: per-vehicle intersection
// reservations and the per-intersection lanelet ledger (bitsets of 32-bit words, like the conflict
// matrix rows). Vehicles are vehicle references (see vehicles.ts).
import type { World } from '../world';
import { rowsOverlap } from '../transport/lanelet/conflict';
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

function popcount32(x: number): number {
  let v = x >>> 0;
  let n = 0;
  while (v !== 0) {
    v &= v - 1;
    n += 1;
  }
  return n;
}

/**
 * Which lanelets are held at one intersection. `activeMask` is the set of held local indices (not
 * an OR of their rows): a candidate is admissible iff its conflict row shares no bit with it.
 */
export class IntersectionLedger {
  private activeMask: number[] = [];
  private pedMask: number[] = [];
  private inboxMask: number[] = [];
  private holders: Array<readonly [vehicle: number, localIdx: number]> = [];
  private builtFor = 0;
  private coarseHeld: number | null = null;

  resetForVersion(version: number): void {
    this.activeMask = [];
    this.pedMask = [];
    this.inboxMask = [];
    this.holders = [];
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
    this.inboxMask = [];
  }

  setInboxLanelet(localIdx: number): void {
    setBit(this.inboxMask, localIdx);
  }

  builtForVersion(): number {
    return this.builtFor;
  }

  /** Admit `localIdx` iff it conflicts with no holder, crosswalk, in-box vehicle or coarse holder. Idempotent. */
  tryAdmit(vehicle: number, localIdx: number, row: ArrayLike<number>): boolean {
    if (this.holders.some(([v]) => v === vehicle)) return true;
    if (
      this.coarseHeld !== null ||
      rowsOverlap(row, this.activeMask) ||
      rowsOverlap(row, this.pedMask) ||
      rowsOverlap(row, this.inboxMask)
    ) {
      return false;
    }
    setBit(this.activeMask, localIdx);
    this.holders.push([vehicle, localIdx]);
    return true;
  }

  /** Grant-phase check without taking the box; `grantMask` holds the lanelets granted this tick. */
  grantEligible(row: ArrayLike<number>, grantMask: ArrayLike<number>): boolean {
    return !(
      this.coarseHeld !== null ||
      rowsOverlap(row, this.activeMask) ||
      rowsOverlap(row, this.pedMask) ||
      rowsOverlap(row, this.inboxMask) ||
      rowsOverlap(row, grantMask)
    );
  }

  private boxIsClear(): boolean {
    const empty = (mask: number[]) => mask.every((w) => w === 0);
    return this.coarseHeld === null && empty(this.activeMask) && empty(this.pedMask) && empty(this.inboxMask);
  }

  /** Whole-box admission for a vehicle without a resolvable lanelet: only into a clear box, with no precise grant this tick. */
  tryAdmitCoarse(vehicle: number, grantMask: ArrayLike<number>): boolean {
    if (this.coarseHeld === vehicle) return true;
    if (!this.boxIsClear() || Array.from(grantMask).some((w) => w !== 0)) return false;
    this.coarseHeld = vehicle;
    return true;
  }

  /** Drops `vehicle` as a holder and rebuilds `activeMask` from the survivors. */
  release(vehicle: number): void {
    if (this.coarseHeld === vehicle) this.coarseHeld = null;
    const before = this.holders.length;
    this.holders = this.holders.filter(([v]) => v !== vehicle);
    if (this.holders.length === before) return;
    this.activeMask = [];
    for (const [, idx] of this.holders) setBit(this.activeMask, idx);
  }

  getActiveMask(): readonly number[] {
    return this.activeMask;
  }

  holderCount(): number {
    return this.holders.length;
  }

  holds(vehicle: number): boolean {
    return this.coarseHeld === vehicle || this.holders.some(([v]) => v === vehicle);
  }

  activePoints(): number {
    return this.activeMask.reduce((n, w) => n + popcount32(w), 0);
  }

  fingerprintState(): unknown {
    return [this.activeMask, this.pedMask, this.inboxMask, this.holders, this.builtFor, this.coarseHeld];
  }
}

export function grantMaskSet(mask: number[], localIdx: number): void {
  setBit(mask, localIdx);
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

/** `Time<Fixed>::elapsed_secs_f64` inside the current fixed tick: ticks so far, this one included. */
export function fixedElapsedSecs(w: World): number {
  return ((w.tick + 1) * 100_000_000) / 1e9;
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
