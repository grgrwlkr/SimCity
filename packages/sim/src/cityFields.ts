// The data of crates/simcity_sim/src/game/city_fields.rs: crime, fire hazard, health, education and
// attractiveness per tile, and the thresholds growth and decay read. The fields are computed from stage 3c
// on; until then they are not laid over the map, which every reader takes as unmeasured.
import type { BuildingKind, TilePos } from './commands';
import type { WealthClass } from './economy/wealth';
import type { MapGrid } from './map/grid';

const f32 = Math.fround;

export const CITY_FIELDS = ['Crime', 'FireHazard', 'Health', 'Education', 'Attractiveness'] as const;
export type CityField = (typeof CITY_FIELDS)[number];

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

export class CityFields {
  private readonly layers = new Map<CityField, Float32Array>(CITY_FIELDS.map((field) => [field, new Float32Array(0)]));
  /** Bumps once per published chunk. */
  version = 0;

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

  /** Lay every field over a map of `len` tiles, every tile neutral. */
  layOver(len: number): void {
    for (const field of CITY_FIELDS) this.layers.set(field, new Float32Array(len).fill(cityFieldNeutral(field)));
  }

  /** One field over the whole map; the others are laid over it neutral first when the size differs. */
  setValues(field: CityField, values: Float32Array): void {
    if (!this.covers(values.length)) this.layOver(values.length);
    this.layers.set(field, values);
  }

  /** Back to neutral for a new map, so the previous city's fields do not feed growth and decay. */
  resetValues(): void {
    for (const field of CITY_FIELDS) this.values(field).fill(cityFieldNeutral(field));
    this.version += 1;
  }
}

/** The share of a home's contentment crime leaves. */
export function crimeContentment(crime: number): number {
  const lost = f32(Math.max(f32(crime - CRIME_EMPTIES_HOMES_FROM), 0) * CRIME_CONTENTMENT_WEIGHT);
  return Math.min(Math.max(f32(1 - lost), 0), 1);
}

/** A new workplace takes the land's class, but never the high class where the people around are not educated for it. */
export function workplaceClass(land: WealthClass, education: number | undefined): WealthClass {
  return land === 'High' && education !== undefined && education < EDUCATION_FOR_HIGH_JOBS ? 'Middle' : land;
}

/** The attractiveness a zone needs to grow; `undefined` where it grows regardless. */
export function attractivenessToGrow(kind: BuildingKind): number | undefined {
  if (kind === 'Residential') return f32(0.4);
  if (kind === 'Commercial') return f32(0.45);
  return undefined;
}
