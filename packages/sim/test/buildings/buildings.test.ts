// Port of crates/simcity_sim/src/game/buildings/tests.rs: footprints, construction, zone depth,
// occupancy, parking and economic decay.
import { describe, expect, it } from 'vitest';
import {
  buildCost,
  buildingArea,
  buildingKindZone,
  serviceCapacity,
  serviceRadius,
  utilityCapacity,
  capacityJobsForLevelArea,
  capacityResidentsForLevelArea,
  constructionHours,
  footprintTiles,
  isOperational,
  newBuilding,
} from '../../src/buildings/building';
import { updateConstructionProgress } from '../../src/buildings/construction';
import { buildingDecayEconomic } from '../../src/buildings/decay';
import { upgradeBuildings } from '../../src/buildings/upgrade';
import { calculateFillDays, calculatePressure, calculateTargetRatio, updateOccupancy } from '../../src/buildings/occupancy';
import { calculateParkingSpots } from '../../src/buildings/spawn';
import { emptyEvents } from '../../src/events';
import { MapGrid } from '../../src/map/grid';
import { MAX_ZONE_DEPTH, isFootprintWithinZoneDepth, isWithinZoneDepth } from '../../src/map/zonePlacement';
import { UtilityNetwork } from '../../src/utilities';
import { setRoad } from '../transport/helpers';
import { t, worldOn } from './helpers';

describe('building record', () => {
  it('buildingFootprintTilesReturnsCorrectTiles', () => {
    const tiles = footprintTiles(newBuilding({ kind: 'Residential', anchor: t(10, 10), width: 3, length: 4, capacityResidents: 4 }));
    expect(tiles).toHaveLength(12);
    expect(tiles[0]).toEqual(t(10, 10));
    expect(tiles[11]).toEqual(t(12, 13));
  });

  it('buildingAreaCalculatesCorrectly', () => {
    expect(buildingArea(newBuilding({ kind: 'Residential', anchor: t(0, 0), width: 5, length: 6 }))).toBe(30);
  });

  it('buildingIsOperationalReturnsCorrectPhase', () => {
    expect(isOperational(newBuilding({ kind: 'Residential', anchor: t(0, 0), phase: { kind: 'UnderConstruction', hoursRemaining: 5 } }))).toBe(false);
    expect(isOperational(newBuilding({ kind: 'Residential', anchor: t(0, 0) }))).toBe(true);
  });

  // TS (stage 3½): construction is measured in game hours on a real-time clock; Rust took two or three days on a clock of
  // a second an hour (building_calculate_construction_days_scales_with_area).
  it('constructionTakesHours', () => {
    expect(constructionHours('Residential', 1, 9), 'a small house').toBe(8);
    expect(constructionHours('Residential', 1, 36), 'twice the side, twice the hours').toBe(16);
    expect(constructionHours('Residential', 3, 9)).toBe(12);
    expect(constructionHours('FireStation', 1, 9), 'a service building takes longer').toBe(16);
    expect(constructionHours('Commercial', 3, 36), 'held to a day').toBe(24);
  });

  it('aBuildingOpensAfterItsHours', () => {
    const w = worldOn(new MapGrid(8, 8));
    const b = w.buildings.add(newBuilding({ kind: 'Residential', anchor: t(1, 1), phase: { kind: 'UnderConstruction', hoursRemaining: 2 } }));
    w.events.hourAdvanced.push({ hour: 1, day: 1 });
    updateConstructionProgress(w);
    expect(b.phase, 'an hour left').toEqual({ kind: 'UnderConstruction', hoursRemaining: 1 });
    w.events = emptyEvents();
    w.events.hourAdvanced.push({ hour: 2, day: 1 });
    updateConstructionProgress(w);
    expect(isOperational(b)).toBe(true);
  });

  it('theUpgradeClockRunsInGameHours', () => {
    const w = worldOn(new MapGrid(8, 8));
    upgradeBuildings(w, 5 * w.gameHourNs - 1);
    expect(w.buildingUpgradeClock.timesFinishedThisTick, 'not before five game hours').toBe(0);
    upgradeBuildings(w, 1);
    expect(w.buildingUpgradeClock.timesFinishedThisTick, 'on the fifth').toBe(1);
  });

  // From crates/simcity_sim/src/game/map/tests.rs (B4): the civic buildings carry a radius, a capacity and a price.
  it('serviceBuildingSchoolUniversityAndParkHaveRadiusCapacityAndPrice', () => {
    for (const [kind, radius, capacity, cost] of [
      ['School', 18, 400, 700],
      ['University', 30, 1200, 2000],
      ['Park', 8, 300, 150],
    ] as const) {
      expect(serviceRadius(kind), kind).toBe(radius);
      expect(serviceCapacity(kind), kind).toBe(capacity);
      expect(buildCost(kind), kind).toBe(cost);
      expect(buildingKindZone(kind), kind).toBe('None');
    }
    expect(serviceCapacity('FireStation')).toBeUndefined();
  });

  // From crates/simcity_sim/src/game/map/tests.rs (B4): stations supply a limited number of units.
  it('serviceBuildingUtilityStationsHaveSupplyCapacity', () => {
    expect(utilityCapacity('PowerPlant')).toBe(5000);
    expect(utilityCapacity('WaterPump')).toBe(5000);
    expect(utilityCapacity('Landfill')).toBe(4000);
    expect(utilityCapacity('School')).toBeUndefined();
  });

  it('capacityScalesWithAreaPerGdd', () => {
    expect(capacityResidentsForLevelArea('Residential', 1, 9)).toBe(4);
    expect(capacityResidentsForLevelArea('Residential', 1, 18)).toBe(8);
    expect(capacityJobsForLevelArea('Commercial', 1, 9)).toBe(3);
    expect(capacityJobsForLevelArea('Commercial', 1, 18)).toBe(6);
  });
});

