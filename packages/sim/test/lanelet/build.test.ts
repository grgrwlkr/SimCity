// Ported from crates/simcity_sim/src/game/transport/lanelet/build.rs (mod tests and
// straight_lane_keeping_tests). Boxes are `TileSet`s; clusters come from the flood fill rather than
// hand-built indices (ids and tile sets are the same, tile order does not reach the output).
import { describe, expect, it } from 'vitest';
import type { LaneType, RoadCell, RoadDir, RoadKind, TilePos } from '../../src/commands';
import { MapGrid } from '../../src/map/grid';
import { dirDelta, isLeftmostForDir, isRightmostForDir } from '../../src/map/roads';
import { TileSet, buildInternalPath, crosswalkCells, laneAllowsManeuver } from '../../src/transport/lanelet/build';
import type { ManeuverKind } from '../../src/traffic/maneuver';
import { setRoad } from '../transport/helpers';
import {
  box2x2,
  box3x3,
  box4x4,
  boxRect,
  buildCrossGrid,
  buildLanelets,
  buildTwoLaneCrossGrid,
  enclosesCenter,
  indexFor,
  isFourAdjacent,
  isSimple,
  t,
} from './helpers';

const U32_MAX = 0xffff_ffff;

function expectPathInvariants(cluster: TileSet, path: readonly TilePos[], entry: TilePos, goal: TilePos): void {
  expect(path[0], 'starts at entry').toEqual(entry);
  expect(path[path.length - 1], 'ends at goal').toEqual(goal);
  expect(isFourAdjacent(path), `4-adjacent: ${JSON.stringify(path)}`).toBe(true);
  expect(
    path.every((p) => cluster.has(p)),
    'every tile in box',
  ).toBe(true);
  expect(isSimple(path), `path is simple: ${JSON.stringify(path)}`).toBe(true);
}

const feeder = (exit: TilePos, dir: RoadDir): TilePos => ({ x: exit.x - dirDelta(dir).x, y: exit.y - dirDelta(dir).y });

