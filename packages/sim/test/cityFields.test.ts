// Port of the tests in crates/simcity_sim/src/game/city_fields.rs. Education weighs homes by their nearness along the axes
// here (Rust: as the crow flies): the simulation has no `sqrt`.
import { describe, expect, it } from 'vitest';
import { newBuilding } from '../src/buildings/building';
import { LOW_HAPPINESS_THRESHOLD, buildingDecayLowHappiness } from '../src/buildings/decay';
import {
  CITY_FIELDS,
  CITY_FIELDS_CHUNK_TILES,
  CityFields,
  EDUCATION_FOR_HIGH_JOBS,
  FIRE_HAZARD_LIMIT,
  HEALTH_FOR_LEVEL_THREE,
  attractiveness,
  cityFieldNeutral,
  crime,
  education,
  fireHazard,
  health,
  noInputs,
  workplaceClass,
  type TileInputs,
} from '../src/cityFields';
import { computeCityFields } from '../src/cityFieldsCompute';
import { MASK_FIRE, MASK_MEDICAL, MASK_POLICE } from '../src/services/coverage';
import { createWorld } from '../src/world';

const t = (x: number, y: number) => ({ x, y });
const inputs = (extra: Partial<TileInputs> = {}): TileInputs => ({ ...noInputs(), landValue: 0.5, ...extra });

