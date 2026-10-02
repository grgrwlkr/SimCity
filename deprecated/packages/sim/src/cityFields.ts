// Port of crates/simcity_sim/src/game/city_fields.rs: crime, fire hazard, health, education and attractiveness per tile,
// the thresholds growth and decay read, and the formulas each field is computed by. `cityFieldsCompute.ts` runs them over
// the map a chunk a tick (stage 4); until a tile's first pass it holds the neutral value, which every reader takes as
// unmeasured.
import { PARK_HEALTH, SCHOOL_EDUCATION, UNIVERSITY_EDUCATION } from './civicCoverage';
import type { BuildingKind, TilePos } from './commands';
import type { WealthClass } from './economy/wealth';
import type { MapGrid } from './map/grid';

const f32 = Math.fround;
const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

export const CITY_FIELDS = ['Crime', 'FireHazard', 'Health', 'Education', 'Attractiveness'] as const;
export type CityField = (typeof CITY_FIELDS)[number];

/** Tiles recomputed a tick. */
export const CITY_FIELDS_CHUNK_TILES = 64;

/** What a tile holds before its first pass: middling, so an unmeasured field neither blocks nor grants anything. */
export function cityFieldNeutral(field: CityField): number {
  switch (field) {
    case 'Crime':
    case 'FireHazard':
      return f32(0.25);
    case 'Health':
    case 'Attractiveness':
      return f32(0.6);
    case 'Education':
      return 0.5;
  }
}

/** Crime a district tolerates before its land value starts to fall. */
export const CRIME_TOLERATED = f32(0.3);
/** Land value lost per unit of crime above what is tolerated. */
export const CRIME_LAND_VALUE_WEIGHT = f32(0.4);
/** Crime above which people start leaving their homes. */
export const CRIME_EMPTIES_HOMES_FROM = f32(0.4);
/** Contentment a home loses per unit of crime above that. */
export const CRIME_CONTENTMENT_WEIGHT = f32(1.5);
/** Mean fire hazard over a footprint at which a building may no longer rise. */
export const FIRE_HAZARD_LIMIT = f32(0.6);
/** Mean health over a footprint a home needs to reach level 3. */
export const HEALTH_FOR_LEVEL_THREE = 0.5;
/** Mean education over a workplace's footprint it needs to take the high class. */
export const EDUCATION_FOR_HIGH_JOBS = f32(0.45);
/** Homes within this many tiles along the axes shape a tile's education (Rust: as the crow flies). */
export const EDUCATION_RADIUS = 12;

/** The land value crime above what a district tolerates takes off a tile. */
export function crimeLandValuePenalty(crime: number): number {
  return f32(Math.max(f32(crime - CRIME_TOLERATED), 0) * CRIME_LAND_VALUE_WEIGHT);
}

export class CityFields {
  private readonly layers = new Map<CityField, Float32Array>(CITY_FIELDS.map((field) => [field, new Float32Array(0)]));
  /** Bumps once per published chunk. */
  version = 0;
  readonly chunkSize = CITY_FIELDS_CHUNK_TILES;
  /** The chunk recomputed next; the one published last is the one before it, wrapping. */
  currentChunk = 0;
  /** Per tile, the schooling the homes within reach bring, weighted by their residents and nearness, and that weight. */
  schooled = new Float32Array(0);
  people = new Float32Array(0);
  /** The buildings, the day and the map size the two layers above were summed for. */
  homesKey = '';

  /** Tiles the fields are laid over. */
  get tiles(): number {
    return this.values('Crime').length;
  }

  values(field: CityField): Float32Array {
    return this.layers.get(field)!;
  }

  get(field: CityField, idx: number): number {
    const values = this.values(field);
    return idx < values.length ? values[idx]! : cityFieldNeutral(field);
  }

  /** Whether the fields are laid over a map of `len` tiles. */
  covers(len: number): boolean {
    return len > 0 && CITY_FIELDS.every((field) => this.values(field).length === len);
  }

  /** The mean of `field` over a footprint; `undefined` until the fields cover the map. */
  footprintMean(field: CityField, grid: MapGrid, anchor: TilePos, width: number, length: number): number | undefined {
    if (!this.covers(grid.len())) return undefined;
    let sum = 0;
    let tiles = 0;
    for (let dy = 0; dy < length; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const idx = grid.idx({ x: anchor.x + dx, y: anchor.y + dy });
        if (idx === undefined) continue;
        sum = f32(sum + this.get(field, idx));
        tiles += 1;
      }
    }
    return tiles > 0 ? f32(sum / tiles) : undefined;
  }

  /** Lay every field over a map of `len` tiles, every tile neutral, and start the pass over. */
  layOver(len: number): void {
    for (const field of CITY_FIELDS) this.layers.set(field, new Float32Array(len).fill(cityFieldNeutral(field)));
    this.currentChunk = 0;
  }

  /** One field over the whole map; the others are laid over it neutral first when the size differs. */
  setValues(field: CityField, values: Float32Array): void {
    if (!this.covers(values.length)) this.layOver(values.length);
    this.layers.set(field, values);
  }

  /** Back to neutral for a new map, so the previous city's fields do not feed growth and decay. */
  resetValues(): void {
    for (const field of CITY_FIELDS) this.values(field).fill(cityFieldNeutral(field));
    this.currentChunk = 0;
    this.homesKey = '';
    this.version += 1;
  }
}

