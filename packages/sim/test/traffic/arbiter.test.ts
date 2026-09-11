// Port of the unit tests in crates/simcity_sim/src/game/traffic/intersection/arbiter.rs: the pure
// grant core, priority, readiness, lanelet resolution, pedestrian seeding and the index cache.
import { describe, expect, it } from 'vitest';
import type { RoadDir, TilePos } from '../../src/commands';
import { IntersectionIndex, type IntersectionCluster } from '../../src/intersections/index';
import { dirLeft, dirRight } from '../../src/map/roads';
import { tileKey, MapGrid } from '../../src/map/grid';
import {
  AGING_CAP,
  ArbiterIndexCache,
  LANELET_STALL_REROUTE_TICKS,
  MANEUVER_STEP,
  arbitrateGrantsInner,
  candidatePriority,
  laneletReadiness,
  nudgeLaneletStallReroute,
  orderedIntersectionIds,
  resolveLaneletFallback,
  seedPedMasks,
  type ArbiterGrantCandidate,
  type ArbiterInboxVehicle,
} from '../../src/traffic/arbiter';
import { clusterHasOpenExit } from '../../src/intersections/index';
import { STUCK_REROUTE_SECS } from '../../src/traffic/constants';
import type { LightPhase, TrafficLight } from '../../src/traffic/lights';
import type { ManeuverKind } from '../../src/traffic/maneuver';
import { IntersectionReservations } from '../../src/traffic/reservations';
import { refSlot, spawnVehicle, type VehicleTrafficState } from '../../src/traffic/vehicles';
import { LaneGraph } from '../../src/transport/laneGraph';
import { LaneletConflictMatrices } from '../../src/transport/lanelet/build';
import { ConflictMatrix } from '../../src/transport/lanelet/conflict';
import { LaneletGraph, type Lanelet } from '../../src/transport/lanelet/graph';
import { createWorld } from '../../src/world';
import { setRoad } from '../transport/helpers';

const t = (x: number, y: number): TilePos => ({ x, y });

function matrices(paths: TilePos[][]): LaneletConflictMatrices {
  const m = new LaneletConflictMatrices();
  m.byIntersection.set(0, ConflictMatrix.fromPaths(paths));
  m.version = 1;
  return m;
}

function cand(vehicle: number, localIdx: number, priority: number, extra: Partial<ArbiterGrantCandidate> = {}): ArbiterGrantCandidate {
  return {
    vehicle,
    seq: 0,
    localIdx,
    coarse: false,
    priority,
    distToEntry: 0.5,
    ready: true,
    isRightOnRed: false,
    entryDir: 'East',
    maneuver: 'Straight',
    ...extra,
  };
}

const byId = (cands: ArbiterGrantCandidate[]) => new Map([[0, cands]]);

function lanelet(id: number, intersection: number, entryLane: number, exitLane: number, maneuver: ManeuverKind, path: TilePos[]): Lanelet {
  return { id, intersection, entryLane, exitLane, maneuver, internalPath: path };
}

