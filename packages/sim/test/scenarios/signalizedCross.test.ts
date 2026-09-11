// The signalized cross scenario that drives the live view (`?scenario=signalized`) and the stage 2b gate.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import type { RoadDir } from '../../src/commands';
import { dirDelta, dirLeft, dirOpposite, dirRight } from '../../src/map/roads';
import { SignalizedCrossScenario, buildSignalizedCross } from '../../src/scenarios/signalizedCross';
import { requestState } from '../../src/state';
import { createWorld } from '../../src/world';

describe('signalized cross scenario', () => {
  it('crossDrivesOnTheRight', () => {
    // Drive on the right: the opposite lane of a two-lane road lies to the driver's left, never to the right.
    const w = createWorld();
    buildSignalizedCross(w.grid);
    const offenders: string[] = [];
    for (let y = 0; y < w.grid.height; y++) {
      for (let x = 0; x < w.grid.width; x++) {
        const dir = w.grid.get({ x, y })!.road.dir;
        if (dir === 'None' || w.grid.get({ x, y })!.road.kind === 'None') continue;
        const side = (d: RoadDir) => {
          const delta = dirDelta(d);
          return w.grid.get({ x: x + delta.x, y: y + delta.y })?.road.dir;
        };
        if (side(dirRight(dir)) === dirOpposite(dir)) offenders.push(`(${x},${y}) ${dir}: oncoming lane on the right`);
        if (side(dirLeft(dir)) !== dirOpposite(dir)) offenders.push(`(${x},${y}) ${dir}: no oncoming lane on the left`);
      }
    }
    expect(offenders.slice(0, 6), `${offenders.length} lane tiles break right-hand traffic`).toEqual([]);
  });

  it('scenarioPlacesTheLightAndSendsWavesThatDrive', () => {
    const w = createWorld();
    requestState(w, 'InGame');
    frame(w, 0);

    const scenario = new SignalizedCrossScenario(w);
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
});