describe('lanelet internal paths', () => {
  it('centroidRouterLeftTurnArcsAroundCenterNotThroughIt', () => {
    const cluster = box3x3();
    const path = buildInternalPath(cluster, t(5, 5), t(4, 4), 'East', t(4, 7), 'North', 'LeftTurn');
    expect(path, 'left path exists').toBeDefined();
    expect(path![0], 'starts at entry tile').toEqual(t(4, 4));
    expect(isFourAdjacent(path!)).toBe(true);
    expect(path!.every((p) => cluster.has(p))).toBe(true);
    expect(isSimple(path!)).toBe(true);
    expect(path, 'left turn must not cut through the center tile').not.toContainEqual(t(5, 5));
    expect(path).toEqual([t(4, 4), t(4, 5), t(4, 6)]);
  });

  it('centroidRouterStraightIsDirect', () => {
    const path = buildInternalPath(box2x2(), t(4, 4), t(4, 4), 'East', t(6, 4), 'East', 'Straight');
    expect(path, 'straight takes the direct 2-tile in-box path').toEqual([t(4, 4), t(5, 4)]);
  });

  it('internalPathIsStrictly4AdjacentNeverDiagonal', () => {
    const cluster = boxRect(31, 34, 61, 66);
    const entry = t(34, 64);
    const path = buildInternalPath(cluster, t(31, 61), entry, 'West', t(30, 64), 'West', 'Straight');
    expect(path).toBeDefined();
    expect(path!.length).toBeGreaterThanOrEqual(2);
    expect(isFourAdjacent(path!)).toBe(true);
    expect(path!.every((p) => cluster.has(p)), 'path stays inside the cluster').toBe(true);
    expect(path![0]).toEqual(entry);
    expect(path!.every((p) => p.y === 64), 'straight westbound path must stay on y=64').toBe(true);
  });

  it('turnShapeLeftArcsAroundCenterEndsAdjacentToSouthExit', () => {
    const cluster = boxRect(31, 34, 61, 66);
    const entry = t(34, 64);
    const exit = t(32, 60);
    const path = buildInternalPath(cluster, t(32, 63), entry, 'West', exit, 'South', 'LeftTurn');
    expect(path).toBeDefined();
    expect(isFourAdjacent(path!)).toBe(true);
    expect(path!.every((p) => cluster.has(p))).toBe(true);
    expect(path![0]).toEqual(entry);
    expect(isSimple(path!)).toBe(true);
    const c = [33, 64] as const;
    expect(
      path!.some((p) => p.x < c[0]) &&
        path!.some((p) => p.x + 1 > c[0]) &&
        path!.some((p) => p.y + 1 > c[1]) &&
        path!.some((p) => p.y < c[1]),
      'left arc must enclose the center point',
    ).toBe(true);
    const last = path![path!.length - 1]!;
    expect(Math.abs(last.x - exit.x) + Math.abs(last.y - exit.y), 'ends adjacent to exit').toBe(1);
  });

  it('entryNotInClusterReturnsNone', () => {
    const cluster = boxRect(31, 34, 61, 66);
    expect(buildInternalPath(cluster, t(31, 61), t(99, 99), 'West', t(30, 64), 'West', 'Straight')).toBeUndefined();
  });

  it('entryIsTheGoalReturnsSingleTilePath', () => {
    const cluster = boxRect(31, 31, 61, 61);
    const path = buildInternalPath(cluster, t(31, 61), t(31, 61), 'West', t(30, 61), 'West', 'Straight');
    expect(path).toEqual([t(31, 61)]);
  });

  it('straightRoutesShortestPathToInBoxGoal', () => {
    const cluster = new TileSet([t(3, 4), t(4, 4), t(5, 4), t(3, 5), t(4, 5)]);
    const entry = t(3, 4);
    const path = buildInternalPath(cluster, t(3, 4), entry, 'East', t(5, 5), 'East', 'Straight');
    expect(path).toBeDefined();
    expect(path![path!.length - 1], 'straight must terminate on the in-box goal (4,5)').toEqual(t(4, 5));
    expect(path![0]).toEqual(entry);
    expect(isFourAdjacent(path!)).toBe(true);
    expect(path!.every((p) => cluster.has(p))).toBe(true);
  });

  it('degenerateExitFeederOutsideClusterReturnsNoneNotOncomingPath', () => {
    const cluster = new TileSet([t(3, 4), t(3, 5), t(4, 5), t(5, 5)]);
    expect(cluster.has(t(5, 4)), 'precondition: the exit-feeding tile must be outside the cluster').toBe(false);
    const path = buildInternalPath(cluster, t(3, 4), t(3, 4), 'East', t(6, 4), 'East', 'Straight');
    expect(path, 'degenerate exit feeder must yield None').toBeUndefined();
  });

  it('parallelThroughLanesTakeDisjointInternalPaths', () => {
    const cluster = boxRect(31, 34, 61, 66);
    const pa = buildInternalPath(cluster, t(31, 61), t(34, 63), 'West', t(30, 63), 'West', 'Straight')!;
    const pb = buildInternalPath(cluster, t(31, 61), t(34, 64), 'West', t(30, 64), 'West', 'Straight')!;
    const sa = new Set(pa.map((p) => `${p.x},${p.y}`));
    expect(
      pb.every((p) => !sa.has(`${p.x},${p.y}`)),
      'parallel lanes must not share internal tiles',
    ).toBe(true);
    expect(isFourAdjacent(pa)).toBe(true);
    expect(pa.every((p) => cluster.has(p))).toBe(true);
  });
});

