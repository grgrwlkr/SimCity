// Port of the tests in crates/simcity_sim/src/game/buildings/blockers.rs: why a zone does not grow and
// a building does not rise, and how density and wealth class shape what grows.
import { describe, expect, it } from 'vitest';
import type { ZoneDensity } from '../../src/commands';
import {
  BUILDINGS_WITHOUT_POWER,
  blockerReason,
  growthBlockers,
  reportBuildingsWithoutPower,
  tileDiagnosis,
  upgradeBlocker,
} from '../../src/buildings/blockers';
import {
  capacityResidentsForLevelArea,
  densityHeightFactor,
  densityLevels,
  footprintSides,
  profileCapacity,
  type BuildingProfile,
} from '../../src/buildings/building';
import { buildingDecayLowHappiness } from '../../src/buildings/decay';
import { growBuildings } from '../../src/buildings/growth';
import { updateOccupancy } from '../../src/buildings/occupancy';
import { CityFields, type CityField } from '../../src/cityFields';
import { emptyEvents } from '../../src/events';
import { MapGrid } from '../../src/map/grid';
import type { World } from '../../src/world';
import { block, demand, house, network, roadRow, station, t, worldOn, zoneRect } from './helpers';

const PROFILE: BuildingProfile = { density: 'Medium', class: 'Middle' };

/** `growth_app`: the network as the grid stands, full residential demand. */
function growthWorld(grid: MapGrid): World {
  const w = worldOn(grid);
  w.utilityNetwork = network(grid);
  w.rciDemand = demand(1);
  return w;
}

/** Hour events of day 1, one `growBuildings` each; the number of buildings after. */
function growForHours(w: World, hours: number): number {
  for (let hour = 0; hour < hours; hour++) {
    w.events = emptyEvents();
    w.events.hourAdvanced.push({ hour, day: 1 });
    growBuildings(w);
  }
  return w.buildings.all().length;
}

function fieldsOver(grid: MapGrid, field: CityField, value: number): CityFields {
  const fields = new CityFields();
  fields.setValues(field, new Float32Array(grid.len()).fill(value));
  return fields;
}

function suppliedBlock(): MapGrid {
  const grid = block();
  station(grid, 'PowerPlant', 16, 3);
  station(grid, 'WaterPump', 20, 3);
  return grid;
}

/** Roads along y = 2 and y = 9 with a residential zone of `density` between them and a plant. */
function twoRoadBlock(density: ZoneDensity): MapGrid {
  const grid = new MapGrid(30, 12);
  roadRow(grid, 2, 0, 29);
  roadRow(grid, 9, 0, 29);
  zoneRect(grid, 'Residential', 4, 20, 3, 8, density);
  station(grid, 'PowerPlant', 24, 3);
  return grid;
}

function standOn(grid: MapGrid, x: number, y: number): void {
  const cell = grid.get(t(x, y))!;
  grid.set(t(x, y), { ...cell, building: 'Residential' });
}

