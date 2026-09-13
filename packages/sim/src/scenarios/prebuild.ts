// `?scenario=living` opens built and lived in: on a real-time clock a house takes eight hours to go up, and nobody wants
// to wait a working day for the first commute. Part of the zoned land gets open buildings at full occupancy, their
// citizens move in with jobs and cars, and the rest of the land is left to grow.
import { OPERATIONAL, buildingKindFromZone, densityLevels, footprintTiles, isOperational, profileCapacity, type Building } from '../buildings/building';
import { findBestFootprint } from '../buildings/growth';
import { spawnBuilding } from '../buildings/spawn';
import { spawnCitizensFromResidential } from '../citizens';
import { bumpVersion } from '../map/dirty';
import { tileKey } from '../map/grid';
import { roadCellIsSome } from '../map/roads';
import { shuffle, stdRngSeedFromU64 } from '../rng';
import { updateUtilityNetwork } from '../utilities';
import type { World } from '../world';

/** Share of the zoned land built on before the game starts. */
export const PREBUILT_SHARE = 0.6;

export interface PrebuildOptions {
  readonly share?: number;
  /** The lots are picked from the scenario's own seed, so the simulation's generators see none of it. */
  readonly seed?: bigint;
}

/** Builds on `share` of the zoned land, open and full, and moves the citizens in with the nearest jobs of their class. */
export function prebuildCity(w: World, options: PrebuildOptions = {}): void {
  const grid = w.grid;
  // The stations and places already laid out stand open in an established city.
  for (const b of w.buildings.all()) b.phase = OPERATIONAL;
  const seeds: number[] = [];
  for (let idx = 0; idx < grid.len(); idx++) {
    const cell = grid.cellAt(idx);
    if (cell.zone !== 'None' && !cell.water && !roadCellIsSome(cell.road)) seeds.push(idx);
  }
  const target = Math.floor(seeds.length * (options.share ?? PREBUILT_SHARE));
  shuffle(stdRngSeedFromU64(options.seed ?? 11n), seeds);

  const occupied = new Set<number>();
  for (const b of w.buildings.all()) for (const tile of footprintTiles(b)) occupied.add(tileKey(tile));
  let built = 0;
  for (const idx of seeds) {
    if (built >= target) break;
    const cell = grid.cellAt(idx);
    const kind = buildingKindFromZone(cell.zone);
    if (kind === undefined || cell.building !== null) continue;
    const seed = { x: idx % grid.width, y: Math.trunc(idx / grid.width) };
    const footprint = findBestFootprint(w, seed, kind, cell.density, occupied, w.buildings.all(), true);
    if (footprint === undefined) continue;
    for (const tile of footprint.tiles) {
      grid.set(tile, { ...grid.get(tile)!, building: kind });
      w.dirty.mark(grid.idx(tile)!);
      occupied.add(tileKey(tile));
    }
    // One class for the whole planned city: land value is not measured yet, and a worker takes only a job of their class.
    const profile = { density: cell.density, class: 'Middle' } as const;
    const b = spawnBuilding(w, footprint.anchor, footprint.width, footprint.length, kind, true, profile);
    // An established city: its buildings stand at the top level of their density (at level 1 the city held 946 people).
    b.level = densityLevels(cell.density)[1];
    [b.capacityResidents, b.capacityJobs] = profileCapacity(kind, b.level, footprint.width * footprint.length, profile);
    b.occupancyResidents = b.capacityResidents;
    b.targetOccupancyResidents = b.capacityResidents;
    b.occupancyJobs = b.capacityJobs;
    b.targetOccupancyJobs = b.capacityJobs;
    built += footprint.tiles.length;
  }
  w.mapEditVersion = bumpVersion(w.mapEditVersion);
  updateUtilityNetwork(w);

  // Eight move into a home a call: call until every home is full.
  for (let before = -1; before !== w.citizens.count; ) {
    before = w.citizens.count;
    spawnCitizensFromResidential(w);
  }
  assignNearestJobs(w);
}

/** Every citizen without a job takes the nearest open one of their home's class, as the crow flies. */
function assignNearestJobs(w: World): void {
  const c = w.citizens;
  let open = w.buildings.all().filter((b) => (b.kind === 'Commercial' || b.kind === 'Industrial') && isOperational(b) && b.capacityJobs > 0);
  for (let slot = 0; slot < c.highWater && open.length > 0; slot++) {
    if (c.alive[slot] !== 1 || c.workplace[slot] !== -1) continue;
    const home = w.buildings.get(c.home[slot]!);
    if (home === undefined) continue;
    let best: Building | undefined;
    let bestDistance = Infinity;
    for (const job of open) {
      if (job.profile.class !== home.profile.class) continue;
      const distance = Math.abs(job.anchor.x - home.anchor.x) + Math.abs(job.anchor.y - home.anchor.y);
      if (distance < bestDistance) {
        best = job;
        bestDistance = distance;
      }
    }
    if (best === undefined) continue;
    c.setWorkplace(slot, best.id);
    if (c.workersOf(best.id) >= best.capacityJobs) open = open.filter((job) => job !== best);
  }
}
