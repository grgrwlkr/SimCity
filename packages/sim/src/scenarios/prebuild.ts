// `?scenario=living` opens built and lived in: on a real-time clock a house takes eight hours to go up, and nobody wants
// to wait a working day for the first commute. Part of the zoned land gets open buildings at full occupancy, their
// citizens move in with jobs and cars, and the rest of the land is left to grow.
import { OPERATIONAL, buildingKindFromZone, densityLevels, footprintTiles, isOperational, profileCapacity, type Building } from '../buildings/building';
import { findBestFootprint } from '../buildings/growth';
import { spawnBuilding } from '../buildings/spawn';
import { SHIFT_MINUTES, WORK_START_WINDOW, newCitizen, spawnCitizensFromResidential } from '../citizens';
import { bumpVersion } from '../map/dirty';
import { tileKey } from '../map/grid';
import { NearestBuildings } from '../nearest';
import { roadCellIsSome } from '../map/roads';
import { CAR_OWNERSHIP, giveCar } from '../parking';
import { randomBool, rangeU32, shuffle, stdRngSeedFromU64 } from '../rng';
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

/**
 * Every open home fills to its occupancy, building by building, with the draws `spawnCitizensFromResidential` makes for a
 * newcomer. The living city moves in eight a home a call, as growth does; a city of a million moves in whole buildings.
 */
export function moveInEveryHome(w: World): void {
  const c = w.citizens;
  const rng = w.simRng;
  const labourShare = w.citizenConfig.labourShare;
  for (const b of w.buildings.all()) {
    if (b.kind !== 'Residential' || !isOperational(b)) continue;
    for (let moving = b.occupancyResidents - c.residentsOf(b.id); moving > 0 && !c.full; moving--) {
      const workStart = rangeU32(rng, WORK_START_WINDOW[0], WORK_START_WINDOW[1]);
      const shiftMinutes = rangeU32(rng, SHIFT_MINUTES[0], SHIFT_MINUTES[1] + 1);
      const worker = labourShare >= 1 || randomBool(rng, labourShare);
      const ref = c.add({ ...newCitizen(b, { workStart, shiftMinutes }), worker });
      if (randomBool(rng, CAR_OWNERSHIP[b.profile.class])) giveCar(w, ref);
    }
  }
}

/**
 * Every citizen in the labour force without a job, in slot order, takes the nearest open one of their home's class as the
 * crow flies, the first building among equals.
 */
export function assignNearestJobs(w: World): void {
  const c = w.citizens;
  const jobs = w.buildings.all().filter((b) => (b.kind === 'Commercial' || b.kind === 'Industrial') && isOperational(b) && b.capacityJobs > 0);
  let open = jobs.length;
  const index = new NearestBuildings(jobs, w.grid.width, w.grid.height);
  for (let slot = 0; slot < c.highWater && open > 0; slot++) {
    if (c.alive[slot] !== 1 || c.worker[slot] !== 1 || c.workplace[slot] !== -1) continue;
    const home = w.buildings.get(c.home[slot]!);
    if (home === undefined) continue;
    const wealth = home.profile.class;
    const best: Building | undefined = index.nearest(home.anchor, 1, (job) => job.profile.class === wealth)[0];
    if (best === undefined) continue;
    c.setWorkplace(slot, best.id);
    if (c.workersOf(best.id) >= best.capacityJobs) {
      index.remove(best);
      open -= 1;
    }
  }
}
