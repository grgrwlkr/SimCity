// Ported from crates/simcity_sim/src/game/transport/tests.rs (road graph edges) and
// crates/simcity_sim/src/game/map/tests.rs (`one_way_stroke_across_an_intersection_keeps_the_crossing_drivable`).
import { describe, expect, it } from 'vitest';
import { applyCommands } from '../../src/app';
import type { LaneType } from '../../src/commands';
import { MapGrid } from '../../src/map/grid';
import { roadSegmentCommands } from '../../src/map/roadTool';
import { EDGE_E, EDGE_N, EDGE_S, EDGE_W, RoadGraph, rebuildRoadGraphInner } from '../../src/transport/roadGraph';
import { createWorld } from '../../src/world';
import { buildTwoWayVerticalSpur, oneWay, oracleCrossingGrid, setRoad } from './helpers';

function builtGraph(grid: MapGrid): RoadGraph {
  const graph = new RoadGraph();
  rebuildRoadGraphInner(grid, 1, graph);
  return graph;
}

/** A northbound lane tile at (1,1) of `laneType`, with intersection tiles north, west and east of it. */
function laneIntoIntersection(laneType: LaneType): number {
  const grid = new MapGrid(3, 3);
  const lane = { x: 1, y: 1 };
  setRoad(grid, lane, { dir: 'North', laneType });
  for (const pos of [
    { x: 1, y: 2 },
    { x: 0, y: 1 },
    { x: 2, y: 1 },
  ]) {
    setRoad(grid, pos, { dir: 'None' });
  }
  return builtGraph(grid).edges[grid.idx(lane)!]!;
}