describe('lanelet arbiter core', () => {
  it('orderedIdsStrictlyAscendingById', () => {
    const llg = new LaneletGraph();
    llg.byIntersection.set(2, []);
    llg.byIntersection.set(0, []);
    llg.byIntersection.set(1, []);
    expect(orderedIntersectionIds(llg)).toEqual([0, 1, 2]);
  });

  it('arbiterAdmitsNonconflictingSerializesConflicting', () => {
    const m = matrices([[t(0, 0), t(1, 0)], [t(1, 0), t(1, 1)], [t(5, 5)]]);
    const res = new IntersectionReservations();
    arbitrateGrantsInner(0, [0], byId([cand(1, 0, 3), cand(3, 2, 3)]), m, [], res);
    expect(res.isReservedBy(0, 1)).toBe(true);
    expect(res.isReservedBy(0, 3)).toBe(true);

    const res2 = new IntersectionReservations();
    arbitrateGrantsInner(0, [0], byId([cand(10, 0, 3), cand(11, 1, 1)]), m, [], res2);
    expect([10, 11].filter((x) => res2.isReservedBy(0, x)).length, 'conflicting candidates must serialize to one').toBe(1);
    expect(res2.isReservedBy(0, 10), 'higher-priority candidate wins').toBe(true);

    const res3 = new IntersectionReservations();
    arbitrateGrantsInner(0, [0], new Map(), m, [{ vehicle: 20, seq: 0, intersection: 0 }], res3);
    expect(res3.isReservedBy(0, 20), 'in-box vehicle gets a safety-net reservation').toBe(true);
  });

  it('priorityWidthDominatesAgingCrossesManeuver', () => {
    expect(candidatePriority(6, 'LeftTurn', 0)).toBeGreaterThan(candidatePriority(4, 'Straight', 0));
    expect(candidatePriority(4, 'LeftTurn', AGING_CAP)).toBeLessThan(candidatePriority(6, 'Straight', 0));
    expect(candidatePriority(2, 'Straight', AGING_CAP)).toBeLessThan(candidatePriority(4, 'Straight', 0));
    const cross = 2 * MANEUVER_STEP;
    expect(candidatePriority(4, 'Straight', 0)).toBeGreaterThan(candidatePriority(4, 'LeftTurn', cross - 1));
    expect(candidatePriority(4, 'LeftTurn', cross)).toBe(candidatePriority(4, 'Straight', 0));
    expect(candidatePriority(4, 'LeftTurn', cross + 1)).toBeGreaterThan(candidatePriority(4, 'Straight', 0));
    expect(cross).toBe(32);
    expect(candidatePriority(4, 'Straight', 5)).toBeGreaterThan(candidatePriority(4, 'Straight', 0));
  });

  it('fourWayAllConflictingGrantsExactlyOne', () => {
    const c = t(0, 0);
    const m = matrices([[c], [c], [c], [c]]);
    const cands = [0, 1, 2, 3].map((i) => cand(i + 1, i, candidatePriority(4, 'Straight', 0)));
    const counts = arbitrateGrantsInner(0, [0], byId(cands), m, [], new IntersectionReservations());
    expect(counts.admitted).toBe(1);
  });

  it('coarseFallbackAdmitsWholeBoxWhenClearAndIsExclusive', () => {
    const m = matrices([[t(0, 0)], [t(5, 5)]]);
    const res = new IntersectionReservations();
    const c = arbitrateGrantsInner(0, [0], byId([cand(1, 0, 3, { coarse: true })]), m, [], res);
    expect(c.admitted, 'coarse admitted into a clear box').toBe(1);
    expect(res.isReservedBy(0, 1)).toBe(true);

    const res2 = new IntersectionReservations();
    const cc = arbitrateGrantsInner(0, [0], byId([cand(1, 0, 3, { coarse: true }), cand(2, 1, 3)]), m, [], res2);
    expect(cc.admitted).toBe(1);
    expect([1, 2].filter((x) => res2.isReservedBy(0, x)).length).toBe(1);

    const c3 = arbitrateGrantsInner(0, [0], byId([cand(10, 0, 3, { coarse: true }), cand(11, 0, 3, { coarse: true })]), m, [], new IntersectionReservations());
    expect(c3.admitted, 'two coarse candidates serialize to one').toBe(1);
  });

  it('dirPrecedenceIsPostDistanceTiebreak', () => {
    const m = matrices([[t(0, 0)], [t(0, 0)]]);
    const p = candidatePriority(4, 'Straight', 0);
    const res = new IntersectionReservations();
    arbitrateGrantsInner(0, [0], byId([cand(2, 1, p, { entryDir: 'South' }), cand(1, 0, p, { entryDir: 'North' })]), m, [], res);
    expect(res.isReservedBy(0, 1), 'North wins the post-distance tiebreak').toBe(true);
    expect(res.isReservedBy(0, 2)).toBe(false);
  });

  it('rightHandRuleNorthYieldsToWestOnEqualTie', () => {
    const m = matrices([[t(0, 0)], [t(0, 0)]]);
    const p = candidatePriority(4, 'Straight', 0);
    const res = new IntersectionReservations();
    arbitrateGrantsInner(0, [0], byId([cand(1, 0, p, { entryDir: 'North' }), cand(2, 1, p, { entryDir: 'West' })]), m, [], res);
    expect(res.isReservedBy(0, 2), 'West approaches from North\'s right and wins').toBe(true);
    expect(res.isReservedBy(0, 1)).toBe(false);
  });

  it('readinessSignalizedGreenRedRtorAllred', () => {
    const light = (phase: LightPhase): TrafficLight => ({
      intersectionId: 0,
      intersectionKey: 'k',
      pos: t(0, 0),
      phase,
      phaseTimer: 0,
      greenDuration: 10,
      yellowDuration: 3,
      allRedDuration: 4,
    });
    const stop = t(5, 5);
    const free: VehicleTrafficState = { kind: 'FreeFlow' };
    const stopped: VehicleTrafficState = { kind: 'Stopped', intersection: 'k', stopTile: stop, queuePosition: 0 };
    const ready = (
      signalized: boolean,
      l: TrafficLight | undefined,
      entry: RoadDir,
      exit: RoadDir,
      maneuver: ManeuverKind,
      state: VehicleTrafficState,
      rtor = true,
    ) => laneletReadiness(signalized, l, entry, exit, maneuver, state, stop, true, rtor);

    expect(ready(false, undefined, 'North', 'North', 'Straight', free).ready).toBe(true);
    let r = ready(true, light('NorthSouthGreen'), 'North', 'North', 'Straight', free);
    expect(r.ready && !r.isRightOnRed).toBe(true);
    expect(ready(true, light('EastWestGreen'), 'North', 'North', 'Straight', free).ready).toBe(false);
    expect(ready(true, light('AllRedToEastWest'), 'North', 'North', 'Straight', stopped).ready).toBe(false);
    const near = dirRight('North');
    r = ready(true, light('EastWestGreen'), 'North', near, 'RightTurn', stopped);
    expect(r.ready && r.isRightOnRed).toBe(true);
    expect(ready(true, light('EastWestGreen'), 'North', 'North', 'Straight', stopped).ready).toBe(false);
    r = ready(true, light('NorthSouthLeftProtected'), 'North', dirLeft('North'), 'LeftTurn', free);
    expect(r.ready && !r.isRightOnRed, 'protected left is ready').toBe(true);
    expect(ready(true, light('NorthSouthLeftProtected'), 'North', 'North', 'Straight', free).ready).toBe(false);
    r = ready(true, light('EastWestGreen'), 'North', near, 'RightTurn', stopped, false);
    expect(!r.ready && !r.isRightOnRed, 'right turn on red is refused under the ПДД РФ default').toBe(true);
  });

  it('pedActivationBlocksCrossingAxis', () => {
    const m = new LaneletConflictMatrices();
    m.version = 1;
    m.byIntersection.set(
      0,
      ConflictMatrix.fromPathsWithCrosswalks([[t(0, 0), t(1, 0)], [t(0, 2), t(1, 2)]], [[t(1, 0)], [t(1, 2)]]),
    );
    m.crosswalkSides.set(0, ['West', 'North']);
    const res = new IntersectionReservations();
    seedPedMasks([0], [[0, true]], m, res);
    const matrix = m.byIntersection.get(0)!;
    const ledger = res.ledgerMut(0);
    expect(ledger.tryAdmit(1, 0, matrix.row(0)), 'lanelet crossing the active West crosswalk is blocked').toBe(false);
    expect(ledger.tryAdmit(2, 1, matrix.row(1)), 'lanelet crossing the inactive North crosswalk admits').toBe(true);
  });

  it('clusterOpenExitTrueWithAdjacentRoadFalseWhenEnclosed', () => {
    const center = t(2, 2);
    const cluster: IntersectionCluster = {
      id: 0,
      key: { aabbMin: center, aabbMax: center, tileCount: 1, tilesHash: 0n },
      tiles: [center],
      aabbMin: center,
      aabbMax: center,
      centroidTile: center,
    };
    const index = new IntersectionIndex();
    index.clusters = [cluster];
    index.version = 1;
    index.tileToIntersection.set(tileKey(center), 0);

    expect(clusterHasOpenExit(cluster, new MapGrid(5, 5), index)).toBe(false);
    const open = new MapGrid(5, 5);
    setRoad(open, t(1, 2), { kind: 'TwoLane', dir: 'East' });
    expect(clusterHasOpenExit(cluster, open, index)).toBe(true);
  });

  it('mandatoryMergeNudgeBumpsStuckTimerOverThreshold', () => {
    const w = createWorld({ mapWidth: 4, mapHeight: 4 });
    const over = spawnVehicle(w, { route: [t(0, 0)] });
    const under = spawnVehicle(w, { route: [t(0, 0)] });
    for (const ref of [over, under]) w.vehicles.hasStuckTimer[refSlot(w.vehicles, ref)] = 1;
    w.laneletStallTracker.set(over, LANELET_STALL_REROUTE_TICKS);
    w.laneletStallTracker.set(under, 1);
    nudgeLaneletStallReroute(w);
    expect(w.vehicles.stuckSecs[refSlot(w.vehicles, over)]).toBeGreaterThanOrEqual(STUCK_REROUTE_SECS);
    expect(w.vehicles.stuckSecs[refSlot(w.vehicles, under)]).toBe(0);
  });

  it('preciseFallbackResolvesLaneletFromGeometry', () => {
    const llg = new LaneletGraph();
    llg.lanelets.push(lanelet(0, 0, 5, 9, 'Straight', [t(1, 1)]), lanelet(1, 0, 5, 8, 'RightTurn', [t(2, 1)]));
    llg.byEntryLane.set(5, [0, 1]);
    llg.byIntersection.set(0, [0, 1]);
    const lanes = new LaneGraph();
    lanes.posToId.set(tileKey(t(0, 1)), 5);
    lanes.posToId.set(tileKey(t(9, 1)), 9);
    lanes.posToId.set(tileKey(t(9, 2)), 8);
    const approach = t(0, 1);
    expect(resolveLaneletFallback(llg, lanes, 0, approach, t(9, 1), 'Straight')).toBe(0);
    expect(resolveLaneletFallback(llg, lanes, 0, approach, t(9, 2), 'RightTurn')).toBe(1);
    expect(resolveLaneletFallback(llg, lanes, 0, approach, t(99, 99), 'RightTurn')).toBe(1);
    expect(resolveLaneletFallback(llg, lanes, 7, approach, t(9, 1), 'Straight')).toBeUndefined();
    expect(resolveLaneletFallback(llg, lanes, 0, approach, t(99, 99), 'LeftTurn')).toBeUndefined();
  });

  it('maneuverRetryResolvesTurnOnExitLaneMismatch', () => {
    const llg = new LaneletGraph();
    llg.lanelets.push(lanelet(0, 0, 5, 9, 'Straight', [t(1, 1)]), lanelet(1, 0, 5, 8, 'LeftTurn', [t(2, 1)]));
    llg.byEntryLane.set(5, [0, 1]);
    llg.byIntersection.set(0, [0, 1]);
    const lanes = new LaneGraph();
    lanes.posToId.set(tileKey(t(0, 1)), 5);
    lanes.posToId.set(tileKey(t(9, 3)), 7);
    expect(llg.laneletsFrom(5).some((lid) => llg.get(lid)?.exitLane === 7), 'no lanelet has exit lane 7').toBe(false);
    expect(resolveLaneletFallback(llg, lanes, 0, t(0, 1), t(9, 3), 'LeftTurn')).toBe(1);

    llg.lanelets.push(lanelet(2, 0, 5, 6, 'LeftTurn', [t(3, 1)]));
    llg.byEntryLane.set(5, [0, 1, 2]);
    llg.byIntersection.set(0, [0, 1, 2]);
    expect(resolveLaneletFallback(llg, lanes, 0, t(0, 1), t(9, 3), 'LeftTurn'), 'ambiguous -> never mis-resolve').toBeUndefined();
  });

  it('pedSeedingIsCrossingOrderIndependent', () => {
    const m = new LaneletConflictMatrices();
    m.version = 1;
    m.byIntersection.set(
      0,
      ConflictMatrix.fromPathsWithCrosswalks([[t(0, 0), t(1, 0)], [t(0, 2), t(1, 2)]], [[t(1, 0)], [t(1, 2)]]),
    );
    m.crosswalkSides.set(0, ['West', 'North']);
    const blockResult = (crossings: ReadonlyArray<readonly [number, boolean]>) => {
      const res = new IntersectionReservations();
      const n = seedPedMasks([0], crossings, m, res);
      const matrix = m.byIntersection.get(0)!;
      const ledger = res.ledgerMut(0);
      return [n, !ledger.tryAdmit(1, 0, matrix.row(0)), !ledger.tryAdmit(2, 1, matrix.row(1))];
    };
    const a = blockResult([
      [0, true],
      [0, false],
    ]);
    expect(a).toEqual(
      blockResult([
        [0, false],
        [0, true],
      ]),
    );
    expect(a).toEqual([2, true, true]);
  });

  it('arbiterBreaksTiesByVehicleSeqNotEntityId', () => {
    const m = matrices([[t(0, 0), t(1, 0)], [t(1, 0), t(1, 1)], [t(5, 5)]]);
    for (const [seqOne, seqTwo, winner, loser] of [
      [20, 10, 2, 1],
      [10, 20, 1, 2],
    ] as const) {
      const res = new IntersectionReservations();
      arbitrateGrantsInner(0, [0], byId([cand(1, 0, 3, { seq: seqOne }), cand(2, 1, 3, { seq: seqTwo })]), m, [], res);
      expect(res.isReservedBy(0, winner), `seqs ${seqOne}, ${seqTwo}`).toBe(true);
      expect(res.isReservedBy(0, loser), `seqs ${seqOne}, ${seqTwo}`).toBe(false);
    }
    for (const [seqForty, seqFifty] of [
      [30, 5],
      [5, 30],
    ] as const) {
      const inbox: ArbiterInboxVehicle[] = [
        { vehicle: 40, seq: seqForty, intersection: 0 },
        { vehicle: 50, seq: seqFifty, intersection: 0 },
      ];
      const rows = new IntersectionReservations();
      arbitrateGrantsInner(0, [0], new Map(), m, inbox, rows);
      const order = rows.byIntersection.get(0)!.map((r) => r.vehicle);
      expect(order, 'in-box rows follow the vehicles\' sequence').toEqual(seqFifty < seqForty ? [50, 40] : [40, 50]);
    }
  });

  it('arbiterOutputIsInputOrderIndependent', () => {
    const m = matrices([[t(0, 0), t(1, 0)], [t(1, 0), t(1, 1)], [t(5, 5)]]);
    const run = (cands: ArbiterGrantCandidate[], inbox: ArbiterInboxVehicle[]) => {
      const res = new IntersectionReservations();
      const counts = arbitrateGrantsInner(0, [0], byId(cands), m, inbox, res);
      return [(res.byIntersection.get(0) ?? []).map((r) => [r.vehicle, r.state]), counts] as const;
    };
    const a = run([cand(1, 0, 3), cand(2, 1, 3), cand(3, 2, 3)], [
      { vehicle: 50, seq: 0, intersection: 0 },
      { vehicle: 40, seq: 0, intersection: 0 },
    ]);
    const b = run([cand(3, 2, 3), cand(2, 1, 3), cand(1, 0, 3)], [
      { vehicle: 40, seq: 0, intersection: 0 },
      { vehicle: 50, seq: 0, intersection: 0 },
    ]);
    expect(a).toEqual(b);
    expect([a[1].admitted, a[1].refused], '2 admitted, 1 refused').toEqual([2, 1]);
  });

  it('starvedTurnCrossesManeuverBoundaryAndIsServedInAFewTicks', () => {
    const m = matrices([[t(0, 0)], [t(0, 0)]]);
    const [through, turn] = [1, 2];
    const throughDir: RoadDir = 'North';
    const turnDir: RoadDir = 'West';
    const waitTicks = new Map<RoadDir, number>();
    let turnServedTick: number | undefined;
    for (let tick = 0; tick < 64; tick++) {
      const throughAging = waitTicks.get(throughDir) ?? 0;
      const turnAging = waitTicks.get(turnDir) ?? 0;
      const res = new IntersectionReservations();
      arbitrateGrantsInner(
        0,
        [0],
        byId([
          cand(through, 0, candidatePriority(4, 'Straight', throughAging), { entryDir: throughDir, maneuver: 'Straight' }),
          cand(turn, 1, candidatePriority(4, 'LeftTurn', turnAging), { entryDir: turnDir, maneuver: 'LeftTurn' }),
        ]),
        m,
        [],
        res,
      );
      const turnWon = res.isReservedBy(0, turn);
      const throughWon = res.isReservedBy(0, through);
      expect(turnWon, `exactly one winner (tick ${tick})`).not.toBe(throughWon);
      if (turnAging < 2 * MANEUVER_STEP) expect(throughWon, `below the cross threshold (tick ${tick})`).toBe(true);
      if (turnWon && turnServedTick === undefined) turnServedTick = tick;
      for (const [dir, won] of [
        [throughDir, throughWon],
        [turnDir, turnWon],
      ] as const) {
        waitTicks.set(dir, won ? 0 : Math.min((waitTicks.get(dir) ?? 0) + 1, 0xffff));
      }
    }
    expect(turnServedTick).toBeDefined();
    expect(turnServedTick!).toBeGreaterThanOrEqual(32);
    expect(turnServedTick!).toBeLessThanOrEqual(40);
  });

  it('cacheLocalIdxMatchesRowOrderAndRebuildsOnVersion', () => {
    const llg = new LaneletGraph();
    llg.lanelets.push(lanelet(0, 0, 0, 100, 'Straight', [t(1, 1)]), lanelet(1, 0, 1, 101, 'Straight', [t(2, 2)]));
    llg.byIntersection.set(0, [0, 1]);
    llg.version = 1;
    const cache = new ArbiterIndexCache();
    cache.ensureBuiltFor(1, llg);
    expect(cache.version).toBe(1);
    expect(cache.localIdx.get(0)!.get(0)).toBe(0);
    expect(cache.localIdx.get(0)!.get(1)).toBe(1);

    llg.byIntersection.set(0, [1, 0]);
    cache.ensureBuiltFor(1, llg);
    expect(cache.localIdx.get(0)!.get(0), 'no rebuild at the same version').toBe(0);

    llg.version = 2;
    cache.ensureBuiltFor(2, llg);
    expect(cache.version).toBe(2);
    expect(cache.localIdx.get(0)!.get(1)).toBe(0);
    expect(cache.localIdx.get(0)!.get(0)).toBe(1);
  });
});
