// The signalized cross scenario that drives the live view (`?scenario=signalized`) and the stage 2b gate.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import { SignalizedCrossScenario } from '../../src/scenarios/signalizedCross';
import { requestState } from '../../src/state';
import { createWorld } from '../../src/world';

describe('signalized cross scenario', () => {
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
