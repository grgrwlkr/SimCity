// Port of crates/simcity_sim/src/game/traffic/tests/lanelet_arbiter.rs: the arbiter system on real
// cross intersections (2x2 and 4x4 boxes), alone and chained with movement through the entry gate.
import { describe, expect, it } from 'vitest';
import type { LaneType, RoadDir, RoadKind, TilePos } from '../../src/commands';
import { capacityPerLaneTile } from '../../src/map/roads';
import { arbitrateLaneletReservations } from '../../src/traffic/arbiter';
import { STOP_LINE_OFFSET, TILE_CENTER_TO_EDGE_TILES } from '../../src/traffic/constants';
import { moveVehicles } from '../../src/traffic/drive';
import { cleanupIntersectionReservations } from '../../src/traffic/reservations';
import { buildTrafficSpatialIndex } from '../../src/traffic/spatialIndex';
import { refSlot, resolveVehicle, type VehicleTrafficState } from '../../src/traffic/vehicles';
import { buildLaneGraph } from '../../src/transport/laneGraph';
import { buildLaneletGraph } from '../../src/transport/lanelet/build';
import { createWorld, type World } from '../../src/world';
import { setRoad } from '../transport/helpers';
import { DT, detect, placeLight, t, vehicle } from './helpers';

type Lane = readonly [TilePos, RoadKind, RoadDir, number];

/** 9x9, a 2x2 cluster at (4..5, 4..5); one lane per direction. */
function crossGridLanes(): Lane[] {
  const lanes: Lane[] = [];
  for (const pos of [t(4, 4), t(4, 5), t(5, 4), t(5, 5)]) lanes.push([pos, 'TwoLane', 'None', 0]);
  for (const x of [0, 1, 2, 3, 6, 7, 8]) {
    lanes.push([t(x, 4), 'TwoLane', 'East', 0], [t(x, 5), 'TwoLane', 'West', 0]);
  }
  for (const y of [0, 1, 2, 3, 6, 7, 8]) {
    lanes.push([t(4, y), 'TwoLane', 'North', 0], [t(5, y), 'TwoLane', 'South', 0]);
  }
  return lanes;
}

/** 12x12, a 4x4 cluster at (4..7, 4..7); two FourLane roads with the real lane paint. */
function crossGrid4x4Lanes(): Lane[] {
  const lanes: Lane[] = [];
  for (let x = 4; x <= 7; x++) for (let y = 4; y <= 7; y++) lanes.push([t(x, y), 'FourLane', 'None', 0]);
  for (const x of [0, 1, 2, 3, 8, 9, 10, 11]) {
    lanes.push(
      [t(x, 4), 'FourLane', 'East', 0],
      [t(x, 5), 'FourLane', 'East', 1],
      [t(x, 6), 'FourLane', 'West', 2],
      [t(x, 7), 'FourLane', 'West', 3],
    );
  }
  for (const y of [0, 1, 2, 3, 8, 9, 10, 11]) {
    lanes.push(
      [t(6, y), 'FourLane', 'North', 1],
      [t(7, y), 'FourLane', 'North', 0],
      [t(4, y), 'FourLane', 'South', 3],
      [t(5, y), 'FourLane', 'South', 2],
    );
  }
  return lanes;
}

function world(size: number, lanes: Lane[], laneTypes: ReadonlyArray<readonly [TilePos, LaneType]> = []): World {
  const w = createWorld({ mapWidth: size, mapHeight: size });
  w.appState = 'InGame';
  for (const [pos, kind, dir, lane] of lanes) setRoad(w.grid, pos, { kind, dir, lane });
  for (const [pos, laneType] of laneTypes) {
    const cell = w.grid.get(pos)!;
    w.grid.set(pos, { ...cell, road: { ...cell.road, laneType } });
  }
  detect(w);
  buildLaneGraph(w);
  return w;
}

const crossWorld = (laneTypes: ReadonlyArray<readonly [TilePos, LaneType]> = []) => world(9, crossGridLanes(), laneTypes);
const crossWorld4x4 = () => world(12, crossGrid4x4Lanes());

