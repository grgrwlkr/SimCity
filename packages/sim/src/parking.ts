// Stage 3½b: where cars stand. A citizen's car that is not driving is not a vehicle: it holds a spot inside a building —
// as many as the building's kind, capacity and garage give — or on a lane tile of an ordinary street, and the spots
// taken are counted here. Rust kept every parked car as an entity on the road it arrived on.
import { isOperational, type Building } from './buildings/building';
import type { TilePos } from './commands';
import type { WealthClass } from './economy/wealth';
import type { MapGrid } from './map/grid';
import { footprintEntrance } from './transport/anchors';
import type { World } from './world';

const f32 = Math.fround;

/**
 * Cars per resident by the class of their home, about one in two on the whole: 560 cars per 1 000 people in the EU
 * (Eurostat, 2022) and 847 light vehicles in the US (FHWA, 2022), fewer among the poor.
 */
export const CAR_OWNERSHIP: Readonly<Record<WealthClass, number>> = { Low: 0.3, Middle: 0.55, High: 0.75 };

export const CAR_STATUSES = ['None', 'Parked', 'Driving'] as const;
export type CarStatus = (typeof CAR_STATUSES)[number];
export const CAR_NONE = 0;
export const CAR_PARKED = 1;
export const CAR_DRIVING = 2;

/** How citizens get about; a constant until the RON loader, tests and scenarios change it in place. */
export interface CitizenConfig {
  /** Trips up to this long are walked. */
  walkMaxMeters: number;
  /** A car parks no farther from where its citizen goes than this, unless the trip is too long to walk. */
  parkingWalkMeters: number;
  /** A trip past this long drives to the nearest spot farther away when none is in reach; a shorter one is walked. */
  farParkingTripMeters: number;
  walkKmh: number;
  /** Share of newcomers in the labour force, working or looking for work; the rest are children, students and retirees. */
  labourShare: number;
  /** The chances of the stops a day's agenda holds besides work. */
  agenda: AgendaChances;
}

/** The chances of the stops of a day, each drawn on its own. */
export interface AgendaChances {
  /** A worker stops at a café on the way to work. */
  cafeBeforeWork: number;
  /** After work, before home, in any order. */
  shopAfterWork: number;
  parkAfterWork: number;
  cafeAfterWork: number;
  /** A worker goes out again in the evening, to the park or a café. */
  eveningOuting: number;
  /** A citizen without work goes out in the morning, and in the afternoon. */
  freeMorningTour: number;
  freeAfternoonTour: number;
}

export const DEFAULT_AGENDA: AgendaChances = {
  cafeBeforeWork: 0.15,
  shopAfterWork: 0.3,
  parkAfterWork: 0.15,
  cafeAfterWork: 0.15,
  eveningOuting: 0.2,
  freeMorningTour: 0.6,
  freeAfternoonTour: 0.5,
};

/** Work and home only. */
export const NO_OUTINGS: AgendaChances = {
  cafeBeforeWork: 0,
  shopAfterWork: 0,
  parkAfterWork: 0,
  cafeAfterWork: 0,
  eveningOuting: 0,
  freeMorningTour: 0,
  freeAfternoonTour: 0,
};

export const defaultCitizenConfig = (): CitizenConfig => ({
  walkMaxMeters: 1000,
  parkingWalkMeters: 400,
  farParkingTripMeters: 3000,
  walkKmh: 5,
  labourShare: 1,
  agenda: { ...DEFAULT_AGENDA },
});

/** A spot is addressed by a number: a building by its id, from 1; a street lane tile by `-(tile index + 1)`; 0 is none. */
export const NO_PLACE = 0;
export const buildingPlace = (id: number): number => id;
export const streetPlace = (tile: number): number => -(tile + 1);
const isStreet = (place: number) => place < 0;
const streetTile = (place: number) => -place - 1;

/** A side of a bucket of the spot search, tiles. */
const BUCKET_TILES = 8;
/** The widest footprint side: a building in a bucket reaches this far out of it. */
const FOOTPRINT_REACH = 8;

/** Spots inside `b`: a home's residents × their share of cars × 1.1, a shop's jobs × 1.5, a works' × 0.8, a third of any other footprint; plus the garage. */
export function parkingCapacity(b: Building): number {
  let spots: number;
  if (b.kind === 'Residential') spots = Math.round(f32(f32(b.capacityResidents * f32(CAR_OWNERSHIP[b.profile.class])) * f32(1.1)));
  else if (b.kind === 'Commercial') spots = Math.round(f32(b.capacityJobs * f32(1.5)));
  else if (b.kind === 'Industrial') spots = Math.round(f32(b.capacityJobs * f32(0.8)));
  else spots = Math.trunc((b.width * b.length) / 3);
  return spots + b.parkingGarage;
}

