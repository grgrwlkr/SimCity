// The building record of crates/simcity_sim/src/game/buildings/components.rs, the footprint helpers of
// footprint.rs and the kind and density tables of simcity_core map/types.rs. Buildings are records with a
// stable id in spawn order; the building layer of the grid stays the truth about tiles, as in Rust.
import type { BuildingKind, TilePos, ZoneDensity, ZoneKind } from '../commands';
import { wealthCapacityFactor, type WealthClass } from '../economy/wealth';
import type { MapGrid } from '../map/grid';
import { sqrtF32 } from '../math';

const f32 = Math.fround;
const U16_MAX = 0xffff;

export type BuildingPhase = { readonly kind: 'UnderConstruction'; readonly daysRemaining: number } | { readonly kind: 'Operational' };
export const OPERATIONAL: BuildingPhase = { kind: 'Operational' };

/** The density a building grew in and the wealth class of its people, fixed when it spawns. */
export interface BuildingProfile {
  readonly density: ZoneDensity;
  readonly class: WealthClass;
}

export const DEFAULT_PROFILE: BuildingProfile = { density: 'Medium', class: 'Middle' };

export interface Building {
  /** Stable, in spawn order; 0 before the building is added to a world. */
  id: number;
  kind: BuildingKind;
  /** Top-left corner of the footprint. */
  anchor: TilePos;
  width: number;
  length: number;
  level: number;
  phase: BuildingPhase;
  constructionStartDay: number;
  capacityResidents: number;
  capacityJobs: number;
  occupancyResidents: number;
  occupancyJobs: number;
  targetOccupancyResidents: number;
  targetOccupancyJobs: number;
  /** Parking spots inside the footprint (GDD 10.3.4). */
  parkingSpots: TilePos[];
  profile: BuildingProfile;
  /** `NoRoadAccessDecay`. */
  noRoadAccessDecay: { readonly accessLostDay: number } | null;
  /** `LowHappinessDecay`. */
  lowHappinessDecay: { readonly decayStartDay: number; readonly avgHappiness: number } | null;
  /** `EconomicDecay`. */
  economicDecay: { readonly decayStartDay: number; readonly cumulativeLosses: number } | null;
}

export type BuildingSpec = Pick<Building, 'kind' | 'anchor'> & Partial<Omit<Building, 'kind' | 'anchor'>>;

/** A 3×3 operational level-1 building with nothing in it, overridden by `spec`. */
export function newBuilding(spec: BuildingSpec): Building {
  return {
    id: 0,
    width: 3,
    length: 3,
    level: 1,
    phase: OPERATIONAL,
    constructionStartDay: 0,
    capacityResidents: 0,
    capacityJobs: 0,
    occupancyResidents: 0,
    occupancyJobs: 0,
    targetOccupancyResidents: 0,
    targetOccupancyJobs: 0,
    parkingSpots: [],
    profile: DEFAULT_PROFILE,
    noRoadAccessDecay: null,
    lowHappinessDecay: null,
    economicDecay: null,
    ...spec,
  };
}

/** A copy that shares nothing mutable with `b`: phase, profile and decay markers are replaced, never changed in place. */
export function cloneBuilding(b: Building): Building {
  return { ...b, anchor: { ...b.anchor }, parkingSpots: b.parkingSpots.map((spot) => ({ ...spot })) };
}

export function buildingArea(b: Building): number {
  return b.width * b.length;
}

export function isOperational(b: Building): boolean {
  return b.phase.kind === 'Operational';
}

export function footprintTiles(b: Building): TilePos[] {
  const tiles: TilePos[] = [];
  for (let dx = 0; dx < b.width; dx++) {
    for (let dy = 0; dy < b.length; dy++) tiles.push({ x: b.anchor.x + dx, y: b.anchor.y + dy });
  }
  return tiles;
}

export function anyFootprintTile(anchor: TilePos, width: number, length: number, pred: (tile: TilePos) => boolean): boolean {
  for (let dx = 0; dx < width; dx++) {
    for (let dy = 0; dy < length; dy++) if (pred({ x: anchor.x + dx, y: anchor.y + dy })) return true;
  }
  return false;
}

export function allFootprintTiles(anchor: TilePos, width: number, length: number, pred: (tile: TilePos) => boolean): boolean {
  return !anyFootprintTile(anchor, width, length, (tile) => !pred(tile));
}

/** A road on one of the four neighbours of `tile`. */
export function hasAdjacentRoad(grid: MapGrid, tile: TilePos): boolean {
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const idx = grid.idx({ x: tile.x + dx, y: tile.y + dy });
    if (idx !== undefined && grid.roadKind[idx] !== 0) return true;
  }
  return false;
}

/** Residential, commercial and industrial buildings grow in zones; everything else is placed. */
export function isZonedKind(kind: BuildingKind): boolean {
  return kind === 'Residential' || kind === 'Commercial' || kind === 'Industrial';
}

export function buildingKindZone(kind: BuildingKind): ZoneKind {
  return isZonedKind(kind) ? (kind as ZoneKind) : 'None';
}

export function buildingKindFromZone(zone: ZoneKind): BuildingKind | undefined {
  return zone === 'None' ? undefined : zone;
}

