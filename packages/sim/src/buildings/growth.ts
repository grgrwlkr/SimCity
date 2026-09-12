// Port of crates/simcity_sim/src/game/buildings/growth.rs: every game hour zoned land with demand, a road
// and power grows buildings at random seeds, the largest footprint that fits first (GDD 10.1.3).
import { attractivenessToGrow, workplaceClass } from '../cityFields';
import type { BuildingKind, TilePos, ZoneDensity } from '../commands';
import { zoneDemand } from '../demand';
import { wealthFromLandValue } from '../economy/wealth';
import { bumpVersion } from '../map/dirty';
import { tileKey } from '../map/grid';
import { roadCellIsSome } from '../map/roads';
import { MAX_ZONE_DEPTH, isFootprintWithinZoneDepth } from '../map/zonePlacement';
import { rangeU32 } from '../rng';
import type { World } from '../world';
import {
  anyFootprintTile,
  buildingKindFromZone,
  buildingKindZone,
  footprintSides,
  footprintTiles,
  hasAdjacentRoad,
  isZonedKind,
  type Building,
} from './building';
import { spawnBuilding } from './spawn';

/** One feed line for every zone. */
export const CONSTRUCTION_NOTICE = 'New building constructed';
const MAX_SPAWNS_PER_HOUR = 6;
/** GDD 10.3.3.1: the city's construction capacity. */
const MAX_PARALLEL_CONSTRUCTIONS = 15;
const SEED_ATTEMPTS = 128;

interface Footprint {
  readonly anchor: TilePos;
  readonly width: number;
  readonly length: number;
  readonly tiles: readonly TilePos[];
}

const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);

/**
 * GDD 10.1.3 blocking rule: a zoned building does not grow behind another zoned building along the same road
 * tile, further from the road in the same direction.
 */
