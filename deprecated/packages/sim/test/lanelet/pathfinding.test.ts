// Ported from crates/simcity_sim/src/game/transport/lanelet/pathfinding.rs (mod tests).
import { describe, expect, it } from 'vitest';
import type { RoadDir, TilePos } from '../../src/commands';
import { MapGrid } from '../../src/map/grid';
import { TrafficOccupancy } from '../../src/traffic/occupancy';
import { buildLaneGraphInner } from '../../src/transport/laneGraph';
import { baseTileCost, laneEdgeCost, type LaneCostCtx } from '../../src/transport/lanePathfinding';
import { LaneletGraph, type Lanelet } from '../../src/transport/lanelet/graph';
import {
  NodeSpace,
  findCombinedPath,
  findRoute,
  firstOncomingPair,
  flatten,
  forEachSucc,
  laneletNode,
  roadNode,
  routeIsDirectionCorrect,
  type CombinedNode,
} from '../../src/transport/lanelet/pathfinding';
import { defaultPathfindingConfig } from '../../src/transport/pathfinding';
import { setRoad } from '../transport/helpers';

const t = (x: number, y: number): TilePos => ({ x, y });

function setLane(grid: MapGrid, pos: TilePos, lane: number, dir: RoadDir): void {
  setRoad(grid, pos, { dir, lane });
}

function ctxFor(grid: MapGrid, traffic: TrafficOccupancy, jitterSeed = 0n): LaneCostCtx {
  return { grid, traffic, cfg: defaultPathfindingConfig(), jitterSeed };
}

function occupancyFor(grid: MapGrid): TrafficOccupancy {
  const traffic = new TrafficOccupancy();
  traffic.ensureLen(grid.len());
  return traffic;
}

function lanelet(id: number, intersection: number, entryLane: number, exitLane: number, internalPath: TilePos[]): Lanelet {
  return { id, intersection, entryLane, exitLane, maneuver: 'Straight', internalPath };
}

function parallelCorridors(): MapGrid {
  const grid = new MapGrid(4, 2);
  for (let x = 0; x < 4; x++) {
    setLane(grid, t(x, 0), 0, 'East');
    setLane(grid, t(x, 1), 1, 'East');
  }
  return grid;
}