/** One spot on each lane tile of a two- or four-lane road, outside the boxes of intersections. */
function streetSpots(grid: MapGrid, tile: number): number {
  const kind = grid.roadKind[tile]!;
  return (kind === 1 || kind === 2) && grid.roadDir[tile] !== 0 && grid.water[tile] === 0 ? 1 : 0;
}

/** The spots taken, and the buckets the search walks. */
export class Parking {
  /** Spots taken by building id. */
  readonly buildings = new Map<number, number>();
  /** Spots taken by street tile index. */
  readonly streets: Uint8Array;
  private indexKey = '';
  private bucketsW = 0;
  private bucketsH = 0;
  private buildingBuckets: number[][] = [];
  private streetBuckets: number[][] = [];

  constructor(tiles: number) {
    this.streets = new Uint8Array(tiles);
  }

  usedAt(place: number): number {
    return isStreet(place) ? (this.streets[streetTile(place)] ?? 0) : (this.buildings.get(place) ?? 0);
  }

  totalUsed(): number {
    let used = 0;
    for (const n of this.buildings.values()) used += n;
    for (const n of this.streets) used += n;
    return used;
  }

  take(place: number): void {
    if (isStreet(place)) this.streets[streetTile(place)] = this.usedAt(place) + 1;
    else this.buildings.set(place, this.usedAt(place) + 1);
  }

  release(place: number): void {
    const left = Math.max(this.usedAt(place) - 1, 0);
    if (isStreet(place)) this.streets[streetTile(place)] = left;
    else if (left === 0) this.buildings.delete(place);
    else this.buildings.set(place, left);
  }

  clear(): void {
    this.buildings.clear();
    this.streets.fill(0);
    this.indexKey = '';
  }

  /** The buckets, rebuilt when the roads or the buildings changed. */
  index(w: World): { readonly w: number; readonly h: number; readonly buildings: number[][]; readonly streets: number[][] } {
    const grid = w.grid;
    const key = `${grid.width}x${grid.height}|${w.graphVersion}|${w.mapEditVersion}|${w.buildings.version}`;
    if (key !== this.indexKey) {
      this.indexKey = key;
      this.bucketsW = Math.floor((grid.width + BUCKET_TILES - 1) / BUCKET_TILES);
      this.bucketsH = Math.floor((grid.height + BUCKET_TILES - 1) / BUCKET_TILES);
      this.buildingBuckets = Array.from({ length: this.bucketsW * this.bucketsH }, () => []);
      this.streetBuckets = Array.from({ length: this.bucketsW * this.bucketsH }, () => []);
      const bucketOf = (x: number, y: number) => Math.floor(y / BUCKET_TILES) * this.bucketsW + Math.floor(x / BUCKET_TILES);
      for (const b of w.buildings.all()) this.buildingBuckets[bucketOf(b.anchor.x, b.anchor.y)]?.push(b.id);
      for (let tile = 0; tile < grid.len(); tile++) {
        if (streetSpots(grid, tile) > 0) this.streetBuckets[bucketOf(tile % grid.width, Math.floor(tile / grid.width))]!.push(tile);
      }
    }
    return { w: this.bucketsW, h: this.bucketsH, buildings: this.buildingBuckets, streets: this.streetBuckets };
  }
}

function hasFreeSpot(w: World, b: Building): boolean {
  return isOperational(b) && w.parking.usedAt(buildingPlace(b.id)) < parkingCapacity(b);
}

const footprintDistance = (near: TilePos, b: Building) => {
  const dx = near.x < b.anchor.x ? b.anchor.x - near.x : Math.max(near.x - (b.anchor.x + b.width - 1), 0);
  const dy = near.y < b.anchor.y ? b.anchor.y - near.y : Math.max(near.y - (b.anchor.y + b.length - 1), 0);
  return dx + dy;
};