describe('zone depth', () => {
  const road = (grid: MapGrid, x: number, y: number) => setRoad(grid, { x, y }, { dir: 'East' });

  it('isWithinZoneDepthFindsRoadAtZeroDistance', () => {
    const grid = new MapGrid(10, 10);
    road(grid, 5, 5);
    expect(isWithinZoneDepth(t(5, 5), grid, MAX_ZONE_DEPTH)).toBe(true);
  });

  it('isWithinZoneDepthFindsRoadAtAdjacentTile', () => {
    const grid = new MapGrid(10, 10);
    road(grid, 5, 4);
    expect(isWithinZoneDepth(t(5, 5), grid, MAX_ZONE_DEPTH)).toBe(true);
  });

  it('isWithinZoneDepthFindsRoadAtMaxDepth', () => {
    const grid = new MapGrid(20, 20);
    road(grid, 10, 10 - MAX_ZONE_DEPTH);
    expect(isWithinZoneDepth(t(10, 10), grid, MAX_ZONE_DEPTH)).toBe(true);
  });

  it('isWithinZoneDepthReturnsFalseBeyondMaxDepth', () => {
    const grid = new MapGrid(20, 20);
    road(grid, 10, 10 - (MAX_ZONE_DEPTH + 1));
    expect(isWithinZoneDepth(t(10, 10), grid, MAX_ZONE_DEPTH)).toBe(false);
  });

  it('isFootprintWithinZoneDepthChecksAllTiles', () => {
    const grid = new MapGrid(20, 20);
    for (let x = 10; x < 13; x++) road(grid, x, 9);
    expect(isFootprintWithinZoneDepth(t(10, 10), 3, 3, grid, MAX_ZONE_DEPTH)).toBe(true);
  });
});

