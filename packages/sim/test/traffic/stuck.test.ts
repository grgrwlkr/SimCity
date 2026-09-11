// Port of crates/simcity_sim/src/game/traffic/stuck.rs tests: the stuck timer, its cap for waits no
// light cycle serves, and recovery that re-routes before it ever removes a car.
import { describe, expect, it } from 'vitest';
import type { RoadDir, TilePos } from '../../src/commands';
import { STUCK_DESPAWN_SECS, STUCK_REROUTE_SECS, WAITING_EXEMPT_CAP_SECS } from '../../src/traffic/constants';
import { resolveStuckVehicles, updateStuckTimers } from '../../src/traffic/stuck';
import { refSlot, resolveVehicle, spawnVehicle } from '../../src/traffic/vehicles';
import { rebuildRoadGraphInner } from '../../src/transport/roadGraph';
import { createWorld, type World } from '../../src/world';
import { setRoad } from '../transport/helpers';
import { DT } from './helpers';

const t = (x: number, y: number): TilePos => ({ x, y });

function world(roads: ReadonlyArray<readonly [TilePos, RoadDir]>): World {
  const w = createWorld({ mapWidth: 5, mapHeight: 5 });
  for (const [pos, dir] of roads) setRoad(w.grid, pos, { dir });
  rebuildRoadGraphInner(w.grid, 1, w.roadGraph);
  return w;
}

const eastCorridor = () => world([0, 1, 2, 3].map((x) => [t(x, 0), 'East'] as const));

function route(w: World, ref: number): TilePos[] {
  const slot = refSlot(w.vehicles, ref);
  const handle = w.vehicles.pathHandle[slot]!;
  return Array.from({ length: w.pathPool.len(handle) }, (_, i) => w.pathPool.getTile(handle, i)!);
}

describe('stuck recovery', () => {
  it('stuckRecoveryNeverInternsOncomingRoute', () => {
    // A dead end heading East; the oncoming West lane beside it is empty. Recovery must not turn the
    // car onto it: U-turns go only through a box's lanelet.
    const current = t(2, 2);
    const oncoming = t(2, 3);
    const w = world([
      [current, 'East'],
      [oncoming, 'West'],
    ]);
    const car = spawnVehicle(w, {
      route: [current],
      stuck: { secs: STUCK_REROUTE_SECS + 1, lastTile: current, lastProgress: 0 },
    });

    resolveStuckVehicles(w, DT);

    expect(resolveVehicle(w.vehicles, car), 'under the despawn horizon the car survives').toBeDefined();
    for (const tile of route(w, car)) {
      expect(w.grid.get(tile)?.road.dir, `tile (${tile.x},${tile.y}) of the route`).not.toBe('West');
    }
  });

  it('wedgedCarWithADifferingRerouteIsReroutedNotDespawned', () => {
    // Wedged past the despawn horizon on the motion timer, but a real route exists: take it.
    const w = eastCorridor();
    const car = spawnVehicle(w, {
      route: [t(0, 0), t(3, 0)],
      stuck: { secs: 0, lastTile: t(0, 0), lastProgress: 0 },
      motion: { stoppedSecs: STUCK_DESPAWN_SECS + 1 },
    });

    resolveStuckVehicles(w, DT);

    const slot = resolveVehicle(w.vehicles, car);
    expect(slot, 'rerouted onto the escape, not despawned').toBeDefined();
    expect(w.vehicles.pathCursor[slot!], 'the new route starts at its first tile').toBe(0);
    expect(route(w, car).length, 'the degenerate [start, goal] became the full A* route').toBeGreaterThan(2);
  });

  it('waitingPastCapAccumulatesStuckTimer', () => {
    // Waiting at a light keeps the timer at 0 only while a light cycle could still serve the wait.
    const w = eastCorridor();
    const state = { kind: 'WaitingForGreen', intersection: 'box', stopTile: t(2, 0) } as const;
    const [served, refused] = [WAITING_EXEMPT_CAP_SECS - 5, WAITING_EXEMPT_CAP_SECS + 5].map((stoppedSecs) =>
      spawnVehicle(w, {
        route: [t(2, 0), t(3, 0)],
        state,
        stuck: { secs: 0, lastTile: t(2, 0), lastProgress: 0 },
        motion: { stoppedSecs },
      }),
    );

    updateStuckTimers(w, DT);

    expect(w.vehicles.stuckSecs[refSlot(w.vehicles, served!)], 'a wait a cycle can serve stays exempt').toBe(0);
    expect(w.vehicles.stuckSecs[refSlot(w.vehicles, refused!)], 'a wait past the cap accumulates').toBeGreaterThan(0);
  });

  it('carStoppedInCongestionIsNotDespawned', () => {
    // Queued behind a busy downstream with a valid route and not wedged: never removed.
    const w = eastCorridor();
    const car = spawnVehicle(w, {
      route: [t(0, 0), t(1, 0), t(2, 0), t(3, 0)],
      cursor: 1,
      state: { kind: 'Stopped', intersection: 'box', stopTile: t(3, 0), queuePosition: 1 },
      stuck: { secs: STUCK_REROUTE_SECS + 1, lastTile: t(1, 0), lastProgress: 0 },
      motion: { stoppedSecs: 5 },
    });

    resolveStuckVehicles(w, DT);

    expect(resolveVehicle(w.vehicles, car)).toBeDefined();
  });
});