describe('road graph', () => {
  it('laneTypeLeftTurnOnlyAllowsOnlyLeftEntryIntoIntersection', () => {
    const mask = laneIntoIntersection('LeftTurnOnly');
    expect(mask & EDGE_W, 'left turn should be allowed (West entry)').not.toBe(0);
    expect(mask & EDGE_E, 'right entry should be blocked').toBe(0);
    expect(mask & EDGE_N, 'straight entry should be blocked').toBe(0);
  });

  it('laneTypeRightTurnOnlyAllowsOnlyRightEntryIntoIntersection', () => {
    const mask = laneIntoIntersection('RightTurnOnly');
    expect(mask & EDGE_W, 'left entry should be blocked').toBe(0);
    expect(mask & EDGE_E, 'right turn should be allowed (East entry)').not.toBe(0);
    expect(mask & EDGE_N, 'straight entry should be blocked').toBe(0);
  });

  it('laneTypeStraightOnlyAllowsOnlyStraightEntryIntoIntersection', () => {
    const mask = laneIntoIntersection('StraightOnly');
    expect(mask & EDGE_W, 'left entry should be blocked').toBe(0);
    expect(mask & EDGE_E, 'right entry should be blocked').toBe(0);
    expect(mask & EDGE_N, 'straight should be allowed (North entry)').not.toBe(0);
  });

  it('intersectionExitRequiresLaneDirAlignment', () => {
    const grid = new MapGrid(3, 3);
    const intersection = { x: 1, y: 1 };
    setRoad(grid, intersection, { dir: 'None' });
    setRoad(grid, { x: 1, y: 2 }, { dir: 'South' });
    setRoad(grid, { x: 1, y: 0 }, { dir: 'South' });

    const mask = builtGraph(grid).edges[grid.idx(intersection)!]!;
    expect(mask & EDGE_N, 'exit into opposite-direction lane should be blocked').toBe(0);
    expect(mask & EDGE_S, 'exit into matching-direction lane should be allowed').not.toBe(0);
  });

  it('laneEntryBlocksReverseIntoIntersection', () => {
    const grid = new MapGrid(3, 3);
    setRoad(grid, { x: 1, y: 1 }, { dir: 'None' });
    const south = { x: 1, y: 0 };
    const north = { x: 1, y: 2 };
    setRoad(grid, south, { dir: 'North' });
    setRoad(grid, north, { dir: 'North' });

    const graph = builtGraph(grid);
    expect(graph.edges[grid.idx(south)!]! & EDGE_N, 'forward entry into intersection should be allowed').not.toBe(0);
    expect(graph.edges[grid.idx(north)!]! & EDGE_S, 'reverse entry into intersection should be blocked').toBe(0);
  });

  it('oneWayIgnoresOppositeDirectionLaneTiles', () => {
    const grid = new MapGrid(3, 1);
    setRoad(grid, { x: 0, y: 0 }, { dir: 'West', flow: oneWay('East') });
    setRoad(grid, { x: 1, y: 0 }, { dir: 'East', flow: oneWay('East') });
    setRoad(grid, { x: 2, y: 0 }, { dir: 'East', flow: oneWay('East') });

    const graph = builtGraph(grid);
    expect(graph.edges[0], 'opposite-direction lane should be ignored').toBe(0);
    expect(graph.edges[1], 'valid one-way lane should remain usable').not.toBe(0);
  });

  it('oneWayAllowsLaneChangeBetweenSameDirectionLanes', () => {
    const grid = new MapGrid(1, 2);
    for (let y = 0; y < 2; y++) setRoad(grid, { x: 0, y }, { dir: 'East', lane: y, flow: oneWay('East') });

    const graph = builtGraph(grid);
    expect(graph.edges[grid.idx({ x: 0, y: 0 })!]! & EDGE_N, 'lane-change across one-way lanes should be allowed').not.toBe(0);
    expect(graph.edges[grid.idx({ x: 0, y: 1 })!]! & EDGE_S, 'lane-change across one-way lanes should be allowed').not.toBe(0);
  });

  it('inBoxEdgesRespectReconstructedAxisDirection', () => {
    const grid = oracleCrossingGrid();
    const graph = builtGraph(grid);
    const maskAt = (x: number, y: number) => graph.edges[grid.idx({ x, y })!]!;

    expect(maskAt(4, 4) & EDGE_N, 'North on the SOUTHBOUND column 4 inside the box must be pruned').toBe(0);
    expect(maskAt(5, 5) & EDGE_S, 'South on the NORTHBOUND column 5 inside the box must be pruned').toBe(0);
    expect(maskAt(4, 4) & EDGE_W, 'West on the EASTBOUND row 4 inside the box must be pruned').toBe(0);
    expect(maskAt(4, 5) & EDGE_E, 'East on the WESTBOUND row 5 inside the box must be pruned').toBe(0);

    expect(maskAt(5, 4) & EDGE_N, 'North on the northbound column 5 inside the box must stay').not.toBe(0);
    expect(maskAt(4, 5) & EDGE_S, 'South on the southbound column 4 inside the box must stay').not.toBe(0);
    expect(maskAt(4, 4) & EDGE_E, 'East on the eastbound row 4 inside the box must stay').not.toBe(0);
    expect(maskAt(5, 5) & EDGE_W, 'West on the westbound row 5 inside the box must stay').not.toBe(0);

    expect(maskAt(3, 4) & EDGE_E, 'straight eastbound ENTRY into the box must stay').not.toBe(0);
    expect(maskAt(4, 5) & EDGE_W, 'westbound EXIT out of the box must stay').not.toBe(0);
  });

  it('uturnEdgeAddedAtTwoWayDeadEnd', () => {
    const grid = buildTwoWayVerticalSpur(5, 4, { kind: 'TwoWay' });
    const graph = builtGraph(grid);
    expect(
      graph.edges[grid.idx({ x: 5, y: 4 })!]! & EDGE_W,
      'two-way dead-end (5,4)North must gain a U-turn edge WEST to the opposite (4,4)South lane',
    ).not.toBe(0);
    expect(
      graph.edges[grid.idx({ x: 5, y: 2 })!]! & EDGE_W,
      'mid-road (5,2) must NOT gain a cross-centerline U-turn edge',
    ).toBe(0);
  });

  it('noUturnEdgeOnOneWayDeadEnd', () => {
    const grid = buildTwoWayVerticalSpur(5, 4, oneWay('North'));
    const graph = builtGraph(grid);
    expect(graph.edges[grid.idx({ x: 5, y: 4 })!]! & EDGE_W, 'one-way dead-end must NOT gain a U-turn edge').toBe(0);
  });

  /**
   * A one-way stroke laid across an existing intersection keeps the box a box, leaves the crossing
   * road's movement through it untouched and turns the box's horizontal movement to the one-way direction.
   */
  it('oneWayStrokeAcrossAnIntersectionKeepsTheCrossingDrivable', () => {
    const w = createWorld({ mapWidth: 24, mapHeight: 24 });
    w.appState = 'InGame';
    w.graphVersion = 1;
    const stroke = (from: { x: number; y: number }, to: { x: number; y: number }, oneWayStroke: boolean) => {
      w.commands.push(...roadSegmentCommands(from, to, 'FourLane', true, oneWayStroke));
      applyCommands(w);
    };
    stroke({ x: 12, y: 2 }, { x: 12, y: 21 }, false);
    stroke({ x: 2, y: 12 }, { x: 21, y: 12 }, false);

    const boxTiles = Array.from({ length: 24 * 24 }, (_, i) => ({ x: i % 24, y: Math.floor(i / 24) })).filter((t) => {
      const cell = w.grid.get(t)!;
      return cell.road.kind !== 'None' && cell.road.dir === 'None';
    });
    expect(boxTiles.length, 'the crossing must form an intersection box').toBeGreaterThan(0);

    const edgesOf = (grid: MapGrid) => {
      const graph = builtGraph(grid);
      return boxTiles.map((t) => graph.edges[grid.idx(t)!]!);
    };
    const before = edgesOf(w.grid);

    stroke({ x: 2, y: 12 }, { x: 21, y: 12 }, true);

    expect(boxTiles.every((t) => w.grid.get(t)!.road.dir === 'None'), 'the crossing must stay a box').toBe(true);
    const after = edgesOf(w.grid);
    boxTiles.forEach((tile, i) => {
      expect(after[i]! & 0b1100, `box tile (${tile.x},${tile.y}): the crossing road's movement changed`).toBe(
        before[i]! & 0b1100,
      );
      expect(after[i]! & 0b0011, `box tile (${tile.x},${tile.y}): every horizontal move must be East`).toBe(0b0010);
    });
  });
});