/** The nearest free spot within `maxTiles` of `near` of the kinds asked for; ties go to buildings, then the lower id or tile. */
function nearestFree(w: World, near: TilePos, maxTiles: number, buildings: boolean, streets: boolean): number {
  const index = w.parking.index(w);
  const grid = w.grid;
  const bx = Math.floor(near.x / BUCKET_TILES);
  const by = Math.floor(near.y / BUCKET_TILES);
  let best = NO_PLACE;
  let bestDistance = Infinity;
  const offer = (place: number, distance: number) => {
    if (distance > maxTiles) return;
    const better =
      distance < bestDistance ||
      (distance === bestDistance && (isStreet(best) !== isStreet(place) ? !isStreet(place) : Math.abs(place) < Math.abs(best)));
    if (better) {
      best = place;
      bestDistance = distance;
    }
  };
  const rings = Math.max(index.w, index.h);
  for (let r = 0; r <= rings; r++) {
    // No tile of a bucket on ring r is nearer than this, a building's footprint reaching out of its bucket included.
    const nearest = Math.max((r - 1) * BUCKET_TILES - FOOTPRINT_REACH, 0);
    if (nearest > maxTiles || nearest > bestDistance) break;
    for (let y = by - r; y <= by + r; y++) {
      if (y < 0 || y >= index.h) continue;
      const step = y === by - r || y === by + r ? 1 : 2 * r;
      for (let x = bx - r; x <= bx + r; x += Math.max(step, 1)) {
        if (x < 0 || x >= index.w) continue;
        const bucket = y * index.w + x;
        if (buildings) {
          for (const id of index.buildings[bucket]!) {
            const b = w.buildings.get(id);
            if (b !== undefined && hasFreeSpot(w, b)) offer(buildingPlace(id), footprintDistance(near, b));
          }
        }
        if (streets) {
          for (const tile of index.streets[bucket]!) {
            if (w.parking.streets[tile]! >= streetSpots(grid, tile)) continue;
            offer(streetPlace(tile), Math.abs((tile % grid.width) - near.x) + Math.abs(Math.floor(tile / grid.width) - near.y));
          }
        }
      }
    }
  }
  return best;
}

/**
 * A free spot for a car going to `near`: the `preferred` building, then a building within walking reach, then a street
 * within it, then — when `maxMeters` goes past that reach — the nearest spot of any kind within `maxMeters`. The walking
 * reach is `parkingWalkMeters` or `maxMeters`, whichever is shorter. `NO_PLACE` when there is none.
 */
export function findParking(w: World, near: TilePos, preferred: number | undefined, maxMeters: number): number {
  const preferredBuilding = preferred === undefined ? undefined : w.buildings.get(preferred);
  if (preferredBuilding !== undefined && hasFreeSpot(w, preferredBuilding)) return buildingPlace(preferredBuilding.id);
  const tileMeters = w.trafficConfig.tileMeters;
  const reachMeters = Math.min(w.citizenConfig.parkingWalkMeters, maxMeters);
  const reach = Math.floor(reachMeters / tileMeters);
  const inReach = nearestFree(w, near, reach, true, false);
  if (inReach !== NO_PLACE) return inReach;
  const street = nearestFree(w, near, reach, false, true);
  if (street !== NO_PLACE || maxMeters <= reachMeters) return street;
  return nearestFree(w, near, maxMeters === Infinity ? Infinity : Math.floor(maxMeters / tileMeters), true, true);
}

export function takeParking(w: World, place: number): void {
  w.parking.take(place);
}

export function releaseParking(w: World, place: number): void {
  w.parking.release(place);
}

/** The tile a car at `place` stands on: a building's tile by its road towards `towards`, a street's own tile. */
export function placeTile(w: World, place: number, towards: TilePos): TilePos {
  const grid = w.grid;
  if (isStreet(place)) {
    const tile = streetTile(place);
    return { x: tile % grid.width, y: Math.floor(tile / grid.width) };
  }
  const b = w.buildings.get(place);
  return b === undefined ? towards : footprintEntrance(grid, b.anchor, b.width, b.length, towards);
}

/** Gives a citizen a car parked at or nearest their home. `false` when the city has no free spot for it. */
export function giveCar(w: World, ref: number): boolean {
  const c = w.citizens;
  const slot = c.resolve(ref);
  const home = slot === undefined ? undefined : w.buildings.get(c.home[slot]!);
  if (slot === undefined || home === undefined || c.carStatus[slot] !== CAR_NONE) return false;
  const place = findParking(w, home.anchor, home.id, Infinity);
  if (place === NO_PLACE) return false;
  w.parking.take(place);
  c.carStatus[slot] = CAR_PARKED;
  c.carPlace[slot] = place;
  const tile = placeTile(w, place, home.anchor);
  c.carX[slot] = tile.x;
  c.carY[slot] = tile.y;
  return true;
}
