// Port of crates/simcity_sim/src/game/buildings/spawn.rs: a new building record. Its parking is a count by kind and
// capacity from stage 3½b on (`parkingCapacity`); Rust laid out spot tiles inside the footprint that nothing parked on.
import type { BuildingKind, TilePos } from '../commands';
import type { World } from '../world';
import { OPERATIONAL, constructionHours, densityLevels, newBuilding, profileCapacity, type Building, type BuildingProfile } from './building';

/**
 * `spawn_building_entity`: a building of `profile` at its density's first level, under construction unless
 * `operational`, with its capacity.
 */
export function spawnBuilding(
  w: World,
  anchor: TilePos,
  width: number,
  length: number,
  kind: BuildingKind,
  operational: boolean,
  profile: BuildingProfile,
): Building {
  const [level] = densityLevels(profile.density);
  const area = width * length;
  const [capacityResidents, capacityJobs] = profileCapacity(kind, level, area, profile);
  return w.buildings.add(
    newBuilding({
      kind,
      anchor,
      width,
      length,
      level,
      phase: operational ? OPERATIONAL : { kind: 'UnderConstruction', hoursRemaining: constructionHours(kind, level, area) },
      constructionStartDay: w.city.day,
      capacityResidents,
      capacityJobs,
      profile,
    }),
  );
}
