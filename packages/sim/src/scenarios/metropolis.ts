// Stage 3½e: `?scenario=metropolis`, a city of a million on a map of 800 tiles. A grid of streets fourteen tiles apart covers
// the map but for fields at its edge; every sixth street is a four-lane arterial and the one through the middle a six-lane
// boulevard, and the arterials cross lit. Only the arterials run on to the edges of the map: the region comes and goes over
// them. A block between four streets holds four lots, each on a corner of two streets. What stands on a lot goes by how
// far the block is from the centre: towers of homes and offices downtown, dense homes and shops around them, then medium
// ones, then an industrial belt among low houses. Power and water stand in whole blocks on a sparse grid, parks take
// blocks, cafés take lots. The city opens built, full and at work, laid out directly: the growth search is quadratic in
// the buildings of a city this size.
import { densityLevels, profileCapacity } from '../buildings/building';
import { spawnBuilding } from '../buildings/spawn';
import { seedDemoBusRoute } from '../transit/buses';
import {
  BUILDING_KINDS,
  ZONE_DENSITIES,
  ZONE_KINDS,
  type BuildingKind,
  type GameCommand,
  type RoadKind,
  type TilePos,
  type ZoneDensity,
} from '../commands';
import { detectIntersections } from '../intersections/index';
import { applyGameCommandsToGrid } from '../map/apply';
import { bumpVersion } from '../map/dirty';
import { roadLanes } from '../map/roads';
import { roadSegmentCommands } from '../map/roadTool';
import type { RegionalConfig } from '../regional';
import { rangeU32, stdRngSeedFromU64 } from '../rng';
import { updateUtilityNetwork } from '../utilities';
import type { World } from '../world';
import { CitizenTripCounter, LIVING_CITY_LABOUR_SHARE, LIVING_CITY_START_HOUR } from './livingCity';
import { assignNearestJobs, moveInEveryHome } from './prebuild';

export const METROPOLIS_SIZE = 800;
/** The smallest map the plan fits on: six blocks of streets between two arterials. */
export const METROPOLIS_MIN_SIZE = 128;
/** Tiles between the middle lines of neighbouring streets. */
const PITCH = 14;
const ARTERIAL_EVERY = 6;
/** Fields between the outermost streets and the edge of the map, at least. */
const FIELD_TILES = 10;
/** Power stands in the blocks of every sixth column and row of blocks from the second, water from the fifth. */
const STATION_EVERY = 6;
const POWER_OFFSET = 1;
const WATER_OFFSET = 4;
const PARK_SHARE = 0.04;
/** Stage 4: a service lot in every third block of every third row of blocks, fire, police, hospital and school in turn. */
const SERVICE_EVERY = 3;
const SERVICE_KINDS = ['FireStation', 'PoliceStation', 'Hospital', 'School'] as const satisfies readonly BuildingKind[];

/** The region of the metropolis: fewer commuters for its open jobs than the living city has, and more of everything else. */
export const METROPOLIS_REGION: RegionalConfig = {
  commuterCarShare: 0.2,
  visitorsPerDay: 4000,
  throughPerDay: 5000,
  deliveriesPerShop: 2,
  suppliesPerWorks: 3,
  shipmentsPerWorks: 3,
};

interface Line {
  readonly centre: number;
  readonly kind: RoadKind;
}

interface Lot {
  readonly kind: BuildingKind;
  readonly density: ZoneDensity;
}

export interface MetropolisPlan {
  /** A tile of every lit crossing. */
  readonly lights: readonly TilePos[];
  /** How far the street grid reaches: the middle lines of its first and last streets. */
  readonly first: number;
  readonly last: number;
}

/** The streets of one axis, west to east or south to north. */
function streetLines(size: number): Line[] {
  const intervals = Math.max(Math.floor((size - 2 * FIELD_TILES) / PITCH / ARTERIAL_EVERY), 1) * ARTERIAL_EVERY;
  const first = Math.floor((size - intervals * PITCH) / 2);
  const boulevard = Math.round(intervals / 2 / ARTERIAL_EVERY) * ARTERIAL_EVERY;
  return Array.from({ length: intervals + 1 }, (_, i) => ({
    centre: first + i * PITCH,
    kind: i === boulevard ? 'SixLane' : i % ARTERIAL_EVERY === 0 ? 'FourLane' : 'TwoLane',
  }));
}