describe('growth blockers', () => {
  it('utilityNetworkGrowthBlockersNameTheMissingUtility', () => {
    const grid = block();
    const zoned = t(8, 4);
    expect(growthBlockers(grid, network(grid), demand(1), zoned, undefined)).toEqual(['NoPower']);
    expect(growthBlockers(grid, network(grid), demand(0), zoned, undefined)).toEqual(['NoPower', 'NoDemand']);

    station(grid, 'PowerPlant', 16, 3);
    expect(growthBlockers(grid, network(grid), demand(1), zoned, undefined)).toEqual([]);

    zoneRect(grid, 'Residential', 4, 6, 9, 10);
    expect(growthBlockers(grid, network(grid), demand(1), t(5, 10), undefined)).toEqual(['NoRoad']);
    expect(growthBlockers(grid, network(grid), demand(1), t(20, 10), undefined)).toEqual(['NotZoned']);
    expect(blockerReason('NoPower')).toBe('No power');
  });

  it('utilityNetworkUnpoweredZoneDoesNotGrow', () => {
    expect(growForHours(growthWorld(block()), 12), 'no power, no growth').toBe(0);
    const grid = block();
    station(grid, 'PowerPlant', 16, 3);
    expect(growForHours(growthWorld(grid), 12), 'the same block with power grows').toBeGreaterThan(0);
  });

  it('utilityNetworkUnpoweredBuildingLosesItsOccupants', () => {
    for (const powered of [false, true]) {
      const grid = block();
      if (powered) station(grid, 'PowerPlant', 16, 3);
      const w = worldOn(grid);
      w.rciDemand = demand(0.3);
      w.utilityNetwork = network(grid);
      const b = w.buildings.add(house(1));
      w.events.dayAdvanced.push(1);
      updateOccupancy(w);
      if (powered) {
        expect(b.occupancyResidents, 'power keeps residents').toBeGreaterThanOrEqual(10);
      } else {
        expect(b.occupancyResidents, 'without power residents leave').toBeLessThan(10);
        expect(b.targetOccupancyResidents).toBe(0);
      }
    }
  });

  it('utilityNetworkTileDiagnosisNamesTheReasonForAPlayer', () => {
    const grid = block();
    const zoned = t(8, 4);
    expect(tileDiagnosis(grid, network(grid), demand(1), zoned, undefined)).toEqual(['Residential zone', "Won't grow: No power"]);
    expect(tileDiagnosis(grid, network(grid), demand(0), zoned, undefined)).toEqual([
      'Residential zone',
      "Won't grow: No power, No demand",
    ]);
    expect(tileDiagnosis(grid, network(grid), demand(1), t(20, 10), undefined), 'an unzoned tile has nothing to explain').toBeNull();

    standOn(grid, 5, 3);
    expect(tileDiagnosis(grid, network(grid), demand(1), t(5, 3), undefined)).toEqual(['Residential zone', 'No power: occupants are leaving']);

    station(grid, 'PowerPlant', 16, 3);
    expect(tileDiagnosis(grid, network(grid), demand(1), zoned, undefined)).toBeNull();
    expect(tileDiagnosis(grid, network(grid), demand(1), t(5, 3), undefined)).toEqual([
      'Residential zone',
      'No water: cannot rise above level 1',
    ]);
  });

  it('utilityNetworkFeedReportsBuildingsWithoutPowerWhereTheyAre', () => {
    for (const powered of [false, true]) {
      const grid = block();
      if (powered) station(grid, 'PowerPlant', 16, 3);
      const w = worldOn(grid);
      w.utilityNetwork = network(grid);
      w.buildings.add(house(1));
      w.buildings.add(house(1, { anchor: t(9, 3) }));
      w.events.dayAdvanced.push(1);
      reportBuildingsWithoutPower(w);

      const lines = w.notifications.messages();
      if (powered) {
        expect(lines, 'powered buildings raise nothing').toEqual([]);
      } else {
        expect(lines, 'one line, however many buildings').toHaveLength(1);
        expect(lines[0]!.text).toBe(BUILDINGS_WITHOUT_POWER);
        expect(lines[0]!.kind).toBe('Warning');
        expect(lines[0]!.at, 'the first of them').toEqual(t(4, 3));
      }
    }
  });
});