/** build → arbitrate → cleanup, as the arbiter-only Rust apps chain them (time does not advance). */
function arbiterTick(w: World): void {
  buildLaneletGraph(w);
  arbitrateLaneletReservations(w);
  cleanupIntersectionReservations(w);
}

/** build → arbitrate → spatial index → move → cleanup, one advanced fixed step. */
function fullChainTick(w: World): void {
  buildLaneletGraph(w);
  arbitrateLaneletReservations(w);
  buildTrafficSpatialIndex(w);
  moveVehicles(w, DT);
  cleanupIntersectionReservations(w);
  w.tick += 1;
}

/** spatial index → move only (the Rust move app has no arbiter), one advanced fixed step. */
function moveTick(w: World): void {
  buildTrafficSpatialIndex(w);
  moveVehicles(w, DT);
  w.tick += 1;
}

const spawn = (w: World, route: TilePos[], progress = 0.4, speed = 0, state?: VehicleTrafficState) =>
  vehicle(w, route, 0, progress, speed, 60, 20, 1, state === undefined ? {} : { state });

const EAST = [t(3, 4), t(4, 4), t(5, 4), t(6, 4)];
const NORTH = [t(4, 3), t(4, 4), t(4, 5), t(4, 6)];
const NORTH_LEFT = [t(4, 3), t(4, 4), t(4, 5), t(3, 5)];
const EAST_4X4 = [t(3, 4), t(4, 4), t(7, 4), t(8, 4)];
const SOUTH_4X4 = [t(4, 8), t(4, 7), t(4, 4), t(4, 3)];

const reserved = (w: World, ref: number) => w.reservations.isReservedBy(0, ref);

function isInsideBox(w: World, ref: number): boolean {
  const slot = resolveVehicle(w.vehicles, ref);
  if (slot === undefined) return false;
  const tile = w.pathPool.getTile(w.vehicles.pathHandle[slot]!, w.vehicles.pathCursor[slot]!);
  return tile !== undefined && w.intersections.intersectionIdAt(tile) !== undefined;
}

function setCursor(w: World, ref: number, cursor: number): void {
  const slot = refSlot(w.vehicles, ref);
  w.vehicles.pathCursor[slot] = cursor;
  w.vehicles.progress[slot] = 0.4;
}

function arbiterApp(): [World, number, number] {
  const w = crossWorld();
  return [w, spawn(w, EAST), spawn(w, NORTH)];
}

function runArbiterOnce(): [boolean, boolean] {
  const [w, east, north] = arbiterApp();
  arbiterTick(w);
  return [reserved(w, east), reserved(w, north)];
}

function signalizedEwGreen(w: World): void {
  placeLight(w, t(4, 4), 'EastWestGreen', 10, 1);
}

function spawnNorthRightStopped(w: World): number {
  const key = w.intersections.clusterKeyAt(t(4, 4))!;
  return spawn(w, [t(4, 3), t(4, 4), t(5, 4), t(6, 4)], 0.4, 0, {
    kind: 'Stopped',
    intersection: key,
    stopTile: t(4, 3),
    queuePosition: 0,
  });
}

const spawnAtStopLine = (w: World, route: TilePos[]) => spawn(w, route, Math.fround(TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET), 8);

function injectCoarseReservation(w: World, ref: number): void {
  const rows = w.reservations.byIntersection.get(0) ?? [];
  rows.push({ vehicle: ref, state: 'Approaching', createdAtSec: 0, maneuver: 'Straight', localIdx: null, coarse: true });
  w.reservations.byIntersection.set(0, rows);
}

function position(w: World, ref: number): number | undefined {
  const slot = resolveVehicle(w.vehicles, ref);
  return slot === undefined ? undefined : w.vehicles.pathCursor[slot]! + w.vehicles.progress[slot]!;
}

