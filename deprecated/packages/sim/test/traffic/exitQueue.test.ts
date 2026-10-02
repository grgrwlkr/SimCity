// ПДД 13.2: no car is let into a box whose exit is a standing queue, where it would stop across the
// crossing traffic. The city at 2000 commuters had cars standing minutes in boxes behind exit queues.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import { detectIntersections } from '../../src/intersections/index';
import { buildSignalizedCross, signalizedCrossRoutes } from '../../src/scenarios/signalizedCross';
import { requestState } from '../../src/state';
import { arbitrateLaneletReservations } from '../../src/traffic/arbiter';
import { buildTrafficSpatialIndex } from '../../src/traffic/spatialIndex';
import { isIntersectionTile } from '../../src/traffic/state';
import { refSlot, spawnVehicle } from '../../src/traffic/vehicles';
import type { Route } from '../../src/transport/lanelet/pathfinding';
import { createWorld, type World } from '../../src/world';

function uncontrolledCross(): World {
  const w = createWorld();
  requestState(w, 'InGame');
  frame(w, 0);
  buildSignalizedCross(w.grid);
  w.graphVersion += 1;
  w.mapEditVersion += 1;
  detectIntersections(w);
  step(w, 1);
  return w;
}

function spawnOn(w: World, route: Route, cursor: number, progress: number, speed: number): number {
  const ref = spawnVehicle(w, { route: route.tiles, cursor, progress, speed });
  w.vehicles.laneletPlan[refSlot(w.vehicles, ref)] = {
    entries: route.sidecar.map((e) => [e[0], e[1], e[2]] as const),
    builtFor: w.laneletGraph.version,
  };
  return ref;
}

describe('box entry and the exit queue', () => {
  it('noGrantIntoTheBoxWhileItsExitIsAStandingQueue', () => {
    const w = uncontrolledCross();
    const straight = signalizedCrossRoutes(w)[0]!.find((r) => r.tiles.at(-1)!.y === r.tiles[0]!.y)!;
    const boxAt = straight.tiles.findIndex((tile) => isIntersectionTile(w.grid, tile));
    let exitAt = boxAt;
    while (isIntersectionTile(w.grid, straight.tiles[exitAt]!)) exitAt += 1;
    const id = w.intersections.intersectionIdAt(straight.tiles[boxAt]!)!;
    const car = spawnOn(w, straight, boxAt - 1, 0.3, 0);
    const queue = [0.25, 0.75].map((progress) => spawnOn(w, straight, exitAt, progress, 0));

    buildTrafficSpatialIndex(w);
    arbitrateLaneletReservations(w);
    expect(w.reservations.entryReservation(id, car), 'two cars stand on the exit tile').toBeUndefined();

    for (const ref of queue) w.vehicles.speed[refSlot(w.vehicles, ref)] = 8;
    buildTrafficSpatialIndex(w);
    arbitrateLaneletReservations(w);
    expect(w.reservations.entryReservation(id, car), 'the queue drives off: the box may be entered').toBeDefined();
  });
});