/** What one tile's fields are computed from. */
export interface TileInputs {
  /** A zoned building stands on the tile. */
  readonly built: boolean;
  readonly industrial: boolean;
  readonly zoned: boolean;
  readonly police: boolean;
  readonly fireCover: boolean;
  readonly medical: boolean;
  /** A road with garbage collection lies within zone depth. */
  readonly garbage: boolean;
  readonly pollution: number;
  readonly landValue: number;
  /** The city's share of workers without a job. */
  readonly unemployment: number;
  /** How strongly a school, a university and a park reach the tile, each 0..1. */
  readonly school: number;
  readonly university: number;
  readonly park: number;
}

export const noInputs = (): TileInputs => ({
  built: false,
  industrial: false,
  zoned: false,
  police: false,
  fireCover: false,
  medical: false,
  garbage: false,
  pollution: 0,
  landValue: 0,
  unemployment: 0,
  school: 0,
  university: 0,
  park: 0,
});

/** A home as education sees it: the middle of its footprint, tile coordinates. */
export interface EducationHome {
  readonly centerX: number;
  readonly centerY: number;
  readonly residents: number;
  readonly wealth: WealthClass;
}

const flag = (on: boolean) => (on ? 1 : 0);

/** Crime: people bring it, unemployment feeds it, police keep it down. */
export function crime(i: TileInputs): number {
  const activity = i.built ? 1 : i.zoned ? 0.5 : 0;
  return f32(clamp01(0.15 + 0.35 * activity + 0.25 * i.unemployment - 0.4 * flag(i.police)));
}

/** Fire hazard: buildings burn, industry most of all, and a fire station's cover makes them safe. */
export function fireHazard(i: TileInputs): number {
  return f32(clamp01(0.1 + 0.25 * flag(i.built) + 0.35 * flag(i.industrial) + 0.3 * i.pollution - 0.45 * flag(i.fireCover)));
}

/** Health: a hospital's cover, garbage collection and a park raise it, pollution takes it away. */
export function health(i: TileInputs): number {
  return f32(clamp01(0.45 + 0.3 * flag(i.medical) + 0.15 * flag(i.garbage) + PARK_HEALTH * i.park - 0.5 * i.pollution));
}

/** How much schooling a class brings from home. */
export function schooling(wealth: WealthClass): number {
  return wealth === 'Low' ? 0 : wealth === 'Middle' ? 0.5 : 1;
}

/** How near a home centred at (`cx`, `cy`) is to the middle of `tile`: 1 on it, 0 from `EDUCATION_RADIUS` along the axes on. */
export function educationNearness(tileX: number, tileY: number, cx: number, cy: number): number {
  return 1 - (Math.abs(tileX + 0.5 - cx) + Math.abs(tileY + 0.5 - cy)) / EDUCATION_RADIUS;
}

/** Education: the schooling of the homes within reach, weighted by their residents and nearness. Nobody within reach reads as none. */
export function education(tile: TilePos, homes: readonly EducationHome[]): number {
  let schooled = 0;
  let people = 0;
  for (const home of homes) {
    const nearness = educationNearness(tile.x, tile.y, home.centerX, home.centerY);
    if (nearness <= 0) continue;
    const weight = nearness * home.residents;
    schooled += weight * schooling(home.wealth);
    people += weight;
  }
  return people > 0 ? f32(clamp01(schooled / people)) : 0;
}

/** Education with schools: what the homes around bring, plus what the schools and universities reaching the tile teach. */
export function educationWithSchools(fromHomes: number, i: TileInputs): number {
  return f32(clamp01(fromHomes + SCHOOL_EDUCATION * i.school + UNIVERSITY_EDUCATION * i.university));
}

/** Attractiveness: what a place is worth, less its crime and pollution, plus its health and education. */
export function attractiveness(landValue: number, crimeLevel: number, healthLevel: number, educationLevel: number, pollution: number): number {
  return f32(clamp01(0.4 * landValue + 0.2 * (1 - crimeLevel) + 0.2 * healthLevel + 0.1 * educationLevel + 0.1 * (1 - pollution)));
}

/** The share of a home's contentment crime leaves. */
export function crimeContentment(crimeLevel: number): number {
  const lost = f32(Math.max(f32(crimeLevel - CRIME_EMPTIES_HOMES_FROM), 0) * CRIME_CONTENTMENT_WEIGHT);
  return Math.min(Math.max(f32(1 - lost), 0), 1);
}

/** A new workplace takes the land's class, but never the high class where the people around are not educated for it. */
export function workplaceClass(land: WealthClass, educationLevel: number | undefined): WealthClass {
  return land === 'High' && educationLevel !== undefined && educationLevel < EDUCATION_FOR_HIGH_JOBS ? 'Middle' : land;
}

/** The attractiveness a zone needs to grow; `undefined` where it grows regardless. */
export function attractivenessToGrow(kind: BuildingKind): number | undefined {
  if (kind === 'Residential') return f32(0.4);
  if (kind === 'Commercial') return f32(0.45);
  return undefined;
}