describe('lanelet graph build', () => {
  it('buildLaneletGraphFlagOnPopulatesGraph', () => {
    const { graph, matrices } = buildLanelets(buildCrossGrid());
    expect(graph.lanelets.length, 'lanelets must be built').toBeGreaterThan(0);
    expect(graph.byIntersection.has(0), 'byIntersection must contain cluster 0').toBe(true);
    expect(graph.version).toBe(1);
    expect(matrices.byIntersection.has(0), 'conflict matrix must exist for cluster 0').toBe(true);
    expect(matrices.version).toBe(1);
  });

  it('laneletsSortedByEntryExitLaneId', () => {
    const { graph } = buildLanelets(buildCrossGrid());
    const keys = graph.ofIntersection(0).map((id) => {
      const l = graph.get(id)!;
      return [l.entryLane, l.exitLane] as const;
    });
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(keys, 'lanelets must be in (entry_lane, exit_lane) order').toEqual(sorted);
  });

  it('byEntryLaneIndexPopulatedAndAscendingByExit', () => {
    const { graph } = buildLanelets(buildCrossGrid());
    const e = graph.lanelets[0]!.entryLane;
    const from = graph.laneletsFrom(e);
    expect(from.length, 'entry lane must be indexed').toBeGreaterThan(0);
    expect(from).toEqual(graph.lanelets.filter((l) => l.entryLane === e).map((l) => l.id));
    const exits = from.map((id) => graph.get(id)!.exitLane);
    expect(exits, 'exit lanes must be ascending').toEqual([...exits].sort((a, b) => a - b));
    expect(graph.laneletsFrom(U32_MAX)).toEqual([]);
  });

  it('matrixDoesNotOverReportParallelOrOppositeStraights', () => {
    const { graph, matrices } = buildLanelets(buildTwoLaneCrossGrid());
    const ids = graph.ofIntersection(0);
    const matrix = matrices.byIntersection.get(0)!;
    expect(matrix, 'matrix for cluster 0').toBeDefined();

    const eastbound: number[] = [];
    const westbound: number[] = [];
    const northbound: number[] = [];
    ids.forEach((lid, local) => {
      const l = graph.get(lid)!;
      if (l.maneuver !== 'Straight' || l.internalPath.length < 2) return;
      const first = l.internalPath[0]!;
      const last = l.internalPath[l.internalPath.length - 1]!;
      const key = `${Math.sign(last.x - first.x)},${Math.sign(last.y - first.y)}`;
      if (key === '1,0') eastbound.push(local);
      else if (key === '-1,0') westbound.push(local);
      else if (key === '0,1') northbound.push(local);
    });
    const dump = (local: number) => JSON.stringify(graph.get(ids[local]!)!.internalPath);

    expect(eastbound.length, 'expected two parallel eastbound throughs').toBeGreaterThanOrEqual(2);
    expect(westbound.length, 'expected at least one westbound through').toBeGreaterThan(0);
    expect(northbound.length, 'expected at least one northbound through').toBeGreaterThan(0);

    const [pa, pb] = [eastbound[0]!, eastbound[1]!];
    expect(matrix.conflicts(pa, pb), `parallel eastbound straights: ${dump(pa)} vs ${dump(pb)}`).toBe(false);
    const [oa, ob] = [eastbound[0]!, westbound[0]!];
    expect(matrix.conflicts(oa, ob), `opposite straights: ${dump(oa)} vs ${dump(ob)}`).toBe(false);
    const [ew, ns] = [eastbound[0]!, northbound[0]!];
    expect(matrix.conflicts(ew, ns), `crossing straights: ${dump(ew)} vs ${dump(ns)}`).toBe(true);
  });

  it('crosswalkCellsOnePerApproachOnClusterEdge', () => {
    const grid = buildCrossGrid();
    const cluster = indexFor(grid).clusters[0]!;
    const cws = crosswalkCells(cluster, grid);
    expect(cws.length, '4-way cross yields one crosswalk per approach side').toBe(4);
    const inCluster = new Set(cluster.tiles.map((p) => `${p.x},${p.y}`));
    for (const cw of cws) {
      expect(cw.cells.length, 'each crosswalk has cells').toBeGreaterThan(0);
      expect(
        cw.cells.every((c) => inCluster.has(`${c.x},${c.y}`)),
        'crosswalk cells lie on the cluster boundary',
      ).toBe(true);
    }
    expect(cws.map((c) => c.id)).toEqual([0, 1, 2, 3]);
    expect(cws.map((c) => c.side)).toEqual(['West', 'East', 'South', 'North']);
    expect(crosswalkCells(cluster, grid), 'crosswalk derivation is deterministic').toEqual(cws);
  });

  it('buildStoresCrosswalkSidesPerIntersection', () => {
    const { matrices } = buildLanelets(buildCrossGrid());
    const sides = matrices.crosswalkSides.get(0);
    expect(sides, 'crosswalk sides stored for cluster 0').toEqual(['West', 'East', 'South', 'North']);
    const matrix = matrices.byIntersection.get(0)!;
    expect(matrix.len() - matrix.crosswalkBase(), 'one matrix crosswalk row per stored side').toBe(sides!.length);
  });

  it('straightLaneletsKeepTheirLaneThroughTheBox', () => {
    const grid = new MapGrid(12, 12);
    const set = (x: number, y: number, dir: RoadDir, lane: number) =>
      setRoad(grid, t(x, y), { kind: 'FourLane', dir, lane });
    for (let x = 4; x <= 7; x++) for (let y = 4; y <= 7; y++) set(x, y, 'None', 0);
    for (const x of [0, 1, 2, 3, 8, 9, 10, 11]) {
      set(x, 4, 'East', 0);
      set(x, 5, 'East', 1);
      set(x, 6, 'West', 2);
      set(x, 7, 'West', 3);
    }
    for (const y of [0, 1, 2, 3, 8, 9, 10, 11]) {
      set(7, y, 'North', 0);
      set(6, y, 'North', 1);
      set(5, y, 'South', 2);
      set(4, y, 'South', 3);
    }
    const { graph, lanes } = buildLanelets(grid);
    let straights = 0;
    for (const ll of graph.lanelets) {
      if (ll.maneuver !== 'Straight') continue;
      straights++;
      const entry = lanes.getLane(ll.entryLane)!.pos;
      const exit = lanes.getLane(ll.exitLane)!.pos;
      expect(
        grid.get(exit)!.road.lane,
        `straight lanelet weaves across lanes inside the box: ${JSON.stringify(entry)} -> ${JSON.stringify(exit)}`,
      ).toBe(grid.get(entry)!.road.lane);
    }
    expect(straights, 'expected a straight lanelet per approach lane (2 per direction)').toBeGreaterThanOrEqual(8);
  });
});

