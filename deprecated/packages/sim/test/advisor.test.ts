// Ported from crates/simcity_sim/src/game/advisor.rs (mod tests) at tag rust-final: the city's problems ranked by how
// badly they hurt, each named with the thing that is missing and its numbers, reassessed once a game hour.
import { describe, expect, it } from 'vitest';
import { advisorInputs, assess, thousands, updateAdvisor, type AdvisorInputs, type UtilityReading } from '../src/advisor';
import { runFixedTick } from '../src/app';
import { newBuilding } from '../src/buildings/building';
import { FIXED_UPDATE } from '../src/schedule';
import { MASK_FIRE, MASK_MEDICAL, MASK_POLICE } from '../src/services/coverage';
import { SECOND_NS } from '../src/timer';
import { createWorld } from '../src/world';

function reading(supply: number, demand: number, supplied: number, without: number): UtilityReading {
  return { supply, demand, supplied, buildingsWithout: without, firstWithout: without > 0 ? { x: 9, y: 4 } : null };
}

/** A city with nothing wrong in it. */
function healthy(): AdvisorInputs {
  return {
    buildings: 100,
    utilities: [reading(5000, 2000, 2000, 0), reading(5000, 2000, 2000, 0), reading(4000, 2000, 2000, 0)],
    workers: 300,
    unemployed: 9,
    unemployedByClass: [5, 3, 1],
    demandResidential: 0.3,
    demandCommercial: 0.2,
    demandIndustrial: 0.1,
    population: 400,
    schoolOpen: true,
    residentsBeyondSchool: 20,
    crowdedSchool: null,
    crimeShare: 0.02,
    fireShare: 0.01,
    poorHealthShare: 0.05,
    policeCover: 0.9,
    fireCover: 0.9,
    medicalCover: 0.9,
    money: 20_000,
    monthRunningNet: 800,
    monthDays: 10,
  };
}

const texts = (inputs: AdvisorInputs): string[] => assess(inputs).map((problem) => problem.text);