function blockedBehind(w: World, tiles: readonly TilePos[], existing: readonly Building[]): boolean {
  const manhattan = (a: TilePos, b: TilePos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  for (const roadTile of tiles.filter((tile) => hasAdjacentRoad(w.grid, tile))) {
    for (const b of existing) {
      if (!isZonedKind(b.kind)) continue;
      if (!anyFootprintTile(b.anchor, b.width, b.length, (bt) => manhattan(bt, roadTile) === 1)) continue;
      const reach = Math.max(...footprintTiles(b).map((bt) => manhattan(bt, roadTile)));
      for (const tile of tiles) {
        if (hasAdjacentRoad(w.grid, tile) || manhattan(tile, roadTile) <= reach) continue;
        if (sign(b.anchor.x - roadTile.x) === sign(tile.x - roadTile.x) && sign(b.anchor.y - roadTile.y) === sign(tile.y - roadTile.y)) return true;
      }
    }
  }
  return false;
}

function tryFootprintAt(
  w: World,
  anchor: TilePos,
  width: number,
  length: number,
  kind: BuildingKind,
  density: ZoneDensity,
  occupied: ReadonlySet<number>,
  existing: readonly Building[],
): Footprint | undefined {
  const grid = w.grid;
  const zone = buildingKindZone(kind);
  const tiles: TilePos[] = [];
  for (let dx = 0; dx < width; dx++) {
    for (let dy = 0; dy < length; dy++) {
      const tile = { x: anchor.x + dx, y: anchor.y + dy };
      const cell = grid.get(tile);
      if (cell === undefined || cell.water || roadCellIsSome(cell.road) || cell.building !== null) return undefined;
      if (cell.zone !== zone || cell.density !== density || occupied.has(tileKey(tile))) return undefined;
      tiles.push(tile);
    }
  }
  // GDD 10.2.2: every tile within zone depth of a road, and at least one beside a road.
  if (!isFootprintWithinZoneDepth(anchor, width, length, grid, MAX_ZONE_DEPTH)) return undefined;
  if (!tiles.some((tile) => hasAdjacentRoad(grid, tile))) return undefined;
  // Nothing grows where the road carries no power.
  if (!w.utilityNetwork.footprintHas(grid, anchor, width, length, 'Power')) return undefined;
  if (blockedBehind(w, tiles, existing)) return undefined;

  // Once the city fields are measured a zone grows where it is attractive enough on every tile; before
  // that, bare land value decides.
  const fields = w.cityFields;
  if (fields.covers(grid.len())) {
    const floor = attractivenessToGrow(kind);
    if (floor !== undefined && tiles.some((tile) => fields.get('Attractiveness', grid.idx(tile)!) < floor)) return undefined;
  } else {
    const min = kind === 'Residential' ? Math.fround(0.3) : kind === 'Commercial' ? Math.fround(0.4) : 0;
    if (min > 0 && tiles.some((tile) => w.landValue.get(grid.idx(tile)!) < min)) return undefined;
  }
  return { anchor, width, length, tiles };
}

/** Footprints by area, then length, then width, each tried with the seed at its four corners. */
function findBestFootprint(
  w: World,
  seed: TilePos,
  kind: BuildingKind,
  density: ZoneDensity,
  occupied: ReadonlySet<number>,
  existing: readonly Building[],
): Footprint | undefined {
  const [shortest, longest] = footprintSides(density);
  const sizes: Array<readonly [number, number]> = [];
  for (let width = shortest; width <= longest; width++) {
    for (let length = shortest; length <= longest; length++) sizes.push([width, length]);
  }
  sizes.sort((a, b) => b[0] * b[1] - a[0] * a[1] || b[1] - a[1] || b[0] - a[0]);
  for (const [width, length] of sizes) {
    for (const [ox, oy] of [
      [0, 0],
      [0, 0],
      [-(width - 1), 0],
      [0, -(length - 1)],
      [-(width - 1), -(length - 1)],
    ] as const) {
      const found = tryFootprintAt(w, { x: seed.x + ox, y: seed.y + oy }, width, length, kind, density, occupied, existing);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** `grow_buildings` (SimStep::Buildings), on every advanced hour. */
export function growBuildings(w: World): void {
  if (w.events.hourAdvanced.length === 0) return;
  // New buildings join the rules from the next hour on, as spawned entities did in Rust.
  const existing = [...w.buildings.all()];
  if (existing.filter((b) => b.phase.kind === 'UnderConstruction').length >= MAX_PARALLEL_CONSTRUCTIONS) return;
  const grid = w.grid;
  const len = grid.len();
  if (len === 0) return;
  const occupied = new Set<number>();
  for (const b of existing) for (const tile of footprintTiles(b)) occupied.add(tileKey(tile));

  let spawned = 0;
  for (let attempt = 0; attempt < SEED_ATTEMPTS && spawned < MAX_SPAWNS_PER_HOUR; attempt++) {
    const idx = rangeU32(w.growthRng, 0, len);
    const seed = { x: idx % grid.width, y: Math.trunc(idx / grid.width) };
    const cell = grid.cellAt(idx);
    if (cell.water || roadCellIsSome(cell.road) || cell.building !== null) continue;
    const kind = buildingKindFromZone(cell.zone);
    if (kind === undefined || !(zoneDemand(w.rciDemand, kind) > 0)) continue;
    const footprint = findBestFootprint(w, seed, kind, cell.density, occupied, existing);
    if (footprint === undefined) continue;

    for (const tile of footprint.tiles) {
      grid.set(tile, { ...grid.get(tile)!, building: kind });
      w.dirty.mark(grid.idx(tile)!);
      occupied.add(tileKey(tile));
    }
    // The class comes from the land; a workplace takes the high class only where the people around are educated for it.
    const land = w.landValue.values.length === len ? wealthFromLandValue(w.landValue.get(grid.idx(footprint.anchor)!)) : 'Middle';
    const wealth =
      kind === 'Commercial' || kind === 'Industrial'
        ? workplaceClass(land, w.cityFields.footprintMean('Education', grid, footprint.anchor, footprint.width, footprint.length))
        : land;
    spawnBuilding(w, footprint.anchor, footprint.width, footprint.length, kind, false, { density: cell.density, class: wealth });
    spawned += 1;
    w.notifications.addAt(CONSTRUCTION_NOTICE, 'Info', 3, footprint.anchor);
  }
  // The renderer and the utility network read the building layer by the edit version.
  if (spawned > 0) w.mapEditVersion = bumpVersion(w.mapEditVersion);
}