describe('zone density and class', () => {
  it('zoneDensitySetsFootprintLevelsCapacityAndHeight', () => {
    expect(footprintSides('Low')).toEqual([3, 4]);
    expect(footprintSides('Medium')).toEqual([3, 6]);
    expect(footprintSides('High'), 'a zone is three tiles deep, so no density may need a fourth').toEqual([3, 6]);
    expect(densityLevels('Low')).toEqual([1, 2]);
    expect(densityLevels('Medium')).toEqual([1, 3]);
    expect(densityLevels('High')).toEqual([2, 3]);

    const homes = (density: ZoneDensity) => profileCapacity('Residential', 2, 16, { ...PROFILE, density })[0];
    expect(homes('Medium'), 'Medium holds what every building held before densities').toBe(capacityResidentsForLevelArea('Residential', 2, 16));
    expect(homes('High')).toBeGreaterThan(homes('Medium'));
    const shops = (density: ZoneDensity) => profileCapacity('Commercial', 2, 16, { ...PROFILE, density })[1];
    expect(shops('High')).toBeGreaterThan(shops('Medium'));
    expect(densityHeightFactor('High')).toBeGreaterThan(densityHeightFactor('Medium'));
    expect(densityHeightFactor('Medium')).toBeGreaterThan(densityHeightFactor('Low'));
  });

  // A zone reaches three tiles deep: a density whose buildings needed a fourth never grew beside one road.
  it('zoneDensityHighZoneGrowsBesideASingleRoad', () => {
    const grid = new MapGrid(24, 12);
    roadRow(grid, 2, 0, 23);
    zoneRect(grid, 'Residential', 4, 15, 3, 5, 'High');
    station(grid, 'PowerPlant', 18, 3);
    const w = growthWorld(grid);
    expect(growForHours(w, 48), 'a High zone three tiles deep beside one road grows').toBeGreaterThan(0);
    expect(w.buildings.all().every((b) => b.profile.density === 'High')).toBe(true);
  });

  // A big building fills at the market's pace and is not abandoned for being half empty while it
  // fills; one that had its weeks and stayed empty, or one the market gives nobody, still decays.
  it('zoneDensityALargeBuildingFillingAtTheMarketPaceIsNotAbandoned', () => {
    const decays = (occupancy: number, target: number, startDay: number, today: number) => {
      const w = worldOn(block());
      w.rciDemand = demand(0.08);
      w.city.day = today;
      const b = w.buildings.add(
        house(2, { length: 6, capacityResidents: 36, occupancyResidents: occupancy, targetOccupancyResidents: target, constructionStartDay: startDay }),
      );
      w.events.dayAdvanced.push(today);
      buildingDecayLowHappiness(w);
      return b.lowHappinessDecay !== null;
    };
    expect(decays(2, 15, 4, 10), 'three days open, two of fifteen: still filling at the market pace').toBe(false);
    expect(decays(2, 15, 4, 60), 'fifty days open and still two of fifteen: it failed to fill').toBe(true);
    expect(decays(0, 0, 4, 10), 'a building the market gives nobody').toBe(true);
  });

  it('zoneDensityHighZoneGrowsLargeTallBuildingsAndLowZoneSmallOnes', () => {
    for (const density of ['Low', 'High'] as const) {
      const w = growthWorld(twoRoadBlock(density));
      growForHours(w, 48);
      const grown = w.buildings.all();
      expect(grown.length, `the ${density} block grows`).toBeGreaterThan(0);
      const [shortest, longest] = footprintSides(density);
      const [firstLevel] = densityLevels(density);
      for (const b of grown) {
        expect(b.profile.density).toBe(density);
        expect(Math.min(b.width, b.length) >= shortest && Math.max(b.width, b.length) <= longest, `${density} grew ${b.width}x${b.length}`).toBe(true);
        expect(b.level, `a new ${density} building starts at ${firstLevel}`).toBe(firstLevel);
      }
    }
  });

  it('zoneDensityClassChangesHowManyABuildingHolds', () => {
    const homes = (wealth: BuildingProfile['class']) => profileCapacity('Residential', 2, 16, { ...PROFILE, class: wealth })[0];
    expect(homes('Middle')).toBe(capacityResidentsForLevelArea('Residential', 2, 16));
    expect(homes('Low')).toBeGreaterThan(homes('Middle'));
    expect(homes('Middle')).toBeGreaterThan(homes('High'));
  });
});