describe('lanelet arbiter system', () => {
  it('flagOnArbiterDrainsConflictingVehiclesOverTicks', () => {
    const [w, east, north] = arbiterApp();
    arbiterTick(w);
    expect(reserved(w, north)).toBe(true);
    expect(reserved(w, east)).toBe(false);
    setCursor(w, north, 1);
    arbiterTick(w);
    setCursor(w, north, 3);
    arbiterTick(w);
    arbiterTick(w);
    expect(reserved(w, east), 'after North drains, East is admitted').toBe(true);
  });

  it('arbiterCountsOneStraightAdmit', () => {
    const [w] = arbiterApp();
    arbiterTick(w);
    expect(w.arbiterStats.admittedStraight).toBe(1);
    expect(w.arbiterStats.admitted).toBe(1);
    expect(w.arbiterStats.coarseAdmits).toBe(0);
  });

  it('leftTurnResolvesAsLaneletNotCoarse', () => {
    const w = crossWorld();
    const ref = spawn(w, NORTH_LEFT);
    arbiterTick(w);
    expect(reserved(w, ref)).toBe(true);
    expect(w.arbiterStats.admittedLeft).toBeGreaterThanOrEqual(1);
    expect(w.arbiterStats.coarseAdmits).toBe(0);
  });

  it('uturnResolvesAsLaneletNotCoarse', () => {
    const w = crossWorld();
    const ref = spawn(w, [t(4, 3), t(4, 4), t(5, 4), t(5, 3)]);
    arbiterTick(w);
    expect(reserved(w, ref)).toBe(true);
    expect(w.arbiterStats.admittedUturn).toBeGreaterThanOrEqual(1);
    expect(w.arbiterStats.coarseAdmits).toBe(0);
  });

  it('staleSidecarPlanIsIgnoredInFavorOfGeometryFallback', () => {
    const w = crossWorld();
    arbiterTick(w);
    const leftId = w.laneletGraph.ofIntersection(0).find((lid) => w.laneletGraph.get(lid)?.maneuver === 'LeftTurn');
    expect(leftId, 'intersection 0 must have a left-turn lanelet').toBeDefined();
    const version = w.laneletGraph.version;

    const stale = spawn(w, NORTH);
    w.vehicles.laneletPlan[refSlot(w.vehicles, stale)] = { entries: [[1, 0, leftId!]], builtFor: version + 5 };
    arbiterTick(w);
    const stats = w.arbiterStats;
    expect(stats.admittedStraight, 'the stale plan is ignored: geometry admits straight').toBeGreaterThanOrEqual(1);
    expect(stats.admittedLeft).toBe(0);
    expect(stats.coarseAdmits).toBe(0);
    expect(stats.dropStaleLanelet).toBe(0);
    expect(stats.dropOtherCollection).toBe(0);
    expect(reserved(w, stale)).toBe(true);

    const fresh = spawn(w, EAST);
    w.vehicles.laneletPlan[refSlot(w.vehicles, fresh)] = { entries: [[1, 0, leftId!]], builtFor: version };
    arbiterTick(w);
    expect(w.arbiterStats.admittedLeft, 'a current-version sidecar is honored').toBeGreaterThanOrEqual(1);
  });

  it('signalizedSetWithoutLightEntityAdmitsUnsignalized', () => {
    const w = crossWorld();
    const ref = spawn(w, NORTH);
    w.intersections.trafficLights.add(0);
    arbiterTick(w);
    expect(reserved(w, ref)).toBe(true);
    expect(w.arbiterStats.admittedStraight).toBeGreaterThanOrEqual(1);
    expect(w.arbiterStats.missingLightTreatedUnsignalized).toBeGreaterThanOrEqual(1);
  });

  it('unresolvedTurnIsCoarseAdmittedIntoAnEmptyBox', () => {
    const w = crossWorld([[t(4, 3), 'StraightOnly']]);
    const ref = spawn(w, NORTH_LEFT);
    arbiterTick(w);
    expect(reserved(w, ref)).toBe(true);
    expect(w.arbiterStats.coarseAdmits).toBe(1);
    expect(w.laneletStallTracker.has(ref), 'the unresolved turn is still handed to the stall tracker').toBe(true);
  });

  it('turningVehicleYieldsToPedestrianOnExitCrosswalk', () => {
    const w = crossWorld();
    const ref = spawn(w, NORTH_LEFT);
    w.pedestrianCrossings.push({ intersectionId: 0, axisNs: true });
    arbiterTick(w);
    expect(reserved(w, ref)).toBe(false);
    expect(w.arbiterStats.refusedMatrix + w.arbiterStats.yieldRefusals).toBeGreaterThanOrEqual(1);
  });

  it('sameThroughStreamAdmitsBothVehiclesConcurrently', () => {
    const w = crossWorld();
    const e1 = spawn(w, EAST);
    const e2 = spawn(w, EAST);
    arbiterTick(w);
    expect(reserved(w, e1) && reserved(w, e2)).toBe(true);
  });

  it('crossingLeftYieldsToPerpendicularStraight', () => {
    const w = crossWorld();
    const straight = spawn(w, EAST);
    const left = spawn(w, NORTH_LEFT);
    arbiterTick(w);
    expect(reserved(w, straight) && reserved(w, left)).toBe(false);
    expect(reserved(w, straight)).toBe(true);
  });

  it('twoOppositeStraightsBothAdmitted', () => {
    const w = crossWorld();
    const east = spawn(w, EAST);
    const west = spawn(w, [t(6, 5), t(5, 5), t(4, 5), t(3, 5)]);
    arbiterTick(w);
    expect(reserved(w, east) && reserved(w, west)).toBe(true);
  });

  it('twoCrossingLeftTurnsNotDoubleAdmitted', () => {
    const w = crossWorld();
    const a = spawn(w, NORTH_LEFT);
    const b = spawn(w, [t(3, 4), t(4, 4), t(4, 5), t(4, 6)]);
    arbiterTick(w);
    expect(Number(reserved(w, a)) + Number(reserved(w, b))).toBe(1);
  });

  it('approachingVehicleHoldsExactlyOneReservationAcrossTicks', () => {
    const w = crossWorld();
    const ref = spawn(w, EAST);
    arbiterTick(w);
    arbiterTick(w);
    arbiterTick(w);
    expect((w.reservations.byIntersection.get(0) ?? []).filter((r) => r.vehicle === ref).length).toBe(1);
  });

  it('fullExitTileNoLongerRefusesAdmission', () => {
    const w = crossWorld();
    w.trafficOccupancy.ensureLen(81);
    w.trafficOccupancy.perTickVehicles[w.grid.idx(t(6, 4))!] = capacityPerLaneTile('TwoLane');
    const ref = spawn(w, EAST);
    arbiterTick(w);
    expect(reserved(w, ref)).toBe(true);
  });

  it('freeExitTileAllowsAdmission', () => {
    const w = crossWorld();
    w.trafficOccupancy.ensureLen(81);
    const ref = spawn(w, EAST);
    arbiterTick(w);
    expect(reserved(w, ref)).toBe(true);
  });

  it('rtorBlockedByConflictingPedestrianThenAdmittedWhenClear', () => {
    const w = crossWorld();
    signalizedEwGreen(w);
    w.trafficConfig.rightTurnOnRed = true;
    const ego = spawnNorthRightStopped(w);
    w.pedestrianCrossings.push({ intersectionId: 0, axisNs: true });
    arbiterTick(w);
    expect(reserved(w, ego), 'blocked while a pedestrian crosses the conflicting axis').toBe(false);
    w.pedestrianCrossings.length = 0;
    arbiterTick(w);
    expect(reserved(w, ego), 'admitted once the pedestrian clears').toBe(true);
  });

  it('rtorRefusedWhileIntersectionNotClear', () => {
    const w = crossWorld();
    signalizedEwGreen(w);
    const ego = spawnNorthRightStopped(w);
    const through = spawn(w, EAST);
    arbiterTick(w);
    expect(reserved(w, through)).toBe(true);
    expect(reserved(w, ego)).toBe(false);
  });

  it('leftTurnYieldsToPedestrianOnEitherAxis', () => {
    for (const axisNs of [true, false]) {
      const w = crossWorld();
      const ego = spawn(w, NORTH_LEFT);
      w.pedestrianCrossings.push({ intersectionId: 0, axisNs });
      arbiterTick(w);
      expect(reserved(w, ego), `axisNs=${axisNs}`).toBe(false);
    }
  });

  it('twoNonConflictingRightTurnsBothAdmitted', () => {
    const w = crossWorld();
    const a = spawn(w, [t(4, 3), t(4, 4), t(5, 4), t(6, 4)]);
    const b = spawn(w, [t(6, 5), t(5, 5), t(4, 5), t(4, 6)]);
    arbiterTick(w);
    expect(reserved(w, a) && reserved(w, b)).toBe(true);
  });

  it('fourLane4x4TwoDisjointStraightsBothAdmittedSameTick', () => {
    const w = crossWorld4x4();
    const east = spawn(w, EAST_4X4);
    const west = spawn(w, [t(8, 7), t(7, 7), t(4, 7), t(3, 7)]);
    arbiterTick(w);
    expect(reserved(w, east)).toBe(true);
    expect(reserved(w, west)).toBe(true);
  });

  it('fourLane4x4StraightPlusDisjointRightTurnBothAdmitted', () => {
    const w = crossWorld4x4();
    const straight = spawn(w, EAST_4X4);
    const right = spawn(w, [t(8, 7), t(7, 7), t(7, 8)]);
    arbiterTick(w);
    expect(reserved(w, straight)).toBe(true);
    expect(reserved(w, right)).toBe(true);
  });

  it('fourLane4x4ConflictingMovementsNotDoubleAdmitted', () => {
    const w = crossWorld4x4();
    const east = spawn(w, EAST_4X4);
    const south = spawn(w, SOUTH_4X4);
    arbiterTick(w);
    expect(Number(reserved(w, east)) + Number(reserved(w, south))).toBe(1);
  });

  it('flagOnArbiterAdmitsExactlyOneConflictingVehicleDeterministically', () => {
    const a = runArbiterOnce();
    expect(a[0] && a[1]).toBe(false);
    expect(a[0] || a[1]).toBe(true);
    expect(runArbiterOnce()).toEqual(a);
  });

  it('conflictingVehiclesNeverShareABoxTile', () => {
    // The ledger holds tiles: two crossing cars may both be in the box, never on or holding one tile.
    const w = crossWorld4x4();
    const east = spawnAtStopLine(w, EAST_4X4);
    const south = spawnAtStopLine(w, SOUTH_4X4);
    const tileOf = (ref: number) => {
      const slot = resolveVehicle(w.vehicles, ref);
      return slot === undefined ? undefined : w.pathPool.getTile(w.vehicles.pathHandle[slot]!, w.vehicles.pathCursor[slot]!);
    };
    let eastGranted = false;
    let southGranted = false;
    let anyInside = false;
    for (let tick = 0; tick < 80; tick++) {
      fullChainTick(w);
      const eastIn = isInsideBox(w, east);
      const southIn = isInsideBox(w, south);
      anyInside ||= eastIn || southIn;
      const [a, b] = [tileOf(east), tileOf(south)];
      expect(eastIn && southIn && a!.x === b!.x && a!.y === b!.y, `tick ${tick}: both on one box tile`).toBe(false);
      eastGranted ||= reserved(w, east);
      southGranted ||= reserved(w, south);
      const ledger = w.reservations.ledger(0);
      if (ledger !== undefined) {
        const southTiles = new Set(ledger.heldTiles(south));
        expect(ledger.heldTiles(east).filter((tile) => southTiles.has(tile)), `tick ${tick}: a tile held by both`).toEqual([]);
      }
    }
    expect(anyInside).toBe(true);
    expect(eastGranted && southGranted).toBe(true);
  });

  it('grantedApproachingDoesNotPreLockConflictingCandidate', () => {
    const [w, east, north] = arbiterApp();
    let eastSeen = false;
    let northSeen = false;
    for (let i = 0; i < 6; i++) {
      arbiterTick(w);
      eastSeen ||= reserved(w, east);
      northSeen ||= reserved(w, north);
      const ledger = w.reservations.ledger(0);
      if (ledger !== undefined) expect(ledger.holderCount()).toBe(0);
    }
    expect(eastSeen && northSeen).toBe(true);
  });

  it('deadlockFlowFullExitNoLongerBlocksBoxEntry', () => {
    const w = crossWorld4x4();
    const exitIdx = w.grid.idx(t(8, 4))!;
    const cap = capacityPerLaneTile('FourLane');
    const cand = spawn(w, EAST_4X4);
    injectCoarseReservation(w, cand);
    spawn(w, [t(8, 4)], 0.9);
    w.trafficOccupancy.ensureLen(144);
    w.trafficOccupancy.perTickVehicles[exitIdx] = cap;

    moveTick(w);
    const slot = refSlot(w.vehicles, cand);
    expect(w.vehicles.pathCursor[slot]! >= 1 || w.vehicles.progress[slot]! > Math.fround(0.4)).toBe(true);

    for (let i = 0; i < 40; i++) {
      w.trafficOccupancy.perTickVehicles[exitIdx] = cap;
      moveTick(w);
      if (resolveVehicle(w.vehicles, cand) === undefined) break;
    }
    const s = resolveVehicle(w.vehicles, cand);
    expect(s === undefined || w.vehicles.pathCursor[s]! >= 3, 'the admitted car flows through the box').toBe(true);
  });

  it('multiCarFullExitCycleProgressesNotDeadlocks', () => {
    const w = crossWorld4x4();
    const exitIdx = w.grid.idx(t(8, 4))!;
    const cap = capacityPerLaneTile('FourLane');
    const cars = [0.4, 0.2, 0].map((p) => {
      const ref = spawn(w, EAST_4X4, p, 8);
      injectCoarseReservation(w, ref);
      return ref;
    });
    const start = cars.map((ref) => position(w, ref)!);
    for (let i = 0; i < 120; i++) {
      w.trafficOccupancy.ensureLen(144);
      w.trafficOccupancy.perTickVehicles[exitIdx] = cap;
      moveTick(w);
    }
    cars.forEach((ref, i) => {
      const pos = position(w, ref);
      expect(pos === undefined || pos > Math.fround(start[i]! + 0.05), `car ${i} flowed forward`).toBe(true);
    });
    const front = resolveVehicle(w.vehicles, cars[0]!);
    expect(front === undefined || w.vehicles.pathCursor[front]! >= 1, 'the leading car entered the box').toBe(true);
  });

  it('uncontrolledLeftTurnNotFrozenByApproachingThroughAtEmptyBox', () => {
    const w = crossWorld4x4();
    const left = spawnAtStopLine(w, [t(5, 8), t(5, 7), t(5, 4), t(6, 4), t(7, 4), t(8, 4)]);
    const through = vehicle(w, [t(8, 6), t(7, 6), t(4, 6), t(3, 6)], 0, 0, 1, 60, 20, 1);
    const leftStart = position(w, left)!;

    const committedIntoBox = (ref: number) => {
      const slot = resolveVehicle(w.vehicles, ref);
      if (slot === undefined) return false;
      const handle = w.vehicles.pathHandle[slot]!;
      const cursor = w.vehicles.pathCursor[slot]!;
      const onBox = (i: number) => {
        const tile = w.pathPool.getTile(handle, i);
        return tile !== undefined && w.intersections.intersectionIdAt(tile) !== undefined;
      };
      return onBox(cursor) || (onBox(cursor + 1) && w.vehicles.progress[slot]! >= TILE_CENTER_TO_EDGE_TILES);
    };

    let leftEverReserved = false;
    let leftEnteredBox = false;
    for (let tick = 0; tick < 60; tick++) {
      fullChainTick(w);
      const leftIn = isInsideBox(w, left);
      const throughIn = isInsideBox(w, through);
      const boxEmpty = !committedIntoBox(left) && !committedIntoBox(through);
      leftEverReserved ||= reserved(w, left);
      expect(leftIn && throughIn, `tick ${tick}: both inside`).toBe(false);
      leftEnteredBox ||= leftIn;
      const ledger = w.reservations.ledger(0);
      if (boxEmpty && ledger !== undefined) expect(ledger.holderCount(), `tick ${tick}: phantom hold on an empty box`).toBe(0);
    }
    const leftEnd = position(w, left) ?? Number.POSITIVE_INFINITY;
    expect(leftEverReserved).toBe(true);
    expect(leftEnteredBox || leftEnd > leftStart + 0.5).toBe(true);
  });

  it('crossingLeftYieldsToOncomingStraight', () => {
    const w = crossWorld();
    const oncoming = spawn(w, [t(5, 6), t(5, 5), t(5, 4), t(5, 3)]);
    const left = spawn(w, NORTH_LEFT);
    arbiterTick(w);
    expect(reserved(w, oncoming) && reserved(w, left)).toBe(false);
    expect(reserved(w, oncoming)).toBe(true);
  });
});
