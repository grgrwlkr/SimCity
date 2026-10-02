// Port of crates/simcity_sim/src/game/buildings/blockers.rs: why a zoned tile does not grow and why a
// building does not rise — the reasons a player reads.
import { FIRE_HAZARD_LIMIT, HEALTH_FOR_LEVEL_THREE, attractivenessToGrow, type CityFields } from '../cityFields';
import type { TilePos } from '../commands';
import { zoneDemand, type RciDemand } from '../demand';
import type { MapGrid } from '../map/grid';
import { MAX_ZONE_DEPTH, isWithinZoneDepth } from '../map/zonePlacement';
import type { UtilityKind, UtilityNetwork } from '../utilities';
import type { World } from '../world';
import { buildingKindFromZone, densityLevels, isOperational, isZonedKind, type Building } from './building';

const f32 = Math.fround;

export const GROWTH_BLOCKERS = ['NotZoned', 'NoRoad', 'NoPower', 'NoWater', 'NoDemand', 'TopLevel', 'FireHazard', 'PoorHealth', 'Unattractive'] as const;
export type GrowthBlocker = (typeof GROWTH_BLOCKERS)[number];

const REASONS: Readonly<Record<GrowthBlocker, string>> = {
  NotZoned: 'Not zoned',
  NoRoad: 'No road within reach',
  NoPower: 'No power',
  NoWater: 'No water',
  NoDemand: 'No demand',
  TopLevel: 'Top level',
  FireHazard: 'High fire hazard',
  PoorHealth: 'Poor health',
  Unattractive: 'Unattractive location',
};

/** The words a player reads. */
export function blockerReason(blocker: GrowthBlocker): string {
  return REASONS[blocker];
}

/** Whether a road supplied with `kind` lies within zone depth of `tile`. */
export function blockHas(grid: MapGrid, network: UtilityNetwork, tile: TilePos, kind: UtilityKind): boolean {
  for (let dx = -MAX_ZONE_DEPTH; dx <= MAX_ZONE_DEPTH; dx++) {
    const reach = MAX_ZONE_DEPTH - Math.abs(dx);
    for (let dy = -reach; dy <= reach; dy++) {
      const idx = grid.idx({ x: tile.x + dx, y: tile.y + dy });
      if (idx !== undefined && grid.roadKind[idx] !== 0 && network.tileHas(idx, kind)) return true;
    }
  }
  return false;
}

/** Everything that keeps a zoned tile from growing, the most basic first; empty when it can grow. */
export function growthBlockers(grid: MapGrid, network: UtilityNetwork, demand: RciDemand, tile: TilePos, fields: CityFields | undefined): GrowthBlocker[] {
  const cell = grid.get(tile);
  const kind = cell === undefined ? undefined : buildingKindFromZone(cell.zone);
  if (kind === undefined) return ['NotZoned'];
  // Without a road there is nothing for a utility to travel along either.
  if (!isWithinZoneDepth(tile, grid, MAX_ZONE_DEPTH)) return ['NoRoad'];
  const blockers: GrowthBlocker[] = [];
  if (!blockHas(grid, network, tile, 'Power')) blockers.push('NoPower');
  const floor = attractivenessToGrow(kind);
  if (floor !== undefined && fields !== undefined && fields.covers(grid.len()) && fields.get('Attractiveness', grid.idx(tile)!) < floor) {
    blockers.push('Unattractive');
  }
  if (zoneDemand(demand, kind) <= 0) blockers.push('NoDemand');
  return blockers;
}

/** The first thing keeping `b` from its next level; `null` when it may rise. */
export function upgradeBlocker(b: Building, grid: MapGrid, network: UtilityNetwork, demand: RciDemand, fields: CityFields | undefined): GrowthBlocker | null {
  if (!isZonedKind(b.kind)) return 'NotZoned';
  if (b.level >= densityLevels(b.profile.density)[1]) return 'TopLevel';
  if (!network.footprintHas(grid, b.anchor, b.width, b.length, 'Power')) return 'NoPower';
  if (!network.footprintHas(grid, b.anchor, b.width, b.length, 'Water')) return 'NoWater';
  const hazard = fields?.footprintMean('FireHazard', grid, b.anchor, b.width, b.length);
  if (hazard !== undefined && hazard >= FIRE_HAZARD_LIMIT) return 'FireHazard';
  if (b.kind === 'Residential' && b.level >= 2) {
    const health = fields?.footprintMean('Health', grid, b.anchor, b.width, b.length);
    if (health !== undefined && health < HEALTH_FOR_LEVEL_THREE) return 'PoorHealth';
  }
  if (zoneDemand(demand, b.kind) <= f32(0.3)) return 'NoDemand';
  return null;
}

/** The feed line for zoned buildings that lost their power. */
export const BUILDINGS_WITHOUT_POWER = 'Buildings without power';

const ZONE_NAMES = { Residential: 'Residential zone', Commercial: 'Commercial zone', Industrial: 'Industrial zone' } as const;

/**
 * What a hovered zoned tile tells the player: its zone and the reason it is held back; `null` for an
 * unzoned tile and one where nothing is in the way.
 */
export function tileDiagnosis(
  grid: MapGrid,
  network: UtilityNetwork,
  demand: RciDemand,
  tile: TilePos,
  fields: CityFields | undefined,
): readonly [zone: string, reason: string] | null {
  const cell = grid.get(tile);
  if (cell === undefined || cell.zone === 'None') return null;
  const field = (name: 'FireHazard' | 'Health') =>
    fields !== undefined && fields.covers(grid.len()) ? fields.get(name, grid.idx(tile)!) : undefined;
  let reason: string;
  if (cell.building !== null) {
    // A standing building: power keeps it occupied, water lets it rise, fire hazard and poor health hold it back.
    const hazard = field('FireHazard');
    const health = field('Health');
    if (!blockHas(grid, network, tile, 'Power')) reason = 'No power: occupants are leaving';
    else if (!blockHas(grid, network, tile, 'Water')) reason = 'No water: cannot rise above level 1';
    else if (hazard !== undefined && hazard >= FIRE_HAZARD_LIMIT) reason = 'High fire hazard: cannot rise';
    else if (cell.building === 'Residential' && health !== undefined && health < HEALTH_FOR_LEVEL_THREE) reason = 'Poor health: cannot reach level 3';
    else return null;
  } else {
    const blockers = growthBlockers(grid, network, demand, tile, fields);
    if (blockers.length === 0) return null;
    reason = `Won't grow: ${blockers.map(blockerReason).join(', ')}`;
  }
  return [ZONE_NAMES[cell.zone], reason];
}

/** Once a game day: one feed line for zoned buildings without power, placed on the top-left of them. */
export function reportBuildingsWithoutPower(w: World): void {
  if (w.events.dayAdvanced.length === 0) return;
  let first: TilePos | undefined;
  for (const b of w.buildings.all()) {
    if (!isOperational(b) || !isZonedKind(b.kind) || w.utilityNetwork.footprintHas(w.grid, b.anchor, b.width, b.length, 'Power')) continue;
    if (first === undefined || b.anchor.y < first.y || (b.anchor.y === first.y && b.anchor.x < first.x)) first = b.anchor;
  }
  if (first !== undefined) w.notifications.addAt(BUILDINGS_WITHOUT_POWER, 'Warning', 6, first);
}