describe('lane discipline', () => {
  const approachCell = (kind: RoadKind, lane: number, laneType: LaneType): RoadCell => ({
    kind,
    dir: 'North',
    lane,
    flow: { kind: 'TwoWay' },
    laneType,
  });

  it('laneTypeGatesManeuvers', () => {
    const solo = (lt: LaneType) => approachCell('TwoLane', 0, lt);
    const allows = (m: ManeuverKind, cell: RoadCell) => laneAllowsManeuver(m, cell, true);

    expect(allows('LeftTurn', solo('LeftTurnOnly'))).toBe(true);
    expect(allows('Straight', solo('LeftTurnOnly'))).toBe(false);
    expect(allows('RightTurn', solo('LeftTurnOnly'))).toBe(false);
    expect(allows('Other', solo('LeftTurnOnly'))).toBe(false);

    expect(allows('RightTurn', solo('RightTurnOnly'))).toBe(true);
    expect(allows('Straight', solo('RightTurnOnly'))).toBe(false);
    expect(allows('LeftTurn', solo('RightTurnOnly'))).toBe(false);

    expect(allows('Straight', solo('StraightOnly'))).toBe(true);
    expect(allows('RightTurn', solo('StraightOnly'))).toBe(false);
    expect(allows('LeftTurn', solo('StraightOnly'))).toBe(false);

    const reg = solo('Regular');
    expect(allows('Straight', reg)).toBe(true);
    expect(allows('RightTurn', reg)).toBe(true);
    expect(allows('LeftTurn', reg)).toBe(true);
    expect(allows('Other', reg)).toBe(false);
  });

  it('regularLaneDisciplineIsPositionalOnMultilane', () => {
    const curb = approachCell('FourLane', 0, 'Regular');
    const center = approachCell('FourLane', 1, 'Regular');
    expect(isRightmostForDir(curb) && !isLeftmostForDir(curb)).toBe(true);
    expect(isLeftmostForDir(center) && !isRightmostForDir(center)).toBe(true);

    expect(laneAllowsManeuver('Straight', curb, true)).toBe(true);
    expect(laneAllowsManeuver('Straight', center, true)).toBe(true);
    for (const m of ['LeftTurn', 'UTurn'] as const) {
      expect(laneAllowsManeuver(m, center, true), `${m} must be legal from the centerline lane`).toBe(true);
      expect(laneAllowsManeuver(m, curb, true), `${m} from the curb lane violates ПДД 8.5`).toBe(false);
    }
    expect(laneAllowsManeuver('RightTurn', curb, true)).toBe(true);
    expect(laneAllowsManeuver('RightTurn', center, true)).toBe(false);

    expect(laneAllowsManeuver('UTurn', approachCell('FourLane', 1, 'LeftTurnOnly'), true)).toBe(true);
    expect(laneAllowsManeuver('LeftTurn', approachCell('FourLane', 0, 'RightTurnOnly'), true)).toBe(false);
  });
});