describe('advisor', () => {
  // advisor.rs `advisor_a_healthy_city_gets_no_advice`
  it('advisorAHealthyCityGetsNoAdvice', () => {
    expect(assess(healthy())).toEqual([]);
    expect(thousands(6200)).toBe('6 200');
    expect(thousands(-1_234_567)).toBe('-1 234 567');
    expect(thousands(12)).toBe('12');
  });

  // advisor.rs `advisor_names_the_water_shortage_with_its_numbers`: a shortage is named as the thing that is short, with
  // what is supplied and what is needed, and a building that goes without to look at.
  it('advisorNamesTheWaterShortageWithItsNumbers', () => {
    const inputs = healthy();
    inputs.utilities[1] = reading(5000, 6200, 4900, 40);
    const problems = assess(inputs);
    const worst = problems[0];
    expect(worst?.kind).toBe('WaterShortage');
    expect(worst?.text).toBe('Не хватает воды: водокачки дают 5 000, городу нужно 6 200');
    expect(worst?.at).toEqual({ x: 9, y: 4 });
    expect(problems).toHaveLength(1);
  });

  // advisor.rs `advisor_without_a_station_says_which_and_counts_the_buildings`
  it('advisorWithoutAStationSaysWhichAndCountsTheBuildings', () => {
    let inputs = healthy();
    inputs.utilities[1] = reading(0, 0, 0, 245);
    expect(texts(inputs)).toEqual(['В городе нет водокачки: 245 зданий без воды']);
    inputs = healthy();
    inputs.utilities[0] = reading(5000, 1000, 1000, 12);
    expect(texts(inputs)).toEqual(['12 зданий без электричества: нет дороги до электростанции']);
    inputs = healthy();
    inputs.utilities[2] = reading(4000, 4900, 3900, 30);
    expect(texts(inputs)).toEqual(['Не хватает вывоза мусора: свалки принимают 4 000, городу нужно 4 900']);
  });

  // Not in Rust: Russian counts agree with their nouns — 1 здание, 3 здания, 245 зданий.
  it('advisorCountsAgreeWithTheirNouns', () => {
    let inputs = healthy();
    inputs.utilities[1] = reading(0, 0, 0, 1);
    expect(texts(inputs)).toEqual(['В городе нет водокачки: 1 здание без воды']);
    inputs = healthy();
    inputs.utilities[0] = reading(5000, 1000, 1000, 3);
    expect(texts(inputs)).toEqual(['3 здания без электричества: нет дороги до электростанции']);
    inputs = healthy();
    inputs.population = 5000;
    inputs.residentsBeyondSchool = 101;
    inputs.crowdedSchool = { residents: 1022, places: 21, at: { x: 1, y: 1 } };
    const shown = texts(inputs);
    expect(shown).toContain('Нет школы рядом: 101 житель вне охвата школ');
    expect(shown).toContain('Школа переполнена: 1 022 жителя на 21 место');
  });

  // advisor.rs `advisor_puts_the_worst_problem_first`
  it('advisorPutsTheWorstProblemFirst', () => {
    const inputs = healthy();
    inputs.demandResidential = 0.6;
    inputs.monthRunningNet = -300;
    inputs.utilities[0] = reading(5000, 9000, 5000, 120);
    const problems = assess(inputs);
    expect(problems).toHaveLength(3);
    expect(problems[0]?.kind).toBe('PowerShortage');
    for (let i = 1; i < problems.length; i++) {
      expect(problems[i - 1]!.severity, 'worst first').toBeGreaterThanOrEqual(problems[i]!.severity);
    }
    for (const problem of problems) {
      expect(problem.severity).toBeGreaterThanOrEqual(0);
      expect(problem.severity).toBeLessThanOrEqual(1);
    }
  });

  // advisor.rs `advisor_names_unemployment_and_who_is_out_of_work`
  it('advisorNamesUnemploymentAndWhoIsOutOfWork', () => {
    const inputs = healthy();
    inputs.workers = 1000;
    inputs.unemployed = 180;
    inputs.unemployedByClass = [120, 50, 10];
    expect(texts(inputs)).toEqual(['Безработица 18 %: 180 жителей без работы, больше всего бедных']);
  });

  // advisor.rs `advisor_names_housing_and_jobs_demand`
  it('advisorNamesHousingAndJobsDemand', () => {
    const inputs = healthy();
    inputs.demandResidential = 0.72;
    inputs.demandCommercial = 0.64;
    inputs.demandIndustrial = 0.58;
    const shown = texts(inputs);
    expect(shown).toContain('Нужно жильё: жилой спрос 72 %');
    expect(shown).toContain('Нужны рабочие места: торговый спрос 64 %, промышленный 58 %');
  });

  // advisor.rs `advisor_names_schools_once_they_can_be_built`
  it('advisorNamesSchoolsOnceTheyCanBeBuilt', () => {
    const inputs = healthy();
    inputs.population = 600;
    inputs.residentsBeyondSchool = 450;
    inputs.crowdedSchool = { residents: 800, places: 400, at: { x: 30, y: 12 } };
    inputs.schoolOpen = false;
    expect(assess(inputs), 'no advice the player cannot act on').toEqual([]);

    inputs.schoolOpen = true;
    const problems = assess(inputs);
    const shown = problems.map((problem) => problem.text);
    expect(shown).toContain('Нет школы рядом: 450 жителей вне охвата школ');
    expect(shown).toContain('Школа переполнена: 800 жителей на 400 мест');
    expect(problems.find((problem) => problem.kind === 'SchoolOvercrowded')?.at).toEqual({ x: 30, y: 12 });
  });

  // advisor.rs `advisor_names_crime_fire_and_health_with_their_cover`
  it('advisorNamesCrimeFireAndHealthWithTheirCover', () => {
    const inputs = healthy();
    inputs.crimeShare = 0.23;
    inputs.policeCover = 0.4;
    inputs.fireShare = 0.15;
    inputs.fireCover = 0.3;
    inputs.poorHealthShare = 0.35;
    inputs.medicalCover = 0.2;
    const shown = texts(inputs);
    for (const expected of [
      'Высокая преступность в 23 % города: полиция охватывает 40 % зданий',
      'Пожароопасно в 15 % города: пожарные части охватывают 30 % зданий',
      'Плохое здоровье в 35 % домов: больницы охватывают 20 % зданий',
    ]) {
      expect(shown).toContain(expected);
    }
  });

  // advisor.rs `advisor_names_the_budget_deficit_and_an_empty_treasury`
  it('advisorNamesTheBudgetDeficitAndAnEmptyTreasury', () => {
    const inputs = healthy();
    inputs.monthRunningNet = -1200;
    expect(texts(inputs)).toEqual(['Дефицит бюджета: содержание и выплаты по займам превышают налоги на $1 200 за этот месяц']);
    inputs.money = -3000;
    const problems = assess(inputs);
    expect(problems[0]?.kind).toBe('EmptyTreasury');
    expect(problems[0]?.text).toBe('Казна пуста: долг $3 000');
  });

  // advisor.rs `advisor_counts_service_cover_over_the_buildings_standing_now`: the cover the advisor quotes is the cover
  // of the buildings standing now, not a total counted at the last map edit.
  it('advisorCountsServiceCoverOverTheBuildingsStandingNow', () => {
    const w = createWorld({ mapWidth: 8, mapHeight: 1 });
    for (const x of [0, 4]) {
      for (let dx = 0; dx < 3; dx++) {
        const pos = { x: x + dx, y: 0 };
        w.grid.set(pos, { ...w.grid.get(pos)!, zone: 'Residential', building: 'Residential' });
      }
      w.buildings.add(
        newBuilding({ kind: 'Residential', anchor: { x, y: 0 }, width: 3, length: 1, level: 1, capacityResidents: 4, occupancyResidents: 4, targetOccupancyResidents: 4 }),
      );
    }
    w.serviceCoverage.coverageMap = new Uint8Array(w.grid.len());
    w.serviceCoverage.coverageMap.fill(MASK_POLICE, 0, 3);
    w.cityFields.setValues('Crime', new Float32Array(w.grid.len()).fill(0.9));

    updateAdvisor(w);
    const crime = w.advisor.problems.find((problem) => problem.kind === 'Crime');
    expect(crime?.text, 'crime everywhere is a problem').toBe('Высокая преступность в 100 % города: полиция охватывает 50 % зданий');
    expect(advisorInputs(w).buildings).toBe(2);
  });

  // advisor.rs `advisor_reassesses_the_city_each_game_hour`: the advice follows the city hour by hour and stands in
  // between. As in Rust, the first update of a new world assesses it too; in TS the tick its first game minute of stats
  // is in reassesses once more (a one-second test hour makes that the second tick).
  it('advisorReassessesTheCityEachGameHour', () => {
    const systems = FIXED_UPDATE.filter((system) => ['beginTickEvents', 'simTick', 'updateAdvisor'].includes(system.name));
    const w = createWorld({ mapWidth: 8, mapHeight: 8, gameHourNs: SECOND_NS });
    w.appState = 'InGame';
    w.city.money = -500;
    const ticksAnHour = 10;
    const worst = (): string | undefined => w.advisor.worst()?.kind;
    const run = (ticks: number): void => {
      for (let i = 0; i < ticks; i++) runFixedTick(w, systems);
    };

    run(2);
    expect(worst()).toBe('EmptyTreasury');

    w.city.money = 9000;
    run(ticksAnHour - 3);
    expect(w.city.hour).toBe(0);
    expect(worst(), 'between hours the advice stands').toBe('EmptyTreasury');

    run(1);
    expect(w.city.hour).toBe(1);
    expect(worst()).toBeUndefined();
    expect(w.advisor.version).toBe(3);
  });

  // Not in Rust: a new world is assessed on its first fixed tick, once more on the tick its first game minute of
  // employment, demand and coverage has run (the first assessment read them empty), and after that only on the hour.
  it('advisorAssessesANewWorldOnItsFirstTickAndMinuteThenOnTheHour', () => {
    const w = createWorld({ mapWidth: 8, mapHeight: 8 });
    w.appState = 'InGame';
    w.city.money = -500;
    expect(w.advisor.version).toBe(0);
    runFixedTick(w);
    expect(w.advisor.version, 'assessed on the first tick').toBe(1);
    expect(w.advisor.worst()?.kind).toBe('EmptyTreasury');
    const minute = 600;
    for (let i = 1; i < minute - 1; i++) runFixedTick(w);
    expect(w.advisor.version, 'not within the first minute').toBe(1);
    runFixedTick(w);
    expect(w.advisor.version, 'on the tick the first minute of stats is in').toBe(2);
    for (let i = 0; i < minute; i++) runFixedTick(w);
    expect(w.advisor.version, 'not on later minutes').toBe(2);

    const quick = createWorld({ mapWidth: 8, mapHeight: 8, gameHourNs: SECOND_NS });
    quick.appState = 'InGame';
    for (let i = 0; i < 9; i++) runFixedTick(quick);
    expect(quick.advisor.version, 'first tick and first minute').toBe(2);
    runFixedTick(quick);
    expect(quick.city.hour).toBe(1);
    expect(quick.advisor.version, 'on the tick the hour turns').toBe(3);
  });

  it('advisorRanksBySeverityNotByInsertion', () => {
    const inputs = healthy();
    inputs.demandResidential = 0.6; // HousingWanted 0.28, added before crime
    inputs.crimeShare = 0.9; // Crime 0.74
    expect(assess(inputs).map((problem) => problem.kind)).toEqual(['Crime', 'HousingWanted']);
  });

  it('advisorBreaksSeverityTiesByKind', () => {
    const inputs = healthy();
    inputs.money = -1; // EmptyTreasury 1
    inputs.utilities[0] = reading(5000, 2000, 0, 0); // PowerShortage 0.6 + 0.4 × 1
    expect(assess(inputs).map((problem) => problem.kind)).toEqual(['PowerShortage', 'EmptyTreasury']);
  });

  it('advisorThresholdsLetTheBoundaryPass', () => {
    const cases: Array<[string, (inputs: AdvisorInputs, above: boolean) => void]> = [
      ['Unemployment', (i, above) => Object.assign(i, { workers: 100, unemployed: above ? 9 : 8 })],
      ['HousingWanted', (i, above) => Object.assign(i, { demandResidential: above ? 0.51 : 0.5 })],
      ['JobsWanted', (i, above) => Object.assign(i, { demandIndustrial: above ? 0.51 : 0.5 })],
      ['SchoolReach', (i, above) => Object.assign(i, { residentsBeyondSchool: above ? 100 : 99 })],
      ['Crime', (i, above) => Object.assign(i, { crimeShare: above ? 0.11 : 0.1 })],
      ['FireRisk', (i, above) => Object.assign(i, { fireShare: above ? 0.11 : 0.1 })],
      ['PoorHealth', (i, above) => Object.assign(i, { poorHealthShare: above ? 0.21 : 0.2 })],
    ];
    for (const [kind, set] of cases) {
      const at = healthy();
      set(at, false);
      expect(assess(at).map((problem) => problem.kind), `${kind} at its threshold`).toEqual([]);
      const above = healthy();
      set(above, true);
      expect(assess(above).map((problem) => problem.kind), `${kind} just past it`).toEqual([kind]);
    }
  });

  it('advisorWeighsEachProblemByItsOwnMeasure', () => {
    const severityOf = (change: Partial<AdvisorInputs>): number => {
      const problems = assess({ ...healthy(), ...change });
      expect(problems).toHaveLength(1);
      return problems[0]!.severity;
    };
    const power = (supply: number, demand: number, supplied: number, without: number): AdvisorInputs['utilities'] => [
      reading(supply, demand, supplied, without),
      reading(5000, 2000, 2000, 0),
      reading(4000, 2000, 2000, 0),
    ];
    expect(severityOf({ utilities: power(5000, 1000, 750, 0) })).toBeCloseTo(0.6 + 0.4 * 0.25);
    expect(severityOf({ utilities: power(0, 0, 0, 25) })).toBeCloseTo(0.6 + 0.4 * 0.25);
    expect(severityOf({ utilities: power(5000, 1000, 1000, 25) })).toBeCloseTo(0.5 + 0.4 * 0.25);
    expect(severityOf({ monthRunningNet: -5000 })).toBeCloseTo(0.3 + 0.5 * 0.5);
    expect(severityOf({ monthRunningNet: -50_000 })).toBeCloseTo(0.8);
    expect(severityOf({ workers: 1000, unemployed: 180 })).toBeCloseTo(0.3 + 2 * 0.1);
    expect(severityOf({ demandResidential: 0.75 })).toBeCloseTo(0.2 + 0.8 * 0.25);
    expect(severityOf({ demandCommercial: 0.75 })).toBeCloseTo(0.2 + 0.8 * 0.25);
    expect(severityOf({ residentsBeyondSchool: 200 })).toBeCloseTo(0.25 + 0.4 * 0.5);
    expect(severityOf({ crowdedSchool: { residents: 800, places: 200, at: { x: 1, y: 1 } } })).toBeCloseTo(0.25 + 0.4 * 0.75);
    expect(severityOf({ crimeShare: 0.5 })).toBeCloseTo(0.2 + 0.6 * 0.5);
    expect(severityOf({ fireShare: 0.5 })).toBeCloseTo(0.2 + 0.6 * 0.5);
    expect(severityOf({ poorHealthShare: 0.5 })).toBeCloseTo(0.2 + 0.5 * 0.5);
  });

  it('advisorNamesTheLowerClassOnATie', () => {
    const inputs = healthy();
    inputs.workers = 1000;
    inputs.unemployed = 180;
    inputs.unemployedByClass = [10, 80, 80];
    expect(texts(inputs)).toEqual(['Безработица 18 %: 180 жителей без работы, больше всего из среднего класса']);
    inputs.unemployedByClass = [80, 80, 20];
    expect(texts(inputs)).toEqual(['Безработица 18 %: 180 жителей без работы, больше всего бедных']);
  });

  // The rewritten reading of the city: whole footprints, the first building top row first, every cover, health, schools
  // and the month's running net without construction and loans taken.
  it('advisorReadsTheCityOverWholeFootprints', () => {
    const w = createWorld({ mapWidth: 8, mapHeight: 4 });
    const len = w.grid.len();
    const idx = (x: number, y: number): number => y * 8 + x;
    const place = (kind: 'Residential' | 'Commercial', x: number, y: number, residents: number, width = 2, length = 2): void => {
      for (let dy = 0; dy < length; dy++) {
        for (let dx = 0; dx < width; dx++) {
          const pos = { x: x + dx, y: y + dy };
          w.grid.set(pos, { ...w.grid.get(pos)!, zone: kind, building: kind });
        }
      }
      w.buildings.add(newBuilding({ kind, anchor: { x, y }, width, length, level: 1, occupancyResidents: residents }));
    };
    place('Residential', 0, 2, 30); // A, rows 2-3
    place('Residential', 4, 1, 50); // B, rows 1-2
    place('Commercial', 6, 0, 0, 2, 1); // C, row 0
    w.buildings.add(newBuilding({ kind: 'Residential', anchor: { x: 2, y: 0 }, phase: { kind: 'UnderConstruction', hoursRemaining: 3 } }));
    w.buildings.add(newBuilding({ kind: 'Park', anchor: { x: 3, y: 3 } }));

    const served = new Uint8Array(len);
    served[idx(1, 3)] = 0b001; // power on A's second column, second row only
    served[idx(4, 1)] = 0b011; // power and water at B
    w.utilityNetwork.served = served;
    w.serviceCoverage.coverageMap = new Uint8Array(len);
    w.serviceCoverage.coverageMap[idx(1, 3)] = MASK_FIRE;
    w.serviceCoverage.coverageMap[idx(5, 2)] = MASK_POLICE | MASK_MEDICAL;
    const health = new Float32Array(len).fill(0.9);
    for (const [x, y] of [[0, 2], [1, 2], [0, 3], [1, 3], [5, 2]] as const) health[idx(x, y)] = 0.3;
    w.cityFields.setValues('Health', health);
    w.budget.current.add('ResidentialTax', 300);
    w.budget.current.add('Construction', -5000);
    w.budget.current.add('LoanProceeds', 10_000);
    w.budget.daysElapsed = 4;

    let inputs = advisorInputs(w);
    expect(inputs.buildings).toBe(3);
    expect(inputs.utilities.map((r) => [r.buildingsWithout, r.firstWithout])).toEqual([
      [1, { x: 6, y: 0 }],
      [2, { x: 6, y: 0 }],
      [3, { x: 6, y: 0 }],
    ]);
    expect([inputs.fireCover, inputs.policeCover, inputs.medicalCover]).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(inputs.poorHealthShare, 'five of the eight home tiles').toBe(5 / 8);
    expect(inputs.monthRunningNet).toBe(300);
    expect(inputs.monthDays).toBe(4);
    expect(inputs.schoolOpen, 'no school before its milestone').toBe(false);

    w.milestones.reach(1_000_000);
    w.civicCoverage.strength = w.civicCoverage.strength.map(() => new Float32Array(len));
    w.civicCoverage.strength[0]![idx(5, 2)] = 0.5; // B's centre
    w.civicCoverage.sources = [{ kind: 'School', anchor: { x: 3, y: 0 }, capacity: 400, residents: 400, strength: 1 }];
    inputs = advisorInputs(w);
    expect(inputs.schoolOpen).toBe(true);
    expect(inputs.residentsBeyondSchool, 'A alone').toBe(30);
    expect(inputs.crowdedSchool, 'a full school is not crowded').toBeNull();
    w.civicCoverage.sources = [
      { kind: 'School', anchor: { x: 3, y: 0 }, capacity: 400, residents: 400, strength: 1 },
      { kind: 'School', anchor: { x: 7, y: 3 }, capacity: 400, residents: 500, strength: 0.8 },
      { kind: 'School', anchor: { x: 2, y: 1 }, capacity: 200, residents: 400, strength: 0.5 },
    ];
    expect(advisorInputs(w).crowdedSchool).toEqual({ residents: 400, places: 200, at: { x: 2, y: 1 } });
  });
});
