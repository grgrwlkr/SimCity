// Port of crates/simcity_sim/src/game/traffic/reroute_planner.rs tests: re-planning a mid-trip route
// (lanelets first, a direction-guarded road A* otherwise) and the sweep that fixes routes a road edit
// made illegal.
import { describe, expect, it } from 'vitest';
import type { GameCommand, RoadDir, TilePos } from '../../src/commands';
import { roadSegmentCommands } from '../../src/map/roadTool';
import { applyRoute, invalidateRoutesOnGraphChange, planTilesLaneletFirst, routeDirectionOk } from '../../src/traffic/reroute';
import { refSlot, spawnVehicle } from '../../src/traffic/vehicles';
import { buildLaneGraphInner } from '../../src/transport/laneGraph';
import { rebuildRoadGraphInner } from '../../src/transport/roadGraph';
import { createWorld, type World } from '../../src/world';
import { setRoad } from '../transport/helpers';

const t = (x: number, y: number): TilePos => ({ x, y });

/** A one-lane road along row 1. */
function roadRow(width: number, dir: RoadDir = 'East'): World {
  const w = createWorld({ mapWidth: width, mapHeight: 3 });
  for (let x = 0; x < width; x++) setRoad(w.grid, t(x, 1), { dir });
  return w;
}

const rowRoute = (len: number) => Array.from({ length: len }, (_, x) => t(x, 1));

function remaining(w: World, ref: number): readonly TilePos[] {
  const slot = refSlot(w.vehicles, ref);
  return w.pathPool.remainingFrom(w.vehicles.pathHandle[slot]!, w.vehicles.pathCursor[slot]!) ?? [];
}

function flipRow(w: World, width: number): void {
  for (let x = 0; x < width; x++) setRoad(w.grid, t(x, 1), { dir: 'West' });
  w.graphVersion += 1;
}

