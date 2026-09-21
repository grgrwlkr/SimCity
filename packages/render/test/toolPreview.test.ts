// Port of crates/simcity_sim/src/game/map/preview.rs (mod tests): what the active tool would do at a tile, said before
// the click. Each verdict is pinned against the real check of packages/sim, so the cursor cannot promise what the
// click then refuses, the milestone lock included.
import {
  MapGrid,
  Milestones,
  buildCost,
  buildCostPerLaneTile,
  canZoneTile,
  roadCellNone,
  serviceRadius,
  validateBuildingPlacement,
  type BuildingKind,
  type MapCell,
  type RoadDir,
  type RoadKind,
  type TilePos,
} from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { placedBuildingKind, previewToolAt, type ToolMode, type ToolPreview } from '../src/toolPreview';

const RICH = 1_000_000;
const at = (x: number, y: number): TilePos => ({ x, y });

function cell(grid: MapGrid, overrides: Partial<MapCell>): MapCell {
  return { ...grid.cellAt(0), road: roadCellNone(), water: false, building: null, zone: 'None', ...overrides };
}

function road(grid: MapGrid, kind: RoadKind, dir: RoadDir): MapCell {
  return cell(grid, { road: { ...roadCellNone(), kind, dir } });
}

/** A 32×32 map with a two-lane road along y = 10, water at (3, 11) and a building at (6, 11). */
function town(): MapGrid {
  const grid = new MapGrid(32, 32);
  const lane = road(grid, 'TwoLane', 'East');
  const water = cell(grid, { water: true });
  const house = cell(grid, { building: 'Residential' });
  for (let x = 0; x < 20; x++) grid.set(at(x, 10), lane);
  grid.set(at(3, 11), water);
  grid.set(at(6, 11), house);
  return grid;
}

function preview(tool: ToolMode, tile: TilePos, grid: MapGrid, money: number, milestones?: Milestones): ToolPreview {
  const p = previewToolAt(tool, tile, grid, money, milestones);
  if (p === undefined) throw new Error(`${tool.kind} at ${tile.x},${tile.y} must explain itself`);
  return p;
}

const refusal = (p: ToolPreview): string => {
  if (p.refusal === null) throw new Error(`expected a refusal, the click would work: ${p.effect}`);
  return p.refusal;
};