const half = (line: Line) => roadLanes(line.kind) / 2;
// The road tool covers rows c − half .. c + half − 1 of an eastbound road and columns c − half + 1 .. c + half of a northbound one.
const rowsOf = (line: Line) => [line.centre - half(line), line.centre + half(line) - 1] as const;
const colsOf = (line: Line) => [line.centre - half(line) + 1, line.centre + half(line)] as const;

/** What a lot `ring` of the way from the centre to the edge of the streets holds, by a draw `u` in [0, 1). */
function lotUse(ring: number, u: number): Lot {
  if (ring < 0.2) {
    if (u < 0.35) return { kind: 'Residential', density: 'Tower' };
    if (u < 0.7) return { kind: 'Commercial', density: 'Tower' };
    if (u < 0.9) return { kind: 'Commercial', density: 'High' };
    if (u < 0.95) return { kind: 'Cafe', density: 'Medium' };
    return { kind: 'Residential', density: 'High' };
  }
  if (ring < 0.5) {
    if (u < 0.6) return { kind: 'Residential', density: 'High' };
    if (u < 0.85) return { kind: 'Commercial', density: 'High' };
    if (u < 0.88) return { kind: 'Cafe', density: 'Medium' };
    return { kind: 'Residential', density: 'Medium' };
  }
  if (ring < 0.8) {
    if (u < 0.65) return { kind: 'Residential', density: 'Medium' };
    if (u < 0.77) return { kind: 'Commercial', density: 'Medium' };
    if (u < 0.79) return { kind: 'Cafe', density: 'Medium' };
    return { kind: 'Industrial', density: 'Medium' };
  }
  if (u < 0.7) return { kind: 'Residential', density: 'Low' };
  if (u < 0.72) return { kind: 'Cafe', density: 'Medium' };
  if (u < 0.75) return { kind: 'Commercial', density: 'Low' };
  return { kind: 'Industrial', density: 'Medium' };
}

/** Lays the streets of the metropolis onto `w`'s blank map; the lights are placed by the next frame's commands. */
export function layMetropolisStreets(w: World): MetropolisPlan {
  const grid = w.grid;
  if (grid.width < METROPOLIS_MIN_SIZE || grid.height < METROPOLIS_MIN_SIZE) throw new RangeError(`the metropolis needs a map of ${METROPOLIS_MIN_SIZE} tiles`);
  const columns = streetLines(grid.width);
  const rows = streetLines(grid.height);
  const drive = w.trafficConfig.driveOnRight;
  const west = colsOf(columns[0]!)[0];
  const east = colsOf(columns.at(-1)!)[1];
  const south = rowsOf(rows[0]!)[0];
  const north = rowsOf(rows.at(-1)!)[1];

  // Narrow roads first: the tool never lays a narrower road over a wider one, so each crossing becomes a box of the widest.
  const money = w.city.money;
  for (const kind of ['TwoLane', 'FourLane', 'SixLane'] as const) {
    const commands: GameCommand[] = [];
    for (const line of rows) {
      if (line.kind !== kind) continue;
      const [from, to] = kind === 'TwoLane' ? [west, east] : [0, grid.width - 1];
      commands.push(...roadSegmentCommands({ x: from, y: line.centre }, { x: to, y: line.centre }, kind, drive, false));
    }
    for (const line of columns) {
      if (line.kind !== kind) continue;
      const [from, to] = kind === 'TwoLane' ? [south, north] : [0, grid.height - 1];
      commands.push(...roadSegmentCommands({ x: line.centre, y: from }, { x: line.centre, y: to }, kind, drive, false));
    }
    applyGameCommandsToGrid(w, commands);
  }
  w.city.money = money;
  w.budget.restart(money);
  detectIntersections(w);

  const lights: TilePos[] = [];
  for (const column of columns) {
    for (const row of rows) {
      if (column.kind === 'TwoLane' || row.kind === 'TwoLane') continue;
      const pos = { x: column.centre, y: row.centre };
      lights.push(pos);
      w.commands.push({ kind: 'PlaceTrafficLight', pos });
    }
  }
  return { lights, first: columns[0]!.centre, last: columns.at(-1)!.centre };
}

