// The traffic systems' places in the schedule (crates/simcity_sim/src/game/traffic.rs TrafficPlugin,
// intersections/mod.rs IntersectionsPlugin): what runs in which state and what the teardowns clear.
import { describe, expect, it } from 'vitest';
import { applyCommands, runFixedTick, runUpdateGraph } from '../../src/app';
import { applyStateTransition, requestState } from '../../src/state';
import { refSlot } from '../../src/traffic/vehicles';
import { t, trafficWorld, vehicle } from './helpers';

const corridor = () =>
  trafficWorld(
    10,
    1,
    Array.from({ length: 10 }, (_, x) => [t(x, 0), 'East'] as const),
  );
const route = Array.from({ length: 10 }, (_, x) => t(x, 0));

describe('traffic schedule', () => {
  it('vehiclesDriveOnlyInGame', () => {
    const w = corridor();
    const slot = refSlot(w.vehicles, vehicle(w, route, 0, 0, 0, 60, 20, 1));

    w.appState = 'Paused';
    for (let i = 0; i < 10; i++) runFixedTick(w);
    expect(w.vehicles.progress[slot], 'paused: no movement').toBe(0);

    w.appState = 'InGame';
    for (let i = 0; i < 10; i++) runFixedTick(w);
    expect(w.vehicles.pathCursor[slot]! + w.vehicles.progress[slot]!, 'in game the vehicle drives').toBeGreaterThan(0);
    expect(w.vehicles.seq[slot], 'the movement step numbers the vehicle').toBe(1);
    expect(w.trafficOccupancy.perTickVehicles.length, 'occupancy runs in the flow step').toBe(10);
  });

  it('mainMenuTearsDownTraffic', () => {
    const w = corridor();
    vehicle(w, route, 0, 0, 0, 60, 20, 1);
    for (let i = 0; i < 3; i++) runFixedTick(w);
    w.reservations.ledgerMut(0).setInboxLanelet(1);

    requestState(w, 'MainMenu');
    applyStateTransition(w);

    expect(w.vehicles.order).toEqual([]);
    expect(w.reservations.fingerprintState()).toEqual(corridor().reservations.fingerprintState());
    expect(w.trafficIndex.roadTiles).toBe(0);
    expect(w.trafficOccupancy.perTickVehicles.length).toBe(0);
  });

  it('generateMapClearsVehicles', () => {
    const w = corridor();
    vehicle(w, route, 0, 0, 0, 60, 20, 1);
    w.commands.push({ kind: 'GenerateMap', seed: 7n });
    applyCommands(w);
    expect(w.vehicles.order).toEqual([]);
  });

  it('placedLightSyncsAndCycles', () => {
    const w = trafficWorld(5, 5, [
      [t(2, 2), 'None'],
      [t(1, 2), 'East'],
      [t(3, 2), 'East'],
      [t(2, 1), 'South'],
      [t(2, 3), 'South'],
    ]);
    w.graphVersion += 1;
    runUpdateGraph(w);
    w.commands.push({ kind: 'PlaceTrafficLight', pos: t(2, 2) });
    applyCommands(w);
    runUpdateGraph(w);
    expect(w.trafficLights.length, 'the light entity appears after the command').toBe(1);

    const before = w.trafficLights[0]!.phaseTimer;
    runFixedTick(w);
    expect(w.trafficLights[0]!.phaseTimer, 'lights count down on FixedUpdate').not.toBe(before);
  });

  it('placedLightGreenLastsTwentySeconds', () => {
    // Longer than Rust's 10 s: at 10 s a two-lane approach clears only a few cars per green.
    const w = trafficWorld(5, 5, [
      [t(2, 2), 'None'],
      [t(1, 2), 'East'],
      [t(3, 2), 'East'],
      [t(2, 1), 'South'],
      [t(2, 3), 'South'],
    ]);
    w.graphVersion += 1;
    runUpdateGraph(w);
    w.commands.push({ kind: 'PlaceTrafficLight', pos: t(2, 2) });
    applyCommands(w);
    runUpdateGraph(w);
    expect(w.trafficLights[0]).toMatchObject({ greenDuration: 20, yellowDuration: 3, allRedDuration: 4 });
  });
});