describe('reroute planner', () => {
  it('staleRouteIsInvalidatedWhenLaneDirectionFlips', () => {
    const w = roadRow(6);
    w.graphVersion = 1;
    const car = spawnVehicle(w, { route: rowRoute(6), cursor: 1 });
    invalidateRoutesOnGraphChange(w);

    flipRow(w, 6);
    invalidateRoutesOnGraphChange(w);

    const rest = remaining(w, car);
    expect(routeDirectionOk(rest, w.grid), `still against the flipped lanes: ${JSON.stringify(rest)}`).toBe(true);
    expect(rest.length, 'no lane graph, so no legal continuation: truncated to the current tile').toBeLessThanOrEqual(1);
  });

  it('graphChangeReplansAreBudgetedAndCarryOver', () => {
    const w = roadRow(6);
    w.graphVersion = 1;
    w.trafficConfig.maxRoutePlansPerTick = 1;
    const cars = [6, 5].map((len) => spawnVehicle(w, { route: rowRoute(len), cursor: 1 }));
    invalidateRoutesOnGraphChange(w);

    flipRow(w, 6);
    const stale = () => cars.filter((car) => remaining(w, car).length > 1).length;
    invalidateRoutesOnGraphChange(w);
    expect(stale(), 'a budget of one fixes one route this tick').toBe(1);
    invalidateRoutesOnGraphChange(w);
    expect(stale(), 'the sweep carries the rest over to the next tick').toBe(0);
  });

  it('adapterInnerLaneletSuccessHasLaneletProducer', () => {
    const w = roadRow(8);
    w.laneGraph = buildLaneGraphInner(w.grid, 1);
    rebuildRoadGraphInner(w.grid, 1, w.roadGraph);
    expect(planTilesLaneletFirst(w, t(0, 1), t(7, 1))?.producer).toBe('Lanelet');
  });

  it('adapterInnerFallsBackToRoadAstarWhenLanesMissing', () => {
    // No lane graph: the lanelet planner declines, but the road graph is intact.
    const w = roadRow(8);
    rebuildRoadGraphInner(w.grid, 1, w.roadGraph);
    expect(planTilesLaneletFirst(w, t(0, 1), t(7, 1))?.producer).toBe('RoadFallback');
  });

  it('adapterInnerReturnsNoneWhenNothingRoutes', () => {
    const w = createWorld({ mapWidth: 8, mapHeight: 3 });
    expect(planTilesLaneletFirst(w, t(0, 1), t(7, 1))).toBeUndefined();
  });

  it('applyRouteResetsCursorAndSyncsSidecar', () => {
    const w = createWorld({ mapWidth: 16, mapHeight: 16 });
    const car = spawnVehicle(w, { route: [t(0, 0), t(1, 0)], cursor: 1, progress: 0.7 });
    const slot = refSlot(w.vehicles, car);
    w.vehicles.laneletPlan[slot] = { entries: [[3, 9, 9]], builtFor: 0 };

    applyRoute(w, slot, { tiles: [t(5, 5), t(6, 5)], sidecar: [], builtFor: 0, producer: 'RoadFallback' });
    expect(w.vehicles.pathCursor[slot]).toBe(0);
    expect(w.vehicles.progress[slot]).toBe(0);
    expect(w.vehicles.laneletPlan[slot]!.entries, 'a road route clears the stale sidecar').toEqual([]);
    expect(remaining(w, car)[0]).toEqual(t(5, 5));

    applyRoute(w, slot, { tiles: [t(7, 5), t(8, 5)], sidecar: [[1, 2, 4]], builtFor: 3, producer: 'Lanelet' });
    expect(w.vehicles.laneletPlan[slot], 'a lanelet route writes its sidecar').toEqual({ entries: [[1, 2, 4]], builtFor: 3 });
  });

  it('aRerouteThatKeepsTheNextTileKeepsTheCarWhereItIs', () => {
    // Rust restarted every re-planned car at its tile centre: a jump back of up to a tile, and a car at
    // the stop line lost its place.
    const w = createWorld({ mapWidth: 16, mapHeight: 16 });
    const car = spawnVehicle(w, { route: [t(0, 0), t(1, 0), t(2, 0), t(3, 0)], cursor: 1, progress: 0.4 });
    const slot = refSlot(w.vehicles, car);

    applyRoute(w, slot, { tiles: [t(1, 0), t(2, 0), t(2, 1)], sidecar: [], builtFor: 0, producer: 'RoadFallback' });
    expect(w.vehicles.progress[slot], 'same tile, same next tile').toBeCloseTo(0.4);

    applyRoute(w, slot, { tiles: [t(1, 0), t(1, 1)], sidecar: [], builtFor: 0, producer: 'RoadFallback' });
    expect(w.vehicles.progress[slot], 'a different next tile starts from the tile centre').toBe(0);
  });

  it('aWestboundRouteIsRejectedOnceItsRoadIsMadeOneWayEast', () => {
    // The live symptom: a route planned before the road was made one-way still passed validation.
    const w = createWorld({ mapWidth: 40, mapHeight: 20 });
    const lay = (commands: readonly GameCommand[]) => {
      for (const command of commands) {
        if (command.kind !== 'SetRoad') continue;
        const cell = w.grid.get(command.pos);
        if (cell !== undefined) w.grid.set(command.pos, { ...cell, road: command.road });
      }
    };
    lay(roadSegmentCommands(t(5, 10), t(30, 10), 'FourLane', true, false));
    const westRow = Array.from({ length: 20 }, (_, y) => y).find((y) => {
      const road = w.grid.get(t(15, y))?.road;
      return road !== undefined && road.kind !== 'None' && road.dir === 'West';
    });
    expect(westRow, 'a two-way FourLane road has a westbound lane').toBeDefined();
    const route = Array.from({ length: 11 }, (_, i) => t(20 - i, westRow!));
    expect(routeDirectionOk(route, w.grid), 'on the two-way road a westbound route is legal').toBe(true);

    lay(roadSegmentCommands(t(8, 10), t(27, 10), 'FourLane', true, true));
    expect(routeDirectionOk(route, w.grid), 'once one-way East it must be seen as wrong-way').toBe(false);
  });
});