describe('city fields', () => {
  it('cityFieldsCrimeRisesWherePeopleLiveAndFallsUnderPolice', () => {
    const empty = inputs();
    const built = inputs({ built: true, zoned: true });
    expect(crime(built), 'people bring crime').toBeGreaterThan(crime(empty));
    expect(crime({ ...built, police: true }), 'police keep it down').toBeLessThan(crime(built));
    expect(crime({ ...built, unemployment: 0.6 }), 'unemployment feeds it').toBeGreaterThan(crime(built));
  });

  it('cityFieldsFireHazardRisesWithIndustryAndFallsUnderFireCover', () => {
    const house = inputs({ built: true, zoned: true });
    const factory = { ...house, industrial: true, pollution: 0.6 };
    expect(fireHazard(factory), 'an uncovered factory is a fire risk').toBeGreaterThanOrEqual(FIRE_HAZARD_LIMIT);
    expect(fireHazard(house), 'a house is not').toBeLessThan(FIRE_HAZARD_LIMIT);
    expect(fireHazard({ ...factory, fireCover: true }), 'a fire station makes the factory safe').toBeLessThan(FIRE_HAZARD_LIMIT);
  });

  it('cityFieldsHealthRisesWithHospitalAndGarbageAndFallsWithPollution', () => {
    const bare = inputs();
    expect(health(bare), 'no hospital and no collection').toBeLessThan(HEALTH_FOR_LEVEL_THREE);
    expect(health({ ...bare, garbage: true })).toBeGreaterThanOrEqual(HEALTH_FOR_LEVEL_THREE);
    expect(health({ ...bare, medical: true })).toBeGreaterThanOrEqual(HEALTH_FOR_LEVEL_THREE);
    expect(health({ ...bare, medical: true, garbage: true, pollution: 1 }), 'pollution undoes both').toBeLessThan(HEALTH_FOR_LEVEL_THREE);
  });

  it('cityFieldsEducationFollowsTheClassOfTheHomesAround', () => {
    const home = (x: number, wealth: 'High' | 'Low') => ({ centerX: x, centerY: 0, residents: 20, wealth });
    const at = t(2, 0);
    expect(education(at, [home(0, 'High')])).toBeGreaterThan(EDUCATION_FOR_HIGH_JOBS);
    expect(education(at, [home(0, 'Low')])).toBeLessThan(EDUCATION_FOR_HIGH_JOBS);
    expect(education(t(40, 0), [home(0, 'High')]), 'nobody lives within reach').toBe(0);
    const mixed = [home(0, 'High'), home(30, 'Low')];
    expect(education(at, mixed), 'nearer homes count more').toBeGreaterThan(education(t(25, 0), mixed));
  });

  it('cityFieldsAttractivenessAddsUpTheOtherFields', () => {
    const good = attractiveness(0.8, 0.1, 0.8, 0.8, 0);
    expect(attractiveness(0.2, 0.1, 0.8, 0.8, 0), 'land value').toBeLessThan(good);
    expect(attractiveness(0.8, 0.9, 0.8, 0.8, 0), 'crime').toBeLessThan(good);
    expect(attractiveness(0.8, 0.1, 0.2, 0.8, 0), 'health').toBeLessThan(good);
    expect(attractiveness(0.8, 0.1, 0.8, 0.1, 0), 'education').toBeLessThan(good);
    expect(attractiveness(0.8, 0.1, 0.8, 0.8, 0.9), 'pollution').toBeLessThan(good);
  });

  it('cityFieldsAreComputedFromTheCityOnEveryTile', () => {
    // A policed, hospital- and fire-covered row of homes against an uncovered row of factories.
    const w = createWorld({ mapWidth: 8, mapHeight: 1 });
    for (let x = 0; x < 8; x++) {
      const cell = w.grid.get(t(x, 0))!;
      w.grid.set(t(x, 0), { ...cell, zone: 'Residential', building: x < 4 ? 'Residential' : 'Industrial' });
    }
    w.serviceCoverage.coverageMap = Uint8Array.from({ length: 8 }, (_, x) => (x < 4 ? MASK_FIRE | MASK_POLICE | MASK_MEDICAL : 0));
    computeCityFields(w);

    const f = w.cityFields;
    expect(f.covers(8)).toBe(true);
    expect(f.get('Crime', 0)).toBeLessThan(f.get('Crime', 7));
    expect(f.get('FireHazard', 0)).toBeLessThan(FIRE_HAZARD_LIMIT);
    expect(f.get('FireHazard', 7)).toBeGreaterThanOrEqual(FIRE_HAZARD_LIMIT);
    expect(f.get('Health', 0)).toBeGreaterThan(f.get('Health', 7));
    expect(f.get('Attractiveness', 0)).toBeGreaterThan(f.get('Attractiveness', 7));
    expect(f.version, 'a published chunk bumps the version').toBeGreaterThan(0);
  });

  // Not a Rust test: the fields go a chunk a tick, like land value, and a whole pass covers the map.
  it('cityFieldsAreComputedAChunkATick', () => {
    const w = createWorld({ mapWidth: 20, mapHeight: 10 });
    const f = w.cityFields;
    computeCityFields(w);
    expect([f.version, f.currentChunk, f.chunkSize, f.tiles]).toEqual([1, 1, CITY_FIELDS_CHUNK_TILES, 200]);
    expect(f.get('Crime', CITY_FIELDS_CHUNK_TILES), 'the next chunk is still neutral').toBe(cityFieldNeutral('Crime'));
    expect(f.get('Crime', 0), 'the first is measured: bare land draws less crime than it is thought to').toBeLessThan(cityFieldNeutral('Crime'));
    for (let pass = 1; pass < 4; pass++) computeCityFields(w);
    expect([f.version, f.currentChunk], 'four chunks of 64 cover 200 tiles, and it starts over').toEqual([4, 0]);
    expect(f.get('Crime', 199)).toBeLessThan(cityFieldNeutral('Crime'));
  });

  it('cityFieldsResetToNeutralForANewMap', () => {
    const f = new CityFields();
    f.setValues('Crime', new Float32Array(4).fill(0.9));
    const before = f.version;
    f.resetValues();
    for (const field of CITY_FIELDS) expect([...f.values(field)].every((v) => v === cityFieldNeutral(field)), `${field} back to neutral`).toBe(true);
    expect(f.version).toBeGreaterThan(before);
  });

  it('cityFieldsUneducatedNeighbourhoodGivesWorkplacesNoHighClass', () => {
    expect(workplaceClass('High', 0.1)).toBe('Middle');
    expect(workplaceClass('High', 0.8)).toBe('High');
    expect(workplaceClass('High', undefined), 'unmeasured education takes nothing away').toBe('High');
    expect(workplaceClass('Low', 0.9), 'education does not raise the land class').toBe('Low');
  });

  it('cityFieldsCrimeAbandonsHomes', () => {
    for (const [level, decays] of [
      [0.2, false],
      [0.95, true],
    ] as const) {
      const w = createWorld({ mapWidth: 6, mapHeight: 6 });
      w.appState = 'InGame';
      w.cityFields.setValues('Crime', new Float32Array(36).fill(level));
      const house = w.buildings.add(
        newBuilding({ kind: 'Residential', anchor: t(1, 1), capacityResidents: 12, occupancyResidents: 12, targetOccupancyResidents: 12 }),
      );
      w.city.day = 1;
      buildingDecayLowHappiness(w);
      expect(house.lowHappinessDecay !== null, `a full house at crime ${level} (threshold ${LOW_HAPPINESS_THRESHOLD})`).toBe(decays);
    }
  });
});
