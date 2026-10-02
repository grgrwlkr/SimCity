// A left turn facing an oncoming stream drives in to its wait point and finishes once the stream is by.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import { detectIntersections } from '../../src/intersections/index';
import { buildSignalizedCross, signalizedCrossRoutes } from '../../src/scenarios/signalizedCross';
import { requestState } from '../../src/state';
import { isIntersectionTile } from '../../src/traffic/state';
import { refSlot, resolveVehicle, spawnVehicle } from '../../src/traffic/vehicles';
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

/** The tile under the vehicle; `undefined` once it is gone. */
function tileOf(w: World, ref: number) {
  const slot = resolveVehicle(w.vehicles, ref);
  return slot === undefined ? undefined : w.pathPool.getTile(w.vehicles.pathHandle[slot]!, w.vehicles.pathCursor[slot]!);
}

describe('left turn wait point', () => {
  it('leftTurnWaitsInsideTheBoxForTheOncomingStream', () => {
    const w = uncontrolledCross();
    const routes = signalizedCrossRoutes(w);
    const left = routes[0]!.find((r) => r.tiles.at(-1)!.x === 41)!;
    const oncoming = routes[1]!.find((r) => r.tiles.at(-1)!.x === 20)!;
    const boxAt = (r: Route) => r.tiles.findIndex((t) => isIntersectionTile(w.grid, t));
    const turn = spawnOn(w, left, boxAt(left) - 1, 0.3, 8);
    const stream = [0, 2, 4].map((back) => spawnOn(w, oncoming, boxAt(oncoming) - 1 - back, 0.2, 10));
    const stopped = 0.05 * w.mapConfig.tileSize;

    let waitedWhileOncomingCrossed = false;
    let finished = false;
    for (let t = 0; t < 400 && !finished; t++) {
      step(w, 1);
      const at = tileOf(w, turn);
      const inside = at !== undefined && isIntersectionTile(w.grid, at);
      const slot = resolveVehicle(w.vehicles, turn);
      const hold = w.reservations.ledger(0)?.holdOf(turn);
      const oncomingTiles = stream.map((ref) => tileOf(w, ref)).filter((s) => s !== undefined && isIntersectionTile(w.grid, s));
      if (inside && hold?.committed === false && slot !== undefined && w.vehicles.speed[slot]! < stopped && oncomingTiles.length > 0) {
        waitedWhileOncomingCrossed = true;
      }
      if (inside) {
        const shared = oncomingTiles.some((s) => s!.x === at.x && s!.y === at.y);
        expect(shared, `tick ${t}: the turn and an oncoming car on one box tile`).toBe(false);
      }
      finished = at === undefined || (at.x === 41 && at.y > 41);
    }
    expect(waitedWhileOncomingCrossed, 'the turn stood at its wait point while an oncoming car crossed').toBe(true);
    expect(finished, 'and then completed the turn').toBe(true);
  });
});