describe('arc-around-center geometry', () => {
  it('arc2x2StraightIsADirectLine', () => {
    const path = buildInternalPath(box2x2(), t(4, 4), t(4, 4), 'East', t(6, 4), 'East', 'Straight');
    expect(path, 'straight is the direct line').toEqual([t(4, 4), t(5, 4)]);
  });

  it('arc2x2RightTurnIsTightNearCorner', () => {
    const cluster = box2x2();
    const entry = t(4, 4);
    const goal = t(5, 4);
    const path = buildInternalPath(cluster, t(4, 4), entry, 'North', t(6, 4), 'East', 'RightTurn')!;
    expectPathInvariants(cluster, path, entry, goal);
    expect(path, 'tight right turn = the 2-tile near-corner hug').toEqual([entry, goal]);
    expect(enclosesCenter(path, [5, 5]), 'tight right turn must NOT enclose C').toBe(false);
  });

  it('arc2x2LeftTurnSwingsAroundCenter', () => {
    const cluster = box2x2();
    const entry = t(4, 4);
    const goal = t(4, 5);
    const path = buildInternalPath(cluster, t(4, 4), entry, 'North', t(3, 5), 'West', 'LeftTurn')!;
    expectPathInvariants(cluster, path, entry, goal);
    expect(path, 'ПДД left: up the own column past the center, then out').toEqual([t(4, 4), t(4, 5)]);
    expect(
      path.every((p) => p.x === 4),
      'left turn must never touch the oncoming southbound column x=5',
    ).toBe(true);
  });

  it('arc2x2UturnLoopsAroundCenter', () => {
    const cluster = box2x2();
    const entry = t(4, 4);
    const goal = t(5, 4);
    const path = buildInternalPath(cluster, t(4, 4), entry, 'North', t(5, 3), 'South', 'UTurn')!;
    expectPathInvariants(cluster, path, entry, goal);
    expect(path, 'U-turn walks the full loop around C').toEqual([t(4, 4), t(4, 5), t(5, 5), t(5, 4)]);
    expect(enclosesCenter(path, [5, 5]), 'U-turn must enclose C').toBe(true);
  });

  it('arc3x3AllManeuvers', () => {
    const cluster = box3x3();
    const c = [5.5, 5.5] as const;

    const sEntry = t(4, 5);
    const sGoal = t(6, 5);
    const straight = buildInternalPath(cluster, t(5, 5), sEntry, 'East', t(7, 5), 'East', 'Straight')!;
    expectPathInvariants(cluster, straight, sEntry, sGoal);
    expect(straight, 'straight is the direct middle-row line').toEqual([sEntry, t(5, 5), sGoal]);

    const rEntry = t(4, 4);
    const rGoal = t(6, 4);
    const right = buildInternalPath(cluster, t(5, 5), rEntry, 'North', t(7, 4), 'East', 'RightTurn')!;
    expectPathInvariants(cluster, right, rEntry, rGoal);
    expect(right, 'tight right turn hugs the bottom edge').toEqual([rEntry, t(5, 4), rGoal]);
    expect(enclosesCenter(right, c), 'tight right turn must NOT enclose C').toBe(false);

    const lEntry = t(4, 4);
    const lGoal = t(4, 6);
    const left = buildInternalPath(cluster, t(5, 5), lEntry, 'East', t(4, 7), 'North', 'LeftTurn')!;
    expectPathInvariants(cluster, left, lEntry, lGoal);
    expect(left, 'ПДД left is the compact Г onto the exit column').toEqual([lEntry, t(4, 5), lGoal]);
    expect(left, 'left turn must not cut through the center tile').not.toContainEqual(t(5, 5));

    const uEntry = t(4, 4);
    const uGoal = t(4, 5);
    const uturn = buildInternalPath(cluster, t(5, 5), uEntry, 'East', t(3, 5), 'West', 'UTurn')!;
    expectPathInvariants(cluster, uturn, uEntry, uGoal);
    expect(uturn, 'U-turn is the П around the center').toEqual([uEntry, t(5, 4), t(6, 4), t(6, 5), t(5, 5), uGoal]);
    expect(
      uturn.some((p) => p.x + 0.5 > c[0]),
      'U-turn pivot must pass beyond the center',
    ).toBe(true);
  });

  it('arc4x4StraightIsADirectLine', () => {
    const cluster = box4x4();
    const entry = t(4, 4);
    const goal = t(7, 4);
    const path = buildInternalPath(cluster, t(4, 4), entry, 'East', t(8, 4), 'East', 'Straight')!;
    expectPathInvariants(cluster, path, entry, goal);
    expect(path, 'straight is the direct bottom-row line').toEqual([t(4, 4), t(5, 4), t(6, 4), t(7, 4)]);
    expect(enclosesCenter(path, [6, 6]), 'straight must NOT enclose C').toBe(false);
  });

  it('arc4x4RightTurnIsTightCornerCOutside', () => {
    const cluster = box4x4();
    const entry = t(4, 4);
    const goal = t(7, 4);
    const path = buildInternalPath(cluster, t(4, 4), entry, 'North', t(8, 4), 'East', 'RightTurn')!;
    expectPathInvariants(cluster, path, entry, goal);
    expect(enclosesCenter(path, [6, 6]), 'tight right turn must NOT enclose C').toBe(false);
    expect(
      path.every((p) => p.y <= 5),
      'tight right turn hugs the corner',
    ).toBe(true);
  });

  it('arc4x4LeftTurnWideEnclosesCLeavesBoxRoom', () => {
    const cluster = box4x4();
    const entry = t(4, 4);
    const goal = t(4, 7);
    const path = buildInternalPath(cluster, t(4, 4), entry, 'East', t(4, 8), 'North', 'LeftTurn')!;
    expectPathInvariants(cluster, path, entry, goal);
    expect(path, 'left turn is the compact Г along the exit column').toEqual([t(4, 4), t(4, 5), t(4, 6), t(4, 7)]);
    expect(path.length, 'must not occupy the whole 4x4 box').toBeLessThan(16);
    for (const innerFar of [t(5, 5), t(5, 6)]) {
      expect(path, `far inner tile ${JSON.stringify(innerFar)} must stay free`).not.toContainEqual(innerFar);
    }
  });

  it('arc4x4UturnWideEnclosesCLeavesBoxRoom', () => {
    const cluster = box4x4();
    const c = [6, 6] as const;
    const entry = t(4, 4);
    const goal = t(4, 5);
    const path = buildInternalPath(cluster, t(4, 4), entry, 'East', t(3, 5), 'West', 'UTurn')!;
    expectPathInvariants(cluster, path, entry, goal);
    expect(path, 'U-turn is the compact П around the center').toEqual([
      t(4, 4),
      t(5, 4),
      t(6, 4),
      t(6, 5),
      t(5, 5),
      t(4, 5),
    ]);
    expect(
      path.some((p) => p.x + 0.5 > c[0]),
      'U-turn pivot must pass beyond the center',
    ).toBe(true);
    expect(
      path.every((p) => p.y <= 5),
      'U-turn must stay on its own half of the crossing road',
    ).toBe(true);
  });

  it('mixedWidthSquare4x4DoesNotSpuriouslyDrop', () => {
    const cluster = box4x4();
    const cases: Array<readonly [TilePos, RoadDir, TilePos, RoadDir, ManeuverKind]> = [
      [t(4, 4), 'East', t(8, 4), 'East', 'Straight'],
      [t(7, 7), 'West', t(3, 7), 'West', 'Straight'],
      [t(4, 4), 'North', t(4, 8), 'North', 'Straight'],
      [t(7, 7), 'South', t(7, 3), 'South', 'Straight'],
      [t(4, 4), 'North', t(8, 4), 'East', 'RightTurn'],
    ];
    for (const [entry, edir, exit, xdir, man] of cases) {
      const path = buildInternalPath(cluster, t(4, 4), entry, edir, exit, xdir, man);
      expect(path, `square 4x4 must NOT spuriously drop ${man} ${JSON.stringify(entry)}->${JSON.stringify(exit)}`).toBeDefined();
      expectPathInvariants(cluster, path!, entry, feeder(exit, xdir));
    }
  });

  it('mixedWidthNonsquareBoxesNeverEmitOncoming', () => {
    const rect4x6 = boxRect(4, 7, 4, 9);
    const rect4x2 = boxRect(4, 7, 5, 6);
    const cases: Array<readonly [TileSet, TilePos, RoadDir, TilePos, RoadDir, ManeuverKind]> = [
      [rect4x6, t(4, 4), 'East', t(8, 4), 'East', 'Straight'],
      [rect4x6, t(4, 4), 'North', t(4, 10), 'North', 'Straight'],
      [rect4x6, t(4, 4), 'North', t(8, 4), 'East', 'RightTurn'],
      [rect4x2, t(4, 5), 'East', t(8, 5), 'East', 'Straight'],
      [rect4x2, t(4, 5), 'East', t(4, 7), 'North', 'LeftTurn'],
      [rect4x2, t(4, 5), 'East', t(3, 6), 'West', 'UTurn'],
    ];
    for (const [cluster, entry, edir, exit, xdir, man] of cases) {
      const path = buildInternalPath(cluster, t(4, 4), entry, edir, exit, xdir, man);
      if (path === undefined) continue; // dropping is acceptable
      const goal = feeder(exit, xdir);
      expectPathInvariants(cluster, path, entry, goal);
      expect({ x: goal.x + dirDelta(xdir).x, y: goal.y + dirDelta(xdir).y }, 'lands on the same-direction exit').toEqual(
        exit,
      );
    }
  });
});
