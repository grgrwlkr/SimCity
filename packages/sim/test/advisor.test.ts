// Ported from crates/simcity_sim/src/game/advisor.rs (mod tests) at tag rust-final: the city's problems ranked by how
// badly they hurt, each named with the thing that is missing and its numbers, reassessed once a game hour.
import { describe, expect, it } from 'vitest';
import { advisorInputs, assess, thousands, updateAdvisor, type AdvisorInputs, type UtilityReading } from '../src/advisor';
import { runFixedTick } from '../src/app';
import { newBuilding } from '../src/buildings/building';
import { FIXED_UPDATE } from '../src/schedule';
import { MASK_POLICE } from '../src/services/coverage';
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
    expect(thousands(6200)).toBe('6 200');
    expect(thousands(-1_234_567)).toBe('-1 234 567');
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
    expect(worst?.text).toBe('Water shortage: pumps supply 5 000, the city needs 6 200');
    expect(worst?.at).toEqual({ x: 9, y: 4 });
    expect(problems).toHaveLength(1);
  });

  // advisor.rs `advisor_without_a_station_says_which_and_counts_the_buildings`
  it('advisorWithoutAStationSaysWhichAndCountsTheBuildings', () => {
    let inputs = healthy();
    inputs.utilities[1] = reading(0, 0, 0, 245);
    expect(texts(inputs)).toEqual(['No water: the city has no water pump, 245 buildings go without']);
    inputs = healthy();
    inputs.utilities[0] = reading(5000, 1000, 1000, 12);
    expect(texts(inputs)).toEqual(['12 buildings have no power: no road links them to a power plant']);
    inputs = healthy();
    inputs.utilities[2] = reading(4000, 4900, 3900, 30);
    expect(texts(inputs)).toEqual(['Garbage collection shortage: landfills take 4 000, the city needs 4 900']);
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
    expect(texts(inputs)).toEqual(['Unemployment 18%: 180 residents have no job, most of them low-income']);
  });

  // advisor.rs `advisor_names_housing_and_jobs_demand`
  it('advisorNamesHousingAndJobsDemand', () => {
    const inputs = healthy();
    inputs.demandResidential = 0.72;
    inputs.demandCommercial = 0.64;
    inputs.demandIndustrial = 0.58;
    const shown = texts(inputs);
    expect(shown).toContain('Homes wanted: residential demand is 72%');
    expect(shown).toContain('Jobs wanted: commercial demand is 64%, industrial 58%');
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
    expect(shown).toContain("No school nearby: 450 residents live beyond a school's reach");
    expect(shown).toContain('School overcrowded: 800 residents for 400 places');
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
      'High crime in 23% of the city: police cover 40% of buildings',
      'Fire risk in 15% of the city: fire stations cover 30% of buildings',
      'Poor health in 35% of homes: hospitals cover 20% of buildings',
    ]) {
      expect(shown).toContain(expected);
    }
  });

  // advisor.rs `advisor_names_the_budget_deficit_and_an_empty_treasury`
  it('advisorNamesTheBudgetDeficitAndAnEmptyTreasury', () => {
    const inputs = healthy();
    inputs.monthRunningNet = -1200;
    expect(texts(inputs)).toEqual(['Budget deficit: upkeep and loan payments exceed taxes by $1 200 this month']);
    inputs.money = -3000;
    const problems = assess(inputs);
    expect(problems[0]?.kind).toBe('EmptyTreasury');
    expect(problems[0]?.text).toBe('The treasury is empty: $3 000 in debt');
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
    expect(crime?.text, 'crime everywhere is a problem').toBe('High crime in 100% of the city: police cover 50% of buildings');
    expect(advisorInputs(w).buildings).toBe(2);
  });

  // advisor.rs `advisor_reassesses_the_city_each_game_hour`: the advice follows the city hour by hour and stands in
  // between. As in Rust, the first update of a new world assesses it too.
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

    run(1);
    expect(worst()).toBe('EmptyTreasury');

    w.city.money = 9000;
    run(ticksAnHour - 2);
    expect(w.city.hour).toBe(0);
    expect(worst(), 'between hours the advice stands').toBe('EmptyTreasury');

    run(1);
    expect(w.city.hour).toBe(1);
    expect(worst()).toBeUndefined();
    expect(w.advisor.version).toBe(2);
  });

  // Not in Rust: the TS schedule gates the system itself. A new world is assessed on its first fixed tick, not an hour
  // later, and after that only on the tick the hour turns.
  it('advisorAssessesANewWorldOnItsFirstTickAndThenOnTheHour', () => {
    const w = createWorld({ mapWidth: 8, mapHeight: 8, gameHourNs: SECOND_NS });
    w.appState = 'InGame';
    w.city.money = -500;
    expect(w.advisor.version).toBe(0);
    runFixedTick(w);
    expect(w.advisor.version, 'assessed on the first tick').toBe(1);
    expect(w.advisor.worst()?.kind).toBe('EmptyTreasury');
    for (let i = 0; i < 8; i++) runFixedTick(w);
    expect(w.advisor.version, 'not within the hour').toBe(1);
    runFixedTick(w);
    expect(w.city.hour).toBe(1);
    expect(w.advisor.version, 'on the tick the hour turns').toBe(2);
  });
});