describe('tool preview', () => {
  it('toolPreviewPricesARoadTileItsUpgradeAndACrossing', () => {
    const grid = town();
    const fresh = preview({ kind: 'Road', road: 'FourLane' }, at(5, 20), grid, RICH);
    expect(fresh.cost).toBe(buildCostPerLaneTile('FourLane'));
    expect(fresh.refusal).toBeNull();
    expect(fresh.effect).toContain('road');

    const upgrade = preview({ kind: 'Road', road: 'SixLane' }, at(5, 10), grid, RICH);
    expect(upgrade.cost, 'an upgrade costs the difference, as the command charges it').toBe(buildCostPerLaneTile('SixLane') - buildCostPerLaneTile('TwoLane'));
    expect(upgrade.refusal).toBeNull();

    expect(preview({ kind: 'Road', road: 'TwoLane' }, at(5, 10), grid, RICH).cost).toBe(0);
  });

  it('toolPreviewRefusesARoadOnWaterAndADowngradeButNotDebt', () => {
    const grid = town();
    expect(refusal(preview({ kind: 'Road', road: 'TwoLane' }, at(3, 11), grid, RICH))).toContain('water');

    grid.set(at(8, 20), road(grid, 'SixLane', 'East'));
    expect(refusal(preview({ kind: 'Road', road: 'TwoLane' }, at(8, 20), grid, RICH))).toContain('downgrade');

    expect(preview({ kind: 'Road', road: 'TwoLane' }, at(5, 20), grid, -5_000).refusal, 'roads may be built in debt').toBeNull();
  });

  it('toolPreviewZoneVerdictIsTheZoningRule', () => {
    const grid = town();
    for (let x = 0; x < 12; x++) {
      for (let y = 8; y < 14; y++) {
        const zone = preview({ kind: 'Residential' }, at(x, y), grid, RICH);
        expect(zone.refusal === null, `the cursor and the command disagree at ${x},${y}: ${zone.refusal}`).toBe(canZoneTile(grid, at(x, y)));
        expect(zone.cost, 'zoning is free').toBe(0);
        if (zone.refusal !== null) expect(zone.refusal).not.toBe('');
      }
    }
    expect(refusal(preview({ kind: 'Commercial' }, at(10, 20), grid, RICH))).toContain('road');
  });

  it('toolPreviewServiceShowsPriceRadiusAndWhyItCannotGoHere', () => {
    const grid = town();
    const far = preview({ kind: 'FireStation' }, at(20, 20), grid, RICH);
    expect(far.cost).toBe(buildCost('FireStation'));
    expect(far.radius).toBe(serviceRadius('FireStation'));
    expect(refusal(far)).toContain('road');

    const beside = preview({ kind: 'Hospital' }, at(10, 11), grid, RICH);
    expect(beside.refusal).toBeNull();
    expect(beside.radius).toBe(serviceRadius('Hospital'));

    expect(refusal(preview({ kind: 'Hospital' }, at(10, 11), grid, 100))).toContain('money');
    expect(refusal(preview({ kind: 'PoliceStation' }, at(5, 11), grid, RICH))).toContain('clear');
    expect(refusal(preview({ kind: 'PoliceStation' }, at(30, 30), grid, RICH))).toContain('map');
  });

  it('utilityNetworkStationToolsShowPriceAndSupplyNotARadius', () => {
    const grid = town();
    for (const [tool, kind, word] of [
      ['PowerPlant', 'PowerPlant', 'power'],
      ['WaterPump', 'WaterPump', 'water'],
      ['Landfill', 'Landfill', 'garbage'],
    ] as const) {
      expect(placedBuildingKind({ kind: tool })).toBe(kind);
      const beside = preview({ kind: tool }, at(10, 11), grid, RICH);
      expect(beside.cost, tool).toBe(buildCost(kind));
      expect(beside.refusal, tool).toBeNull();
      expect(beside.radius, 'supply follows roads, not a radius').toBeUndefined();
      expect(beside.effect.toLowerCase(), `${tool} says ${beside.effect}`).toContain(word);
      expect(refusal(preview({ kind: tool }, at(20, 20), grid, RICH)), tool).toContain('road');
    }
  });

  /** A building the city has not opened yet says at what population it opens, before the click. */
  it('milestoneLockedBuildingPreviewSaysWhenItUnlocks', () => {
    const grid = town();
    const fresh = new Milestones();
    const school = preview({ kind: 'School' }, at(10, 11), grid, RICH, fresh);
    expect(school.refusal).toBe('Unlocks at 250 residents');
    expect(school.cost, 'the price still shows').toBe(buildCost('School'));
    const park = preview({ kind: 'Park' }, at(10, 11), grid, RICH, fresh);
    expect(park.refusal, 'a park is open from the start').toBeNull();

    const grown = new Milestones();
    grown.reach(300);
    expect(preview({ kind: 'School' }, at(10, 11), grid, RICH, grown).refusal).toBeNull();
  });

  it('serviceBuildingToolsShowPriceAndRadius', () => {
    const grid = town();
    for (const kind of ['School', 'University', 'Park'] as const satisfies readonly BuildingKind[]) {
      expect(placedBuildingKind({ kind })).toBe(kind);
      const beside = preview({ kind }, at(10, 11), grid, RICH);
      expect(beside.cost, kind).toBe(buildCost(kind));
      expect(beside.cost, `${kind} has a price`).toBeGreaterThan(0);
      expect(beside.refusal, kind).toBeNull();
      expect(beside.radius, `${kind} shows its radius`).toBeDefined();
      expect(beside.radius, kind).toBe(serviceRadius(kind));
    }
  });

  it('toolPreviewServiceVerdictIsThePlacementRule', () => {
    const grid = town();
    for (let x = 0; x < 14; x++) {
      for (let y = 6; y < 16; y++) {
        const service = preview({ kind: 'FireStation' }, at(x, y), grid, RICH);
        expect(service.refusal === null, `the cursor and the command disagree at ${x},${y}: ${service.refusal}`).toBe(
          validateBuildingPlacement(grid, at(x, y), 3, 3) !== undefined,
        );
      }
    }
  });

  it('toolPreviewSignalBulldozerInspectAndOffTheMap', () => {
    const grid = town();
    grid.set(at(12, 10), road(grid, 'TwoLane', 'None'));
    expect(preview({ kind: 'TrafficLight' }, at(12, 10), grid, RICH).refusal).toBeNull();
    expect(refusal(preview({ kind: 'TrafficLight' }, at(5, 10), grid, RICH))).toContain('intersection');

    expect(refusal(preview({ kind: 'Erase' }, at(10, 20), grid, RICH))).toContain('Nothing');
    expect(refusal(preview({ kind: 'Erase' }, at(3, 11), grid, RICH))).toContain('water');
    expect(preview({ kind: 'Erase' }, at(5, 10), grid, RICH).refusal).toBeNull();

    expect(previewToolAt({ kind: 'Inspect' }, at(5, 10), grid, RICH)).toBeUndefined();

    expect(refusal(preview({ kind: 'Residential' }, at(-1, 4), grid, RICH))).toContain('map');
  });
});
