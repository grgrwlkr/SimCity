// Box entry through the whole traffic schedule on a right-hand cross.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import { detectIntersections } from '../../src/intersections/index';
import { buildSignalizedCross, signalizedCrossRoutes } from '../../src/scenarios/signalizedCross';
import { requestState } from '../../src/state';
import { TILE_CENTER_TO_EDGE_TILES } from '../../src/traffic/constants';
import { isIntersectionTile } from '../../src/traffic/state';
import { refSlot, spawnVehicle } from '../../src/traffic/vehicles';
import { createWorld } from '../../src/world';

function uncontrolledCross() {
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

describe('box entry', () => {
  it('grantedCarTakesTheHoldAsItCrossesTheBoundary', () => {
    // The hold on the conflict tiles is taken in the tick the car reaches the box boundary, so a car
    // arriving at speed into an empty box keeps its speed instead of stopping on the line.
    const w = uncontrolledCross();
    const straight = signalizedCrossRoutes(w)[0]!.find((r) => r.tiles.at(-1)!.x === 60)!;
    const approach = straight.tiles.findIndex((t) => isIntersectionTile(w.grid, t)) - 1;
    const speed = 14;
    const ref = spawnVehicle(w, { route: straight.tiles, cursor: approach, progress: TILE_CENTER_TO_EDGE_TILES - 0.05, speed });
    const v = w.vehicles;
    const slot = refSlot(v, ref);
    v.laneletPlan[slot] = { entries: straight.sidecar.map((e) => [e[0], e[1], e[2]] as const), builtFor: w.laneletGraph.version };

    step(w, 1);
    expect(v.progress[slot], 'the car crossed the boundary this tick').toBeGreaterThan(TILE_CENTER_TO_EDGE_TILES);
    expect(v.speed[slot], 'and kept its speed').toBeGreaterThan(speed * 0.8);
    expect(w.reservations.ledger(0)?.holds(ref), 'holding its conflict tiles').toBe(true);
  });
});