/** Days to build (GDD 10.3.3.2): base(kind, level) × √(area / 9), rounded and held to 2..=3 for the fast-build target. */
export function constructionDays(kind: BuildingKind, level: number, area: number): number {
  const base = isZonedKind(kind) ? (level === 2 || level === 3 ? 3 : 2) : 3;
  const days = Math.round(f32(base * sqrtF32(f32(area / 9))));
  return Math.min(Math.max(days, 2), 3);
}

function capacityResidents(kind: BuildingKind): number {
  return kind === 'Residential' ? 4 : 0;
}

function capacityJobs(kind: BuildingKind): number {
  return kind === 'Commercial' ? 3 : kind === 'Industrial' ? 4 : 0;
}

export function capacityResidentsForLevel(kind: BuildingKind, level: number): number {
  if (kind === 'Residential' && level === 2) return 12;
  if (kind === 'Residential' && level === 3) return 30;
  return capacityResidents(kind);
}

export function capacityJobsForLevel(kind: BuildingKind, level: number): number {
  if (kind === 'Commercial') return level === 2 ? 10 : level === 3 ? 25 : 3;
  if (kind === 'Industrial') return level === 2 ? 15 : level === 3 ? 40 : 4;
  return capacityJobs(kind);
}

const scaleU16 = (base: number, factor: number) => Math.min(Math.max(Math.round(f32(base * factor)), 0), U16_MAX);

/** GDD: capacity = base(kind, level) × area / 9. */
export function capacityResidentsForLevelArea(kind: BuildingKind, level: number, area: number): number {
  return scaleU16(capacityResidentsForLevel(kind, level), f32(area / 9));
}

export function capacityJobsForLevelArea(kind: BuildingKind, level: number, area: number): number {
  return scaleU16(capacityJobsForLevel(kind, level), f32(area / 9));
}

/** Shortest and longest footprint side a building of this density takes. */
export function footprintSides(density: ZoneDensity): readonly [number, number] {
  return density === 'Low' ? [3, 4] : [3, 6];
}

/** Lowest and highest level a building of this density reaches. */
export function densityLevels(density: ZoneDensity): readonly [number, number] {
  return density === 'Low' ? [1, 2] : density === 'Medium' ? [1, 3] : [2, 3];
}

/** Residents or jobs a building holds against one of the same size and level in `Medium`. */
export function densityCapacityFactor(density: ZoneDensity): number {
  return density === 'High' ? 2 : 1;
}

/** Height against a building of the same level in `Medium`. */
export function densityHeightFactor(density: ZoneDensity): number {
  return density === 'Low' ? f32(0.8) : density === 'Medium' ? 1 : f32(1.6);
}

/** Residents and jobs a building of this kind, level, area and profile holds. */
export function profileCapacity(kind: BuildingKind, level: number, area: number, profile: BuildingProfile): readonly [number, number] {
  const factor = f32(densityCapacityFactor(profile.density) * wealthCapacityFactor(profile.class));
  return [
    scaleU16(capacityResidentsForLevelArea(kind, level, area), factor),
    scaleU16(capacityJobsForLevelArea(kind, level, area), factor),
  ];
}

/** Reach of a service or civic building, tiles; `undefined` for every other building. */
export function serviceRadius(kind: BuildingKind): number | undefined {
  const radius: Partial<Record<BuildingKind, number>> = { FireStation: 20, PoliceStation: 25, Hospital: 30, School: 18, University: 30, Park: 8 };
  return radius[kind];
}

/** Residents a civic building serves at full strength; `undefined` for every other building. */
export function serviceCapacity(kind: BuildingKind): number | undefined {
  const capacity: Partial<Record<BuildingKind, number>> = { School: 400, University: 1200, Park: 300 };
  return capacity[kind];
}

const BUILD_COSTS: Readonly<Record<BuildingKind, number>> = {
  Residential: 50,
  Commercial: 60,
  Industrial: 80,
  FireStation: 500,
  PoliceStation: 400,
  Hospital: 800,
  PowerPlant: 1000,
  WaterPump: 600,
  Landfill: 400,
  School: 700,
  University: 2000,
  Park: 150,
};

/** What placing a building costs the treasury. */
export function buildCost(kind: BuildingKind): number {
  return BUILD_COSTS[kind];
}

/** Units a utility station supplies to the roads it feeds; `undefined` for every other building. */
export function utilityCapacity(kind: BuildingKind): number | undefined {
  if (kind === 'PowerPlant' || kind === 'WaterPump') return 5000;
  return kind === 'Landfill' ? 4000 : undefined;
}

/** The buildings of a world, in spawn order. */
export class Buildings {
  private nextId = 1;
  private list: Building[] = [];

  /** Adds `b` under a fresh id and returns it. */
  add(b: Building): Building {
    b.id = this.nextId;
    this.nextId += 1;
    this.list.push(b);
    return b;
  }

  get(id: number): Building | undefined {
    return this.list.find((b) => b.id === id);
  }

  all(): readonly Building[] {
    return this.list;
  }

  remove(id: number): void {
    this.list = this.list.filter((b) => b.id !== id);
  }

  clear(): void {
    this.list = [];
  }

  fingerprintState(): unknown {
    return [this.nextId, this.list];
  }
}