/** Builds the metropolis on `w`: streets, lots, stations, parks and cafés, open and full, then its people and their jobs. */
export function buildMetropolis(w: World, seed = 13n): MetropolisPlan {
  const plan = layMetropolisStreets(w);
  const grid = w.grid;
  const columns = streetLines(grid.width);
  const rows = streetLines(grid.height);
  const rng = stdRngSeedFromU64(seed);
  const [cx, cy] = [grid.width / 2, grid.height / 2];
  const reach = Math.max((columns.at(-1)!.centre - columns[0]!.centre) / 2, (rows.at(-1)!.centre - rows[0]!.centre) / 2);

  const build = (kind: BuildingKind, density: ZoneDensity, x0: number, y0: number, width: number, length: number) => {
    const zone = kind === 'Residential' || kind === 'Commercial' || kind === 'Industrial' ? kind : 'None';
    for (let y = y0; y < y0 + length; y++) {
      for (let x = x0; x < x0 + width; x++) {
        const i = y * grid.width + x;
        grid.zone[i] = ZONE_KINDS.indexOf(zone);
        grid.density[i] = ZONE_DENSITIES.indexOf(density);
        grid.building[i] = 1 + BUILDING_KINDS.indexOf(kind);
      }
    }
    const profile = { density, class: 'Middle' } as const;
    const b = spawnBuilding(w, { x: x0, y: y0 }, width, length, kind, true, profile);
    if (zone === 'None') return;
    b.level = densityLevels(density)[1];
    [b.capacityResidents, b.capacityJobs] = profileCapacity(kind, b.level, width * length, profile);
    b.occupancyResidents = b.capacityResidents;
    b.targetOccupancyResidents = b.capacityResidents;
    b.occupancyJobs = b.capacityJobs;
    b.targetOccupancyJobs = b.capacityJobs;
  };

  for (let j = 0; j + 1 < rows.length; j++) {
    const y0 = rowsOf(rows[j]!)[1] + 1;
    const y1 = rowsOf(rows[j + 1]!)[0] - 1;
    for (let i = 0; i + 1 < columns.length; i++) {
      const x0 = colsOf(columns[i]!)[1] + 1;
      const x1 = colsOf(columns[i + 1]!)[0] - 1;
      const [width, length] = [x1 - x0 + 1, y1 - y0 + 1];
      const u = rangeU32(rng, 0, 1000) / 1000;
      if (i % STATION_EVERY === POWER_OFFSET && j % STATION_EVERY === POWER_OFFSET) {
        build('PowerPlant', 'Medium', x0, y0, width, length);
        continue;
      }
      if (i % STATION_EVERY === WATER_OFFSET && j % STATION_EVERY === WATER_OFFSET) {
        build('WaterPump', 'Medium', x0, y0, width, length);
        continue;
      }
      if (u < PARK_SHARE) {
        build('Park', 'Medium', x0, y0, width, length);
        continue;
      }
      const ring = Math.max(Math.abs((x0 + x1) / 2 - cx), Math.abs((y0 + y1) / 2 - cy)) / reach;
      const [west, south] = [Math.floor(width / 2), Math.floor(length / 2)];
      // Every third block of every third row holds a service on its first lot, the four kinds in turn.
      const service = i % SERVICE_EVERY === 0 && j % SERVICE_EVERY === 0 ? SERVICE_KINDS[(i / SERVICE_EVERY + j / SERVICE_EVERY) % SERVICE_KINDS.length] : undefined;
      let first = true;
      for (const [lx, lw] of [
        [x0, west],
        [x0 + west, width - west],
      ] as const) {
        for (const [ly, ll] of [
          [y0, south],
          [y0 + south, length - south],
        ] as const) {
          const lot = lotUse(ring, rangeU32(rng, 0, 1000) / 1000);
          if (first && service !== undefined) build(service, 'Medium', lx, ly, lw, ll);
          else build(lot.kind, lot.density, lx, ly, lw, ll);
          first = false;
        }
      }
    }
  }
  w.dirty.markAll();
  w.mapEditVersion = bumpVersion(w.mapEditVersion);
  updateUtilityNetwork(w);
  moveInEveryHome(w);
  assignNearestJobs(w);
  return plan;
}

/** `?scenario=metropolis`: the metropolis at six in the morning, its people about to set out, the region at its edges. */
export class MetropolisScenario extends CitizenTripCounter {
  readonly plan: MetropolisPlan;

  constructor(w: World, seed?: bigint) {
    super();
    // Meso drives the city: its 800 tiles of lane graph and lanelets would take 120 MB for no car.
    w.microTraffic = false;
    w.citizenConfig.labourShare = LIVING_CITY_LABOUR_SHARE;
    Object.assign(w.regionalConfig, METROPOLIS_REGION);
    this.plan = buildMetropolis(w, seed);
    seedDemoBusRoute(w.grid, w.busRoutes);
    w.city.hour = LIVING_CITY_START_HOUR;
  }
}
