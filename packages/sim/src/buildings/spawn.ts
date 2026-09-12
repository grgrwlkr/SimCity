// Port of crates/simcity_sim/src/game/buildings/spawn.rs: a new building record and its parking spots.
import type { BuildingKind, TilePos } from '../commands';
import { sqrtF32 } from '../math';
import type { World } from '../world';
import { OPERATIONAL, constructionDays, densityLevels, newBuilding, profileCapacity, type Building, type BuildingProfile } from './building';

const f32 = Math.fround;

/** Parking spots spread over the footprint (GDD 10.3.4): the centre for one, a grid away from the edges for more. */
export function calculateParkingSpots(anchor: TilePos, width: number, length: number, count: number): TilePos[] {
  if (count === 0) return [];
  if (count === 1) return [{ x: anchor.x + Math.trunc((width - 1) / 2), y: anchor.y + Math.trunc((length - 1) / 2) }];
  const cols = Math.ceil(sqrtF32(count));
  const rows = Math.ceil(f32(count / cols));
  const spots: TilePos[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.trunc(i / cols);
    const col = i % cols;
    const xOffset = cols > 1 ? Math.trunc((col * (width - 2)) / Math.max(cols - 1, 1)) + 1 : Math.trunc(width / 2);
    const yOffset = rows > 1 ? Math.trunc((row * (length - 2)) / Math.max(rows - 1, 1)) + 1 : Math.trunc(length / 2);
    spots.push({ x: anchor.x + Math.min(xOffset, width - 1), y: anchor.y + Math.min(yOffset, length - 1) });
  }
  return spots;
}

/**
 * `spawn_building_entity`: a building of `profile` at its density's first level, under construction unless
 * `operational`, with its capacity and parking spots.
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
      phase: operational ? OPERATIONAL : { kind: 'UnderConstruction', daysRemaining: constructionDays(kind, level, area) },
      constructionStartDay: w.city.day,
      capacityResidents,
      capacityJobs,
      parkingSpots: calculateParkingSpots(anchor, width, length, Math.max(Math.trunc(area / 9), 1)),
      profile,
    }),
  );
}
