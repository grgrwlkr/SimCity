// Port of crates/simcity_sim/src/game/buildings/decay.rs: buildings the grid no longer backs, and buildings
// abandoned for lost road access, unhappy occupants or economic losses. The warning tints are render-side.
import { crimeContentment } from '../cityFields';
import { zoneDemand } from '../demand';
import { bumpVersion } from '../map/dirty';
import type { World } from '../world';
import {
  allFootprintTiles,
  anyFootprintTile,
  buildingArea,
  buildingKindZone,
  constructionDays,
  footprintTiles,
  hasAdjacentRoad,
  isOperational,
  type Building,
} from './building';
import { expectedOccupancy } from './occupancy';

const f32 = Math.fround;

/** GDD: a building without road access is demolished after a game day. */
export const NO_ROAD_ACCESS_GRACE_DAYS = 1;
/** GDD: days of low happiness before a building is abandoned. */
export const LOW_HAPPINESS_GRACE_DAYS = 2;
/** Happiness below which decay starts. */
export const LOW_HAPPINESS_THRESHOLD = f32(0.3);
/** GDD: losses at which a building is abandoned. */
export const ECONOMIC_LOSSES_THRESHOLD = -100;

/**
 * Removes `b` and clears the building layer of its footprint where it still shows `b`'s kind: a cell left
 * with a building and no record would block zoning and placement for good. The map edit version bumps so
 * the renderer and the utility network see the change (Rust left the version alone).
 */
export function demolishBuilding(w: World, b: Building): void {
  for (const tile of footprintTiles(b)) {
    const cell = w.grid.get(tile);
    if (cell === undefined || cell.building !== b.kind) continue;
    w.grid.set(tile, { ...cell, building: null });
    w.dirty.mark(w.grid.idx(tile)!);
  }
  w.buildings.remove(b.id);
  w.mapEditVersion = bumpVersion(w.mapEditVersion);
}

/** `despawn_invalid_buildings`: a building whose anchor or footprint the grid no longer shows goes. */
export function despawnInvalidBuildings(w: World): void {
  const grid = w.grid;
  for (const b of [...w.buildings.all()]) {
    const cell = grid.get(b.anchor);
    const valid =
      cell !== undefined &&
      !cell.water &&
      cell.zone === buildingKindZone(b.kind) &&
      cell.building === b.kind &&
      allFootprintTiles(b.anchor, b.width, b.length, (tile) => {
        const c = grid.get(tile);
        return c !== undefined && !c.water && c.building === b.kind;
      });
    if (!valid) demolishBuilding(w, b);
  }
}

/** `building_decay_no_road_access`: without a road beside its footprint a building is demolished after the grace day. */
export function buildingDecayNoRoadAccess(w: World): void {
  const day = w.city.day;
  for (const b of [...w.buildings.all()]) {
    if (anyFootprintTile(b.anchor, b.width, b.length, (tile) => hasAdjacentRoad(w.grid, tile))) {
      b.noRoadAccessDecay = null;
      continue;
    }
    const lostDay = b.noRoadAccessDecay?.accessLostDay ?? day;
    if (Math.max(day - lostDay, 0) < NO_ROAD_ACCESS_GRACE_DAYS) {
      b.noRoadAccessDecay ??= { accessLostDay: day };
      continue;
    }
    demolishBuilding(w, b);
  }
}

/**
 * `building_decay_low_happiness`: homes and shops whose happiness, approximated from occupancy against what
 * the market lets them hold by now and from crime, stays low past the grace days are abandoned.
 */
export function buildingDecayLowHappiness(w: World): void {
  const day = w.city.day;
  for (const b of [...w.buildings.all()]) {
    if ((b.kind !== 'Residential' && b.kind !== 'Commercial') || !isOperational(b)) continue;
    const homes = b.kind === 'Residential';
    const occupancy = homes ? b.occupancyResidents : b.occupancyJobs;
    const target = homes ? b.targetOccupancyResidents : b.targetOccupancyJobs;
    let ratio: number;
    if (target === 0) {
      // The market gives it nobody: no road, no power, or demand has collapsed.
      ratio = 0;
    } else {
      const area = buildingArea(b);
      const openedDay = b.constructionStartDay + constructionDays(b.kind, b.level, area);
      const expected = expectedOccupancy(target, b.level, area, zoneDemand(w.rciDemand, b.kind), Math.max(day - openedDay, 0));
      ratio = expected < 1 ? 1 : f32(occupancy / expected);
    }
    const crime = homes ? w.cityFields.footprintMean('Crime', w.grid, b.anchor, b.width, b.length) : undefined;
    const happiness = f32(Math.min(Math.max(ratio, 0), 1) * (crime === undefined ? 1 : crimeContentment(crime)));
    if (happiness >= LOW_HAPPINESS_THRESHOLD) {
      b.lowHappinessDecay = null;
      continue;
    }
    const startDay = b.lowHappinessDecay?.decayStartDay ?? day;
    if (Math.max(day - startDay, 0) < LOW_HAPPINESS_GRACE_DAYS) {
      b.lowHappinessDecay ??= { decayStartDay: day, avgHappiness: happiness };
      continue;
    }
    demolishBuilding(w, b);
  }
}

/** `building_decay_economic`: shops and industry below half their jobs lose money daily and are abandoned past the threshold. */
export function buildingDecayEconomic(w: World): void {
  const day = w.city.day;
  for (const b of [...w.buildings.all()]) {
    if ((b.kind !== 'Commercial' && b.kind !== 'Industrial') || !isOperational(b)) continue;
    const ratio = f32(b.occupancyJobs / b.capacityJobs);
    const dailyLoss = ratio < 0.5 ? -Math.trunc(f32(f32(0.5 - ratio) * 20)) : 0;
    if (dailyLoss === 0) {
      b.economicDecay = null;
      continue;
    }
    const startDay = b.economicDecay?.decayStartDay ?? day;
    const losses = Math.max(day - startDay, 0) * dailyLoss;
    if (losses > ECONOMIC_LOSSES_THRESHOLD) {
      b.economicDecay ??= { decayStartDay: day, cumulativeLosses: losses };
      continue;
    }
    demolishBuilding(w, b);
  }
}
