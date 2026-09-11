// The intersection ledger holds conflict tiles, not whole lanelets: a crossing car keeps the tiles still
// ahead of (and under) it and gives back the ones it has passed. Vehicles are plain numbers here.
import { describe, expect, it } from 'vitest';
import type { TilePos } from '../../src/commands';
import { ConflictMatrix } from '../../src/transport/lanelet/conflict';
import {
  IntersectionLedger,
  IntersectionReservations,
  releaseIntersectionHolds,
} from '../../src/traffic/reservations';

const t = (x: number, y: number): TilePos => ({ x, y });

describe('intersection ledger', () => {
  it('ledgerAtomicAdmitAndRelease', () => {
    const m = ConflictMatrix.fromPaths([[t(0, 0), t(1, 0)], [t(1, 0), t(1, 1)], [t(5, 5)]]);
    const [e0, e1, e2] = [1, 2, 3];
    const ledger = new IntersectionLedger();
    expect(ledger.tryAdmit(e0, 0, m), 'first admit succeeds').toBe(true);
    expect(ledger.tryAdmit(e1, 1, m), 'lanelet 1 shares a tile with held lanelet 0').toBe(false);
    expect(ledger.tryAdmit(e2, 2, m), 'disjoint lanelet 2 admits alongside held lanelet 0').toBe(true);
    expect(ledger.holderCount()).toBe(2);

    expect(ledger.tryAdmit(e0, 0, m), 're-admitting a holder is a no-op success').toBe(true);
    expect(ledger.holderCount()).toBe(2);

    ledger.release(e0);
    expect(ledger.holds(e0)).toBe(false);
    expect(ledger.holderCount()).toBe(1);
    expect(ledger.tryAdmit(e1, 1, m), 'after releasing lanelet 0, lanelet 1 admits').toBe(true);
  });

  it('aCrossingCarGivesBackTheTilesItHasPassed', () => {
    // Lanelet 0 runs (0,0) -> (1,0) -> (2,0); lanelet 1 needs only (0,0), then leaves the box.
    const m = ConflictMatrix.fromPaths([[t(0, 0), t(1, 0), t(2, 0)], [t(0, 0), t(0, 1)]]);
    const ledger = new IntersectionLedger();
    expect(ledger.tryAdmit(1, 0, m)).toBe(true);
    expect(ledger.tryAdmit(2, 1, m), '(0,0) is still under the crossing car').toBe(false);
    ledger.passed(1, 1);
    expect(ledger.tryAdmit(2, 1, m), 'its rear has left (0,0): the other car may take it').toBe(true);
    expect(ledger.tryAdmit(3, 0, m), 'the tiles still ahead of the first car stay held').toBe(false);
  });

  it('aSemanticConflictHoldsWhileTheHolderIsInTheBox', () => {
    // Tile-disjoint paths joined by a forced pair (a left turn yields to the oncoming straight).
    const m = ConflictMatrix.fromPaths([[t(0, 0), t(1, 0)], [t(5, 5), t(6, 5)]]);
    m.addConflictPair(0, 1);
    const ledger = new IntersectionLedger();
    expect(ledger.tryAdmit(1, 0, m)).toBe(true);
    ledger.passed(1, 1);
    expect(ledger.tryAdmit(2, 1, m), 'the forced pair blocks while the holder still has tiles ahead').toBe(false);
    ledger.passed(1, 2);
    expect(ledger.tryAdmit(2, 1, m), 'a holder past all its tiles no longer blocks').toBe(true);
  });

  it('pedMaskBlocksCrossingLanelet', () => {
    const m = ConflictMatrix.fromPathsWithCrosswalks([[t(0, 0), t(1, 0)], [t(5, 5)]], [[t(1, 0), t(1, 1)]]);
    const ledger = new IntersectionLedger();
    ledger.setPedCrosswalk(m.crosswalkBase());
    expect(ledger.tryAdmit(1, 0, m), 'lanelet crossing an occupied crosswalk is refused').toBe(false);
    expect(ledger.tryAdmit(2, 1, m), 'lanelet not crossing the crosswalk still admits').toBe(true);
    ledger.clearPedMask();
    expect(ledger.tryAdmit(1, 0, m)).toBe(true);
  });

  it('inboxTilesBlockConflictingEntrantWithoutHolder', () => {
    const m = ConflictMatrix.fromPaths([[t(0, 0), t(1, 0)], [t(1, 0), t(1, 1)]]);
    const ledger = new IntersectionLedger();
    ledger.setInboxTiles(m.tiles(0));
    expect(ledger.tryAdmit(1, 1, m), 'conflicting entrant refused by in-box tiles even without a holder').toBe(false);
    ledger.clearInboxMask();
    expect(ledger.tryAdmit(1, 1, m)).toBe(true);
  });

  it('releaseIntersectionHoldsFreesLedger', () => {
    const m = ConflictMatrix.fromPaths([[t(0, 0), t(1, 0)], [t(1, 0), t(1, 1)]]);
    const id = 0;
    const res = new IntersectionReservations();
    expect(res.ledgerMut(id).tryAdmit(1, 0, m)).toBe(true);
    expect(res.ledgerMut(id).tryAdmit(2, 1, m)).toBe(false);

    releaseIntersectionHolds(res, [[id, 1]]);
    expect(res.ledgerMut(id).tryAdmit(2, 1, m), 'lanelet 1 admittable once the first holder released').toBe(true);

    releaseIntersectionHolds(res, [[99, 123]]);
  });
});