describe('upgrade blockers', () => {
  it('utilityNetworkBuildingWithoutWaterStaysAtLevelOne', () => {
    const grid = block();
    expect(upgradeBlocker(house(1), grid, network(grid), demand(0.5), undefined)).toBe('NoPower');
    station(grid, 'PowerPlant', 16, 3);
    expect(upgradeBlocker(house(1), grid, network(grid), demand(0.5), undefined)).toBe('NoWater');
    station(grid, 'WaterPump', 20, 3);
    expect(upgradeBlocker(house(1), grid, network(grid), demand(0.5), undefined)).toBeNull();
    expect(upgradeBlocker(house(1), grid, network(grid), demand(0.1), undefined)).toBe('NoDemand');
    expect(upgradeBlocker(house(3), grid, network(grid), demand(0.5), undefined)).toBe('TopLevel');
  });

  it('cityFieldsFireHazardHoldsBuildingsBack', () => {
    const grid = suppliedBlock();
    const risky = fieldsOver(grid, 'FireHazard', 0.8);
    expect(upgradeBlocker(house(1), grid, network(grid), demand(0.5), risky)).toBe('FireHazard');
    expect(upgradeBlocker(house(1), grid, network(grid), demand(0.5), fieldsOver(grid, 'FireHazard', 0.2))).toBeNull();
    expect(blockerReason('FireHazard')).toBe('High fire hazard');

    standOn(grid, 5, 3);
    expect(tileDiagnosis(grid, network(grid), demand(1), t(5, 3), risky)).toEqual(['Residential zone', 'High fire hazard: cannot rise']);
  });

  it('cityFieldsPoorHealthKeepsHomesBelowLevelThree', () => {
    const grid = suppliedBlock();
    const sick = fieldsOver(grid, 'Health', 0.3);
    const tall = house(2, { profile: { density: 'High', class: 'Middle' } });
    expect(upgradeBlocker(tall, grid, network(grid), demand(0.5), sick)).toBe('PoorHealth');
    expect(upgradeBlocker(tall, grid, network(grid), demand(0.5), fieldsOver(grid, 'Health', 0.8))).toBeNull();
    expect(upgradeBlocker(house(1), grid, network(grid), demand(0.5), sick), 'poor health does not stop a home first step').toBeNull();
    expect(blockerReason('PoorHealth')).toBe('Poor health');

    standOn(grid, 5, 3);
    expect(tileDiagnosis(grid, network(grid), demand(1), t(5, 3), sick)).toEqual(['Residential zone', 'Poor health: cannot reach level 3']);
  });

  it('cityFieldsUnattractiveZoneDoesNotGrowAndSaysWhy', () => {
    const lit = () => {
      const grid = block();
      station(grid, 'PowerPlant', 16, 3);
      return grid;
    };
    const grid = lit();
    const bleak = fieldsOver(grid, 'Attractiveness', 0.1);
    const fair = fieldsOver(grid, 'Attractiveness', 0.8);
    expect(growthBlockers(grid, network(grid), demand(1), t(8, 4), bleak)).toEqual(['Unattractive']);
    expect(growthBlockers(grid, network(grid), demand(1), t(8, 4), fair)).toEqual([]);
    expect(blockerReason('Unattractive')).toBe('Unattractive location');

    const shunned = growthWorld(lit());
    shunned.cityFields = bleak;
    expect(growForHours(shunned, 12), 'nobody builds where nobody wants to be').toBe(0);
    const wanted = growthWorld(lit());
    wanted.cityFields = fair;
    expect(growForHours(wanted, 12), 'the same block, attractive, grows').toBeGreaterThan(0);
  });

  // TS: the class comes from the land value over the whole footprint. Rust read the anchor tile alone, so of two equal
  // buildings on one road the one whose anchor corner touched the road grew rich and the one across it did not.
  it('zoneDensityClassComesFromTheLandOverTheFootprintNotItsAnchorCorner', () => {
    const grid = new MapGrid(24, 12);
    roadRow(grid, 2, 0, 23);
    zoneRect(grid, 'Residential', 4, 12, 3, 5);
    station(grid, 'PowerPlant', 16, 3);
    const w = growthWorld(grid);
    // Land value as its pass leaves it: the row beside the road dearer, the rows behind it middling.
    const land = new Float32Array(grid.len()).fill(0.5);
    for (let x = 0; x < grid.width; x++) land[grid.idx(t(x, 3))!] = Math.fround(0.7);
    w.landValue.values = land;
    expect(growForHours(w, 12), 'homes grow').toBeGreaterThan(0);
    const classes = w.buildings.all().map((b) => b.profile.class);
    expect(classes.every((c) => c === 'Middle'), `a home three rows deep off a road is middle class: ${classes.join(' ')}`).toBe(true);
  });

  it('cityFieldsUneducatedNeighbourhoodGrowsNoHighClassJobs', () => {
    for (const [education, expected] of [
      [0.1, 'Middle'],
      [0.9, 'High'],
    ] as const) {
      const grid = new MapGrid(24, 12);
      roadRow(grid, 2, 0, 23);
      zoneRect(grid, 'Commercial', 4, 12, 3, 5);
      station(grid, 'PowerPlant', 16, 3);
      const w = growthWorld(grid);
      w.cityFields = fieldsOver(grid, 'Education', education);
      w.landValue.values = new Float32Array(grid.len()).fill(0.9);
      w.rciDemand = demand(0, 1, 0);
      expect(growForHours(w, 12), 'commerce grows').toBeGreaterThan(0);
      const classes = w.buildings.all().map((b) => b.profile.class);
      expect(classes.every((c) => c === expected), `education ${education}: ${classes.join(' ')}`).toBe(true);
    }
  });
});
