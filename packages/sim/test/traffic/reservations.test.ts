// Ported from crates/simcity_sim/src/game/traffic/intersection/reservations.rs (mod tests_ledger).
// Vehicles are plain numbers here (the TS vehicle reference).
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
  it('ledgerAtomicAdmitAndOrFoldRelease', () => {
    const m = ConflictMatrix.fromPaths([[t(0, 0), t(1, 0)], [t(1, 0), t(1, 1)], [t(5, 5)]]);
    const [e0, e1, e2] = [1, 2, 3];
    const ledger = new IntersectionLedger();
    expect(ledger.tryAdmit(e0, 0, m.row(0)), 'first admit succeeds').toBe(true);
    expect(ledger.tryAdmit(e1, 1, m.row(1)), 'lanelet 1 conflicts with held lanelet 0').toBe(false);
    expect(ledger.tryAdmit(e2, 2, m.row(2)), 'disjoint lanelet 2 admits alongside held lanelet 0').toBe(true);
    expect(ledger.holderCount()).toBe(2);

    expect(ledger.tryAdmit(e0, 0, m.row(0)), 're-admitting a holder is a no-op success').toBe(true);
    expect(ledger.holderCount()).toBe(2);

    ledger.release(e0);
    expect(ledger.holds(e0)).toBe(false);
    expect(ledger.holderCount()).toBe(1);
    expect(ledger.tryAdmit(e1, 1, m.row(1)), 'after releasing lanelet 0, lanelet 1 admits').toBe(true);
  });

  it('pedMaskBlocksCrossingLanelet', () => {
    const m = ConflictMatrix.fromPathsWithCrosswalks([[t(0, 0), t(1, 0)], [t(5, 5)]], [[t(1, 0), t(1, 1)]]);
    const ledger = new IntersectionLedger();
    ledger.setPedCrosswalk(m.crosswalkBase());
    expect(ledger.tryAdmit(1, 0, m.row(0)), 'lanelet crossing an occupied crosswalk is refused').toBe(false);
    expect(ledger.tryAdmit(2, 1, m.row(1)), 'lanelet not crossing the crosswalk still admits').toBe(true);
    ledger.clearPedMask();
    expect(ledger.tryAdmit(1, 0, m.row(0))).toBe(true);
  });

  it('inboxMaskBlocksConflictingEntrantWithoutHolder', () => {
    const m = ConflictMatrix.fromPaths([[t(0, 0), t(1, 0)], [t(1, 0), t(1, 1)]]);
    const ledger = new IntersectionLedger();
    ledger.setInboxLanelet(0);
    expect(ledger.tryAdmit(1, 1, m.row(1)), 'conflicting entrant refused by inbox mask even without a holder').toBe(
      false,
    );
    ledger.clearInboxMask();
    expect(ledger.tryAdmit(1, 1, m.row(1))).toBe(true);
  });

  it('releaseIntersectionHoldsFreesLedger', () => {
    const m = ConflictMatrix.fromPaths([[t(0, 0), t(1, 0)], [t(1, 0), t(1, 1)]]);
    const id = 0;
    const res = new IntersectionReservations();
    expect(res.ledgerMut(id).tryAdmit(1, 0, m.row(0))).toBe(true);
    expect(res.ledgerMut(id).tryAdmit(2, 1, m.row(1))).toBe(false);

    releaseIntersectionHolds(res, [[id, 1]]);
    expect(res.ledgerMut(id).tryAdmit(2, 1, m.row(1)), 'lanelet 1 admittable once the first holder released').toBe(true);

    releaseIntersectionHolds(res, [[99, 123]]);
  });
});
