// A street for the service and emergency tests: a two-lane road on rows 7..8 across a 64×16 map, buildings placed north of
// it with the building tool and open at once, on an hour of a minute so that hours of resolution take seconds to run.
import type { Building } from '../../src/buildings/building';
import type { BuildingKind, TilePos } from '../../src/commands';
import { applyGameCommandsToGrid } from '../../src/map/apply';
import { requestState } from '../../src/state';
import { SECOND_NS } from '../../src/timer';
import { createWorld, type World } from '../../src/world';
import { layRoads, t } from '../meso/helpers';

export { t };

export function street(): World {
  const w = createWorld({ mapWidth: 64, mapHeight: 16, gameHourNs: 60 * SECOND_NS });
  requestState(w, 'InGame');
  layRoads(w, [[t(1, 8), t(62, 8), 'TwoLane']]);
  w.emergencies.baseSpawnChance = 0;
  w.city.money = 1_000_000;
  return w;
}

/** A building of `kind` with its anchor at `pos`, placed as a player places it and opened. */
export function place(w: World, kind: BuildingKind, pos: TilePos): Building {
  applyGameCommandsToGrid(w, [{ kind: 'PlaceBuilding', pos, building: kind }]);
  const b = w.buildings.all().find((x) => x.anchor.x === pos.x && x.anchor.y === pos.y);
  if (b === undefined) throw new Error(`no ${kind} placed at ${pos.x},${pos.y}`);
  b.phase = { kind: 'Operational' };
  return b;
}