describe('combined lane + lanelet graph', () => {
  it('nodeSpacePackUnpackRoundtrips', () => {
    const grid = new MapGrid(2, 1);
    setLane(grid, t(0, 0), 0, 'East');
    setLane(grid, t(1, 0), 0, 'East');
    const space = new NodeSpace(buildLaneGraphInner(grid, 1));
    expect(space.unpack(space.pack(roadNode(1)))).toEqual(roadNode(1));
    expect(space.unpack(space.pack(laneletNode(3)))).toEqual(laneletNode(3));
    expect(space.pack(laneletNode(0))).toBe(space.roadLen);
  });

  it('successorsEnterOnlyLegalLanesAndAreDeterministic', () => {
    const grid = new MapGrid(3, 2);
    for (let x = 0; x < 3; x++) {
      setLane(grid, t(x, 0), 0, 'East');
      setLane(grid, t(x, 1), 1, 'East');
    }
    const lg = buildLaneGraphInner(grid, 1);
    const e = lg.getLaneId(t(0, 0), 0)!;
    const lateral = lg.getLaneId(t(0, 1), 1)!;
    const exit = lg.getLaneId(t(1, 0), 0)!;

    const llg = new LaneletGraph();
    llg.lanelets = [
      lanelet(0, 0, e, exit, [t(9, 9), t(9, 10)]),
      { ...lanelet(1, 0, e, lateral, [t(8, 8)]), maneuver: 'LeftTurn' },
    ];
    llg.byEntryLane.set(e, [0, 1]);
    llg.version = 1;

    const ctx = ctxFor(grid, occupancyFor(grid));
    const space = new NodeSpace(lg);
    const succOf = (node: CombinedNode) => {
      const out: Array<readonly [CombinedNode, number]> = [];
      forEachSucc(space, space.pack(node), lg, llg, ctx, (s, c) => out.push([space.unpack(s), c]));
      return out;
    };

    const succ = succOf(roadNode(e));
    const enters = succ.filter(([n]) => n.kind === 'Lanelet');
    expect(enters.map(([n]) => n)).toEqual([laneletNode(0), laneletNode(1)]);

    const base = baseTileCost('TwoLane', ctx.cfg);
    expect(enters[0]![1]).toBe(ctx.cfg.turnPenalty + 2 * base);
    expect(enters[1]![1]).toBe(ctx.cfg.turnPenalty + base);

    const lateralCost = succ.find(([n]) => n.kind === 'Road' && n.id === lateral)?.[1];
    expect(lateralCost).toBe(laneEdgeCost(ctx, lg, lateral) + ctx.cfg.laneChangePenalty);

    expect(succOf(roadNode(e)), 'a second call yields an identical sequence').toEqual(succ);
    expect(succOf(laneletNode(0)), 'lanelet EXIT: one edge to the exit lane, cost 1').toEqual([[roadNode(exit), 1]]);
  });

  it('combinedPathDeterministicTakesStraightCorridorAndSpreads', () => {
    const grid = parallelCorridors();
    const lg = buildLaneGraphInner(grid, 1);
    const llg = new LaneletGraph();
    const traffic = occupancyFor(grid);
    const start = lg.getLaneId(t(0, 0), 0)!;
    const goal = lg.getLaneId(t(3, 0), 0)!;

    expect(findCombinedPath(lg, llg, ctxFor(grid, traffic, 7n), start, goal)).toEqual(
      findCombinedPath(lg, llg, ctxFor(grid, traffic, 7n), start, goal),
    );

    const combined = findCombinedPath(lg, llg, ctxFor(grid, traffic), start, goal)!;
    expect(combined.map((n) => lg.getLane(n.id)!.pos)).toEqual([t(0, 0), t(1, 0), t(2, 0), t(3, 0)]);

    const goal2 = lg.getLaneId(t(3, 1), 1)!;
    const routes = Array.from({ length: 64 }, (_, i) =>
      JSON.stringify(findCombinedPath(lg, llg, ctxFor(grid, traffic, BigInt(i + 1)), start, goal2)),
    );
    const distinct = new Set(routes);
    const maxFreq = Math.max(...[...distinct].map((r) => routes.filter((x) => x === r).length));
    expect(distinct.size, 'expected >=2 route classes').toBeGreaterThanOrEqual(2);
    expect(maxFreq, 'one route monopolized all 64 seeds').toBeLessThan(64);
  });

  it('congestionPushesCombinedPathOntoParallelCorridor', () => {
    const grid = parallelCorridors();
    const lg = buildLaneGraphInner(grid, 1);
    const traffic = occupancyFor(grid);
    traffic.perTickVehicles[grid.idx(t(1, 0))!] = 8;
    traffic.perTickVehicles[grid.idx(t(2, 0))!] = 8;

    const start = lg.getLaneId(t(0, 0), 0)!;
    const goal = lg.getLaneId(t(3, 0), 0)!;
    const path = findCombinedPath(lg, new LaneletGraph(), ctxFor(grid, traffic), start, goal)!;
    const tiles = path.map((n) => lg.getLane(n.id)!.pos);
    expect(tiles[0]).toEqual(t(0, 0));
    expect(tiles[tiles.length - 1]).toEqual(t(3, 0));
    expect(
      tiles.some((p) => p.y === 1),
      'expected detour onto parallel corridor y=1',
    ).toBe(true);
    expect(tiles, 'expected to avoid congested y=0 tiles').not.toContainEqual(t(1, 0));
    expect(tiles).not.toContainEqual(t(2, 0));
  });

  it('flattenIs4AdjacentAndSidecarOffsetsMatch', () => {
    const grid = new MapGrid(4, 1);
    setLane(grid, t(0, 0), 0, 'East');
    setLane(grid, t(1, 0), 0, 'East');
    setLane(grid, t(3, 0), 0, 'East');
    const lg = buildLaneGraphInner(grid, 1);
    const a = lg.getLaneId(t(0, 0), 0)!;
    const entry = lg.getLaneId(t(1, 0), 0)!;
    const exit = lg.getLaneId(t(3, 0), 0)!;
    const llg = new LaneletGraph();
    llg.lanelets = [lanelet(0, 5, entry, exit, [t(2, 0)])];
    llg.version = 1;

    const { tiles, sidecar } = flatten([roadNode(a), roadNode(entry), laneletNode(0), roadNode(exit)], lg, llg);
    expect(tiles).toEqual([t(0, 0), t(1, 0), t(2, 0), t(3, 0)]);
    expect(sidecar.length).toBe(1);
    const [off, isx, llid] = sidecar[0]!;
    expect(tiles[off]).toEqual(llg.get(llid)!.internalPath[0]);
    expect(isx).toBe(5);
    expect(llid).toBe(0);
  });

  it('routeDirectionGuardAcceptsForwardRejectsOncoming', () => {
    const grid = new MapGrid(3, 1);
    for (let x = 0; x < 3; x++) setLane(grid, t(x, 0), 0, 'East');
    const forward = [t(0, 0), t(1, 0), t(2, 0)];
    expect(routeIsDirectionCorrect(forward, grid)).toBe(true);
    expect(firstOncomingPair(forward, grid)).toBeUndefined();

    const oncoming = [t(2, 0), t(1, 0), t(0, 0)];
    expect(routeIsDirectionCorrect(oncoming, grid)).toBe(false);
    expect(firstOncomingPair(oncoming, grid), 'first oncoming pair is the first wrong-direction step').toEqual([
      t(2, 0),
      t(1, 0),
    ]);
  });

  it('routeDirectionGuardExemptsIntersectionBoxTiles', () => {
    const grid = new MapGrid(3, 1);
    setLane(grid, t(0, 0), 0, 'East');
    setLane(grid, t(2, 0), 0, 'East');
    setLane(grid, t(1, 0), 0, 'None');
    expect(routeIsDirectionCorrect([t(0, 0), t(1, 0), t(2, 0)], grid)).toBe(true);
  });

  it('findRouteRejectsLaneletRouteThatTraversesOncomingLane', () => {
    const grid = new MapGrid(6, 1);
    setLane(grid, t(0, 0), 0, 'East');
    setLane(grid, t(1, 0), 0, 'East');
    setLane(grid, t(3, 0), 0, 'West');
    setLane(grid, t(4, 0), 0, 'West');
    setLane(grid, t(5, 0), 0, 'West');
    const lg = buildLaneGraphInner(grid, 1);
    const entry = lg.getLaneId(t(1, 0), 0)!;
    const badExit = lg.getLaneId(t(3, 0), 0)!;
    const llg = new LaneletGraph();
    llg.lanelets = [lanelet(0, 7, entry, badExit, [t(2, 0)])];
    llg.version = 1;

    const west4 = lg.getLaneId(t(4, 0), 0)!;
    const west5 = lg.getLaneId(t(5, 0), 0)!;
    const raw = flatten([roadNode(entry), laneletNode(0), roadNode(badExit), roadNode(west4), roadNode(west5)], lg, llg);
    expect(firstOncomingPair(raw.tiles, grid), 'precondition: the unguarded route drives oncoming').toEqual([
      t(2, 0),
      t(3, 0),
    ]);

    const start = lg.getLaneId(t(0, 0), 0)!;
    const { tiles, sidecar } = findRoute(lg, llg, ctxFor(grid, occupancyFor(grid)), start, west5);
    expect(firstOncomingPair(tiles, grid), 'guard must never return an oncoming route').toBeUndefined();
    expect(tiles, 'release behaviour: the route is dropped').toEqual([]);
    expect(sidecar).toEqual([]);
  });

  it('findRouteEmitsSidecarThroughLanelet', () => {
    const grid = new MapGrid(4, 1);
    setLane(grid, t(0, 0), 0, 'East');
    setLane(grid, t(1, 0), 0, 'East');
    setLane(grid, t(3, 0), 0, 'East');
    const lg = buildLaneGraphInner(grid, 1);
    const s = lg.getLaneId(t(0, 0), 0)!;
    const entry = lg.getLaneId(t(1, 0), 0)!;
    const exit = lg.getLaneId(t(3, 0), 0)!;
    const llg = new LaneletGraph();
    llg.lanelets = [lanelet(0, 2, entry, exit, [t(2, 0)])];
    llg.byEntryLane.set(entry, [0]);
    llg.version = 1;

    const { tiles, sidecar } = findRoute(lg, llg, ctxFor(grid, occupancyFor(grid)), s, exit);
    expect(tiles).toEqual([t(0, 0), t(1, 0), t(2, 0), t(3, 0)]);
    expect(sidecar.length).toBe(1);
    expect(sidecar[0]![1]).toBe(2);
    expect(sidecar[0]![2]).toBe(0);
  });
});
