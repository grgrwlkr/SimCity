// The traffic light commands of rust-final crates/simcity_sim/src/game/intersections/lights.rs:151
// (`handle_traffic_light_commands`), handled in TS by `handleTrafficLightCommands` (traffic/lights.ts) in
// COMMAND_APPLY: a light goes on an intersection box and comes off it; anywhere else the command is refused,
// the same rule `previewToolAt` shows the player ("Signals go on intersections").
import { describe, expect, it } from 'vitest';
import { applyCommands, runUpdateGraph } from '../../src/app';
import type { GameCommand, TilePos } from '../../src/commands';
import type { World } from '../../src/world';
import { t, trafficWorld } from '../traffic/helpers';

const BOX: TilePos = t(2, 2);

/** A plus-shaped crossing on a 5×5 map, its intersection index built. */
function crossing(): World {
  const w = trafficWorld(5, 5, [
    [BOX, 'None'],
    [t(1, 2), 'East'],
    [t(3, 2), 'East'],
    [t(2, 1), 'South'],
    [t(2, 3), 'South'],
  ]);
  w.graphVersion += 1;
  runUpdateGraph(w);
  return w;
}

function send(w: World, cmd: GameCommand): void {
  w.commands.push(cmd);
  applyCommands(w);
  runUpdateGraph(w);
}

describe('traffic light commands', () => {
  it('placeTrafficLightPutsALightOnTheIntersection', () => {
    const w = crossing();
    send(w, { kind: 'PlaceTrafficLight', pos: BOX });
    expect(w.intersections.hasTrafficLightAt(BOX)).toBe(true);
    expect(w.intersections.trafficLightKeys.size, 'the light is kept by the stable key').toBe(1);
    expect(w.trafficLights.length, 'the light itself runs').toBe(1);
  });

  it('removeTrafficLightTakesTheLightOff', () => {
    const w = crossing();
    send(w, { kind: 'PlaceTrafficLight', pos: BOX });
    send(w, { kind: 'RemoveTrafficLight', pos: BOX });
    expect(w.intersections.hasTrafficLightAt(BOX)).toBe(false);
    expect(w.intersections.trafficLightKeys.size).toBe(0);
    expect(w.trafficLights.length).toBe(0);
  });

  it('aTrafficLightOffTheIntersectionIsRefused', () => {
    const w = crossing();
    for (const pos of [
      { x: 1, y: 2 },
      { x: 0, y: 0 },
      { x: 9, y: 9 },
    ]) {
      send(w, { kind: 'PlaceTrafficLight', pos });
    }
    expect(w.intersections.trafficLightKeys.size, 'a road tile, bare land and a tile off the map get no light').toBe(0);
    expect(w.trafficLights.length).toBe(0);

    send(w, { kind: 'PlaceTrafficLight', pos: BOX });
    send(w, { kind: 'RemoveTrafficLight', pos: { x: 1, y: 2 } });
    expect(w.intersections.hasTrafficLightAt(BOX), 'removing off the box leaves the box light alone').toBe(true);
  });
});
