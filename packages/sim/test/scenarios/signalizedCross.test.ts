// The signalized cross scenarios that drive the live view (`?scenario=signalized`, `?scenario=signalized4`).
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import type { RoadDir } from '../../src/commands';
import type { MapGrid } from '../../src/map/grid';
import { dirDelta, dirLeft, dirOpposite, dirRight, isLeftmostForDir, isRightmostForDir } from '../../src/map/roads';
import { SignalizedCrossScenario, buildSignalizedCross, signalizedCrossRoutes } from '../../src/scenarios/signalizedCross';
import { requestState } from '../../src/state';
import { isIntersectionTile } from '../../src/traffic/state';
import { resolveVehicle, vehicleRef } from '../../src/traffic/vehicles';
import { createWorld } from '../../src/world';

/** Lane tiles that break right-hand traffic: an oncoming lane to the driver's right, or none to the left. */
function rightHandOffenders(grid: MapGrid): string[] {
  const offenders: string[] = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const road = grid.get({ x, y })!.road;
      if (road.dir === 'None' || road.kind === 'None') continue;
      const dir = road.dir;
      // Sideways across lanes of the same direction: does the road reach an oncoming lane?
      const reachesOncoming = (side: RoadDir) => {
        const d = dirDelta(side);
        for (let p = { x: x + d.x, y: y + d.y }; ; p = { x: p.x + d.x, y: p.y + d.y }) {
          const next = grid.get(p)?.road;
          if (next === undefined || next.kind === 'None' || next.dir === 'None') return false;
          if (next.dir === dirOpposite(dir)) return true;
          if (next.dir !== dir) return false;
        }
      };
      if (reachesOncoming(dirRight(dir))) offenders.push(`(${x},${y}) ${dir}: oncoming lane on the right`);
      if (!reachesOncoming(dirLeft(dir))) offenders.push(`(${x},${y}) ${dir}: no oncoming lane on the left`);
    }
  }
  return offenders;
}

function inGameWorld() {
  const w = createWorld();
  requestState(w, 'InGame');
  frame(w, 0);
  return w;
}

describe('signalized cross scenario', () => {
  it('crossDrivesOnTheRight', () => {
    const w = createWorld();
    buildSignalizedCross(w.grid);
    const offenders = rightHandOffenders(w.grid);
    expect(offenders.slice(0, 6), `${offenders.length} lane tiles break right-hand traffic`).toEqual([]);
  });

  it('fourLaneCrossDrivesOnTheRight', () => {
    const w = createWorld();
    buildSignalizedCross(w.grid, 'fourLane');
    expect(w.grid.get({ x: 30, y: 43 })?.road.kind, 'four lanes per road').toBe('FourLane');
    const offenders = rightHandOffenders(w.grid);
    expect(offenders.slice(0, 6), `${offenders.length} lane tiles break right-hand traffic`).toEqual([]);
  });

  it('fourLaneRoutesKeepLaneDiscipline', () => {
    // ПДД 8.5: a left turn from the lane by the centerline, a right turn from the curb lane, straight on from both.
    const w = inGameWorld();
    const scenario = new SignalizedCrossScenario(w, 1_000_000, 'fourLane');
    scenario.advance(w);
    step(w, 1);
    const routes = signalizedCrossRoutes(w, 'fourLane');
    const kinds: string[] = [];
    for (const set of routes) {
      for (const route of set) {
        const box = route.tiles.findIndex((t) => isIntersectionTile(w.grid, t));
        const approach = w.grid.get(route.tiles[box - 1]!)!.road;
        const exit = w.grid.get(route.tiles.at(-1)!)!.road;
        if (exit.dir === dirLeft(approach.dir)) {
          expect(isLeftmostForDir(approach), `${approach.dir} left turn from lane ${approach.lane}`).toBe(true);
          kinds.push(`${approach.dir} left`);
        } else if (exit.dir === dirRight(approach.dir)) {
          expect(isRightmostForDir(approach), `${approach.dir} right turn from lane ${approach.lane}`).toBe(true);
          kinds.push(`${approach.dir} right`);
        } else {
          expect(exit.dir, 'no U-turns').toBe(approach.dir);
          expect(exit.lane, 'a straight keeps its lane').toBe(approach.lane);
          kinds.push(`${approach.dir} straight ${approach.lane}`);
        }
      }
    }
    expect(kinds.sort()).toEqual(
      ['East', 'West', 'North', 'South']
        .flatMap((d) => {
          const lanes = { East: [0, 1], West: [2, 3], North: [0, 1], South: [2, 3] }[d]!;
          return [`${d} left`, `${d} right`, ...lanes.map((l) => `${d} straight ${l}`)];
        })
        .sort(),
    );
  });

  it('scenarioPlacesTheLightAndSendsWavesThatDrive', () => {
    const w = inGameWorld();
    const scenario = new SignalizedCrossScenario(w, 50);
    for (let i = 0; i < 120; i++) {
      scenario.advance(w);
      step(w, 1);
    }

    expect(w.trafficLights.length, 'the light is placed on the box').toBe(1);
    expect(w.trafficLights[0]!.pos).toEqual({ x: 40, y: 40 });
    // Routes exist once the lanelets are built on the first tick; waves then leave every 50 ticks.
    expect(scenario.spawned, 'waves at ticks 1, 51 and 101').toBe(12);
    const v = w.vehicles;
    expect(v.order.some((slot) => v.pathCursor[slot]! > 0), 'vehicles drive along their routes').toBe(true);
  });

  // At the default rate a car is through the cross and off the map within 120 s of spawning: its 35–40 s
  // trip, a whole 58 s light cycle and the queue ahead of it. A jam breaks this within the five minutes.
  it.each([
    ['twoLane', 4],
    ['fourLane', 16],
  ] as const)('%sScenarioDoesNotJam', (layout, boxTiles) => {
    const w = inGameWorld();
    const scenario = new SignalizedCrossScenario(w, undefined, layout);
    const bornAt = new Map<number, number>();
    for (let i = 0; i < 3000; i++) {
      scenario.advance(w);
      step(w, 1);
      for (const slot of w.vehicles.order) {
        const ref = vehicleRef(w.vehicles, slot);
        if (!bornAt.has(ref)) bornAt.set(ref, w.tick);
      }
    }
    expect(w.intersections.clusters[0]?.tiles.length, 'the box').toBe(boxTiles);
    expect(w.trafficLights.length, 'the light is placed on the box').toBe(1);
    expect(scenario.spawned, 'the scenario sends traffic').toBeGreaterThanOrEqual(100);
    const overdue = [...bornAt].filter(([ref, born]) => w.tick - born > 1200 && resolveVehicle(w.vehicles, ref) !== undefined);
    expect(overdue.length, `cars older than 120 s still on the map (of ${bornAt.size})`).toBe(0);
  });
});