describe('occupancy', () => {
  it('calculatePressureAtMidpointReturnsApproximatelyHalf', () => {
    expect(Math.abs(calculatePressure(0.3, 0.3, 6) - 0.5)).toBeLessThan(0.01);
  });

  it('calculatePressureAboveMidpointReturnsHighValue', () => {
    expect(calculatePressure(0.8, 0.3, 6)).toBeGreaterThan(0.9);
  });

  it('calculatePressureBelowMidpointReturnsLowValue', () => {
    expect(calculatePressure(-0.5, 0.3, 6)).toBeLessThan(0.1);
  });

  it('calculateTargetRatioClampsCorrectly', () => {
    expect(calculateTargetRatio(0.5)).toBe(1);
    expect(calculateTargetRatio(0.6)).toBe(1);
    expect(Math.abs(calculateTargetRatio(0.2) - 0.4)).toBeLessThan(0.001);
    expect(calculateTargetRatio(0)).toBe(0);
  });

  it('calculateFillDaysScalesWithLevelAndArea', () => {
    expect(Math.abs(calculateFillDays(1, 9, 0.5) - 1)).toBeLessThan(0.1);
    expect(Math.abs(calculateFillDays(3, 9, 0.5) - 3.5)).toBeLessThan(0.1);
    expect(Math.abs(calculateFillDays(3, 36, 0.5) - 7)).toBeLessThan(0.1);
  });

  it('calculateFillDaysScalesWithPressure', () => {
    expect(calculateFillDays(1, 9, 0.9)).toBeLessThan(calculateFillDays(1, 9, 0.1));
  });

  it('occupancyIncreasesEvenWhenFillDaysGtTwo', () => {
    const grid = new MapGrid(4, 4);
    setRoad(grid, t(0, 1), { dir: 'East' });
    const w = worldOn(grid);
    // d_mid = 0.3: pressure about one half, target ratio 1.
    w.rciDemand = { residential: 0.3, commercial: 0, industrial: 0 };
    // Power reaches every tile: this test is about fill days, not supply.
    w.utilityNetwork = UtilityNetwork.fromServed(new Uint8Array(16).fill(0b111));
    const b = w.buildings.add(newBuilding({ kind: 'Residential', anchor: t(1, 1), level: 3, capacityResidents: 30 }));
    w.events.dayAdvanced.push(1);
    updateOccupancy(w);
    expect(b.occupancyResidents, 'occupancy rises even when fill days exceed two').toBeGreaterThan(0);
  });
});

describe('parking spots', () => {
  it('calculateParkingSpotsSingleSpotAtCenter', () => {
    expect(calculateParkingSpots(t(10, 10), 3, 3, 1)).toEqual([t(11, 11)]);
  });

  const inside = (spots: readonly { x: number; y: number }[], anchor: { x: number; y: number }, w: number, l: number) =>
    spots.every((s) => s.x >= anchor.x && s.x < anchor.x + w && s.y >= anchor.y && s.y < anchor.y + l);

  it('calculateParkingSpotsMultipleSpotsDistributed', () => {
    const spots = calculateParkingSpots(t(10, 10), 6, 6, 4);
    expect(spots).toHaveLength(4);
    expect(inside(spots, t(10, 10), 6, 6)).toBe(true);
  });

  it('calculateParkingSpotsRespectsFootprintBounds', () => {
    const spots = calculateParkingSpots(t(5, 5), 4, 4, 9);
    expect(spots).toHaveLength(9);
    expect(inside(spots, t(5, 5), 4, 4)).toBe(true);
  });
});

describe('economic decay', () => {
  it('economicDecayAbandonsUnprofitableBuilding', () => {
    const grid = new MapGrid(8, 8);
    for (let dx = 0; dx < 3; dx++) {
      for (let dy = 0; dy < 3; dy++) {
        const cell = grid.get(t(2 + dx, 2 + dy))!;
        grid.set(t(2 + dx, 2 + dy), { ...cell, building: 'Commercial', zone: 'Commercial' });
      }
    }
    const w = worldOn(grid);
    w.city.day = 1;
    // No jobs filled: the largest daily loss.
    const b = w.buildings.add(newBuilding({ kind: 'Commercial', anchor: t(2, 2), capacityJobs: 10 }));

    w.events.dayAdvanced.push(1);
    buildingDecayEconomic(w);
    expect(b.economicDecay, 'the first day of losses arms the decay').not.toBeNull();
    expect(w.buildings.get(b.id), 'the building survives the grace day').toBeDefined();

    // Ten a day: past 100 after more than ten days.
    for (let day = 2; day <= 13; day++) {
      w.city.day = day;
      w.events = emptyEvents();
      w.events.dayAdvanced.push(day);
      buildingDecayEconomic(w);
    }
    expect(w.buildings.get(b.id), 'sustained losses abandon the building').toBeUndefined();
    expect(w.grid.get(t(3, 3))!.building, 'and clear its tiles').toBeNull();
  });
});
