// Port of the tests in crates/simcity_sim/src/game/economy.rs: the budget ledger, upkeep per building,
// taxes by zone and class, service funding and loans.
import { describe, expect, it } from 'vitest';
import { newBuilding, type Building } from '../../src/buildings/building';
import { defaultCity, type City } from '../../src/city';
import type { BuildingKind, TilePos } from '../../src/commands';
import {
  BudgetLedger,
  DEFAULT_FUNDING_PERCENT,
  DEFAULT_TAX_PERCENT,
  ECONOMY_CONFIG,
  LOAN_SIZES,
  LOAN_TERM_MONTHS,
  Loans,
  MAX_FUNDING_PERCENT,
  MAX_TAX_PERCENT,
  ServiceFunding,
  TAX_ZONES,
  TaxRates,
  applyDailyEconomy,
  monthlyPayment,
  type BudgetLines,
} from '../../src/economy/economy';
import { WEALTH_CLASSES, wealthFromLandValue, type WealthClass } from '../../src/economy/wealth';
import { MapGrid } from '../../src/map/grid';
import type { World } from '../../src/world';
import { roadRow, t, worldOn } from '../buildings/helpers';
import { setRoad } from '../transport/helpers';

function ledgerAt(money: number): [BudgetLedger, City] {
  const ledger = new BudgetLedger();
  ledger.restart(money);
  return [ledger, { ...defaultCity(), money }];
}

/** A world over `grid` with `money` in the treasury and a ledger counting from it. */
function economyWorld(grid: MapGrid, money = 10_000): World {
  const w = worldOn(grid);
  w.city.money = money;
  w.budget.restart(money);
  return w;
}

/** The daily economy over the given advanced days; the lines of the month in progress. */
function days(w: World, ...advanced: number[]): BudgetLines {
  w.events.dayAdvanced.push(...advanced);
  applyDailyEconomy(w);
  w.events.dayAdvanced.length = 0;
  return w.budget.current;
}

/** `zoned_building`: an operational 3×3 building full to its capacity. */
function zonedBuilding(kind: BuildingKind, anchor: TilePos, residents: number, jobs: number, wealth: WealthClass = 'Middle'): Building {
  return newBuilding({
    kind,
    anchor,
    constructionStartDay: 1,
    capacityResidents: residents,
    capacityJobs: jobs,
    occupancyResidents: residents,
    occupancyJobs: jobs,
    targetOccupancyResidents: residents,
    targetOccupancyJobs: jobs,
    profile: { density: 'Medium', class: wealth },
  });
}

const UNDER_CONSTRUCTION = { kind: 'UnderConstruction', daysRemaining: 2 } as const;

/** Service stations along a road on row 0, one every four tiles from x = 0. */
function stationWorld(kinds: readonly BuildingKind[]): World {
  const grid = new MapGrid(16, 16);
  roadRow(grid, 0, 0, 15);
  const w = economyWorld(grid);
  kinds.forEach((kind, i) => w.buildings.add(newBuilding({ kind, anchor: t(i * 4, 1) })));
  return w;
}

/** One day of taxes over `buildings`, grown on land of value `land` everywhere, at `rates`. */
function taxesFor(buildings: readonly Building[], land: number, rates: TaxRates): BudgetLines {
  const w = economyWorld(new MapGrid(16, 16));
  w.landValue.values = new Float32Array(256).fill(land);
  w.taxRates = rates;
  // A grown building keeps the class of the land it grew on.
  const wealth = wealthFromLandValue(Math.fround(land));
  for (const b of buildings) w.buildings.add({ ...b, profile: { ...b.profile, class: wealth } });
  return days(w, 2);
}

const expectedTax = (people: number, income: number, percent: number) => Math.round((people * income * percent) / 100);

describe('budget ledger', () => {
  it('budgetReportLinesSumToTheTreasuryChange', () => {
    const [ledger, city] = ledgerAt(1_000);
    ledger.post('ResidentialTax', 240, city);
    ledger.post('RoadMaintenance', -35, city);
    ledger.post('Construction', -120, city);
    ledger.post('ResidentialTax', 60, city);

    expect(city.money).toBe(1_000 + 240 - 35 - 120 + 60);
    expect(ledger.current.get('ResidentialTax')).toBe(300);
    expect(ledger.current.total()).toBe(city.money - 1_000);
  });

  it('budgetReportAMonthClosesAfterItsDaysAndTheNextBegins', () => {
    const [ledger, city] = ledgerAt(5_000);
    ledger.post('CommercialTax', 400, city);
    ledger.endOfDay(3, city);
    ledger.endOfDay(3, city);
    expect(ledger.last, 'two days of a three-day month').toBeNull();

    ledger.post('RoadMaintenance', -100, city);
    ledger.endOfDay(3, city);
    const report = ledger.last!;
    expect(report, 'the third day closes the month').not.toBeNull();
    expect(report.month).toBe(0);
    expect(report.moneyStart).toBe(5_000);
    expect(report.moneyEnd).toBe(5_300);
    expect(report.lines.total()).toBe(report.moneyEnd - report.moneyStart);
    expect(ledger.current.isEmpty(), 'the next month starts empty').toBe(true);
    expect(ledger.month).toBe(1);
    expect(ledger.moneyStart).toBe(5_300);
  });

  it('budgetReportDailyEconomyGoesThroughTheLedger', () => {
    // A hundred road tiles: enough to cost whole dollars a day at the calibrated upkeep.
    const grid = new MapGrid(16, 16);
    for (let i = 0; i < 100; i++) setRoad(grid, { x: i % 16, y: 8 + Math.trunc(i / 16) }, { dir: 'East' });
    const w = economyWorld(grid, 2_000);
    // Residents pay tax where they live: the base is the building, not a city-wide count.
    w.buildings.add(zonedBuilding('Residential', t(4, 4), 50, 0));

    const lines = days(w, 2, 3);

    expect(w.city.money, 'two days of a city with people and roads move money').not.toBe(2_000);
    expect(lines.total(), 'every dollar the day moved is on a line').toBe(w.city.money - 2_000);
    expect(lines.get('ResidentialTax')).toBeGreaterThan(0);
    expect(lines.get('RoadMaintenance')).toBeLessThan(0);
  });
});

describe('maintenance per building', () => {
  it('maintenancePerBuildingAServiceStationCostsItsUpkeepOnceWhateverItsFootprint', () => {
    expect(days(stationWorld(['FireStation']), 2).get('ServiceMaintenance'), 'nine footprint tiles are one fire station, paid for once').toBe(
      -ECONOMY_CONFIG.fireStationUpkeep,
    );
    expect(days(stationWorld(['FireStation', 'PoliceStation', 'Hospital']), 2).get('ServiceMaintenance')).toBe(
      -(ECONOMY_CONFIG.fireStationUpkeep + ECONOMY_CONFIG.policeStationUpkeep + ECONOMY_CONFIG.hospitalUpkeep),
    );
  });

  // TS: a service station is an open service building beside a road; Rust attached the station once and kept it.
  it('aServiceStationCostsNothingUntilItIsOpenOnARoad', () => {
    const w = stationWorld([]);
    w.buildings.add(newBuilding({ kind: 'FireStation', anchor: t(0, 1), phase: UNDER_CONSTRUCTION }));
    w.buildings.add(newBuilding({ kind: 'PoliceStation', anchor: t(6, 10) }));
    expect(days(w, 2).get('ServiceMaintenance'), 'one still being built, one far from any road').toBe(0);
  });

  it('maintenancePerBuildingZonedBuildingsCostTheCityNothing', () => {
    const w = economyWorld(new MapGrid(16, 16));
    w.buildings.add(zonedBuilding('Residential', t(0, 0), 0, 0));
    w.buildings.add(zonedBuilding('Industrial', t(6, 6), 0, 0));
    const lines = days(w, 2);
    expect(lines.get('ServiceMaintenance'), 'residents and firms pay taxes; the city does not keep their buildings up').toBe(0);
    expect(lines.total(), 'no people, no roads, no stations: nothing moves').toBe(0);
  });

  it('maintenancePerBuildingRoadsCostPerTile', () => {
    // 250 tiles at ten dollars per hundred tiles a day: twenty-five dollars, rounded once.
    const grid = new MapGrid(64, 64);
    for (let i = 0; i < 250; i++) setRoad(grid, { x: i % 50, y: 3 + Math.trunc(i / 50) }, { dir: 'East' });
    const perHundred = ECONOMY_CONFIG.roadUpkeepPer100Tiles;
    expect(perHundred, 'a road tile costs a tenth of a dollar a day by default').toBe(10);
    expect(days(economyWorld(grid), 2).get('RoadMaintenance')).toBe(-Math.trunc((250 * perHundred + 50) / 100));
  });

  it('maintenancePerBuildingUtilityStationsCostTheirUpkeepOnceOpen', () => {
    const w = economyWorld(new MapGrid(16, 16));
    (['PowerPlant', 'WaterPump', 'Landfill'] as const).forEach((kind, i) => w.buildings.add(zonedBuilding(kind, t(i * 4, 0), 0, 0)));
    w.buildings.add({ ...zonedBuilding('PowerPlant', t(0, 8), 0, 0), phase: UNDER_CONSTRUCTION });

    const lines = days(w, 2);
    const cfg = ECONOMY_CONFIG;
    expect(lines.get('UtilityMaintenance'), 'three open stations pay; the one still being built does not').toBe(
      -(cfg.powerPlantUpkeep + cfg.waterPumpUpkeep + cfg.landfillUpkeep),
    );
    expect(lines.get('ServiceMaintenance')).toBe(0);
    expect(w.city.money, 'the utility line is money that actually moved').toBe(10_000 + lines.total());
  });

  it('serviceBuildingSchoolUniversityAndParkChargeTheirUpkeepOnceOpen', () => {
    const w = economyWorld(new MapGrid(16, 16));
    (['School', 'University', 'Park'] as const).forEach((kind, i) => w.buildings.add(zonedBuilding(kind, t(i * 4, 0), 0, 0)));
    w.buildings.add({ ...zonedBuilding('School', t(0, 8), 0, 0), phase: UNDER_CONSTRUCTION });

    const cfg = ECONOMY_CONFIG;
    expect([cfg.schoolUpkeep, cfg.universityUpkeep, cfg.parkUpkeep]).toEqual([25, 60, 5]);
    const lines = days(w, 2);
    expect(lines.get('ServiceMaintenance'), 'three open civic buildings pay; the school still being built does not').toBe(
      -(cfg.schoolUpkeep + cfg.universityUpkeep + cfg.parkUpkeep),
    );
    expect(lines.get('UtilityMaintenance')).toBe(0);
    expect(w.city.money).toBe(10_000 + lines.total());
  });

  it('maintenancePerBuildingServiceUpkeepFollowsItsFunding', () => {
    const w = stationWorld(['FireStation', 'Hospital']);
    w.serviceFunding.set('Fire', 50);
    w.serviceFunding.set('Medical', 150);
    expect(days(w, 2).get('ServiceMaintenance'), 'half-funded fire and one-and-a-half-funded medical').toBe(
      -(ECONOMY_CONFIG.fireStationUpkeep / 2 + (ECONOMY_CONFIG.hospitalUpkeep * 3) / 2),
    );
  });
});

describe('tax rates', () => {
  it('zoneDensityTaxComesFromTheClassABuildingWasBuiltWith', () => {
    const w = economyWorld(new MapGrid(16, 16));
    // Land that reads as the low class today.
    w.landValue.values = new Float32Array(256).fill(0.1);
    w.buildings.add(zonedBuilding('Residential', t(0, 0), 30, 0, 'High'));

    const expected = expectedTax(30, ECONOMY_CONFIG.residentIncome.High, new TaxRates().get('Residential', 'High'));
    expect(days(w, 2).get('ResidentialTax'), 'the class is the one the building was built with, not the land under it today').toBe(expected);
  });

  it('taxRateDefaultsToNinePercentEverywhereAndIsCappedAtTwenty', () => {
    const rates = new TaxRates();
    for (const zone of TAX_ZONES) {
      for (const wealth of WEALTH_CLASSES) expect(rates.get(zone, wealth), `${zone} ${wealth}`).toBe(DEFAULT_TAX_PERCENT);
    }
    rates.set('Commercial', 'High', 35);
    expect(rates.get('Commercial', 'High')).toBe(MAX_TAX_PERCENT);
    rates.set('Commercial', 'Low', 4);
    expect(rates.get('Commercial', 'Low')).toBe(4);
    expect(rates.get('Residential', 'Low'), 'one rate moves alone').toBe(DEFAULT_TAX_PERCENT);
  });

  it('taxRateClassComesFromTheLandValueUnderTheBuilding', () => {
    const f32 = Math.fround;
    expect(wealthFromLandValue(0)).toBe('Low');
    expect(wealthFromLandValue(f32(0.33))).toBe('Low');
    expect(wealthFromLandValue(f32(0.34))).toBe('Middle');
    expect(wealthFromLandValue(f32(0.66))).toBe('Middle');
    expect(wealthFromLandValue(f32(0.67))).toBe('High');
    expect(wealthFromLandValue(1)).toBe('High');
  });

  it('taxRateResidentialTaxFollowsResidentsClassAndRate', () => {
    const income = ECONOMY_CONFIG.residentIncome;
    const home = () => [zonedBuilding('Residential', t(2, 2), 100, 0)];

    expect(taxesFor(home(), 0.8, new TaxRates()).get('ResidentialTax'), 'a hundred high-class residents at nine percent').toBe(
      expectedTax(100, income.High, 9),
    );

    let rates = new TaxRates();
    rates.set('Residential', 'High', 18);
    expect(taxesFor(home(), 0.8, rates).get('ResidentialTax')).toBe(expectedTax(100, income.High, 18));

    rates = new TaxRates();
    rates.set('Residential', 'Low', 20);
    expect(taxesFor(home(), 0.8, rates).get('ResidentialTax'), 'the low-class rate does not touch a high-class building').toBe(
      expectedTax(100, income.High, 9),
    );

    expect(taxesFor(home(), 0.2, new TaxRates()).get('ResidentialTax'), 'the same building on cheap land is low class').toBe(
      expectedTax(100, income.Low, 9),
    );
  });

  it('taxRateCommercialAndIndustrialTaxFollowJobs', () => {
    const firms = [zonedBuilding('Commercial', t(1, 1), 0, 40), zonedBuilding('Industrial', t(8, 8), 0, 30)];
    const rates = new TaxRates();
    rates.set('Industrial', 'Middle', 12);
    const lines = taxesFor(firms, 0.5, rates);
    expect(lines.get('CommercialTax')).toBe(expectedTax(40, ECONOMY_CONFIG.commercialIncome.Middle, 9));
    expect(lines.get('IndustrialTax')).toBe(expectedTax(30, ECONOMY_CONFIG.industrialIncome.Middle, 12));
    expect(lines.get('ResidentialTax')).toBe(0);
  });
});

describe('service funding', () => {
  it('budgetReportFundingDefaultsToFullAndIsCapped', () => {
    const funding = new ServiceFunding();
    for (const kind of ['Fire', 'Police', 'Medical'] as const) expect(funding.get(kind)).toBe(DEFAULT_FUNDING_PERCENT);
    funding.set('Police', 220);
    expect(funding.get('Police')).toBe(MAX_FUNDING_PERCENT);
    funding.set('Fire', 40);
    expect(funding.get('Fire')).toBe(40);
    expect(funding.get('Medical')).toBe(DEFAULT_FUNDING_PERCENT);

    expect(funding.scaledRadius('Medical', 30)).toBe(30);
    funding.set('Medical', 150);
    expect(funding.scaledRadius('Medical', 30), 'overfunding does not reach further').toBe(30);
    funding.set('Medical', 60);
    expect(funding.scaledRadius('Medical', 30)).toBe(18);
    funding.set('Medical', 10);
    expect(funding.scaledRadius('Medical', 30), 'never under half').toBe(15);
  });
});

describe('loans', () => {
  it('budgetReportMonthlyPaymentIsTheAnnuity', () => {
    // principal × r / (1 − (1 + r)^−12) at one percent a month, rounded up to the dollar.
    expect(LOAN_SIZES.map(monthlyPayment)).toEqual([889, 2222, 4443]);
    expect(monthlyPayment(10_000) * LOAN_TERM_MONTHS, 'a loan costs more than it lends').toBeGreaterThan(10_000);
  });

  it('budgetReportALoanIsIncomeTheDayItIsTaken', () => {
    const [ledger, city] = ledgerAt(1_000);
    const loans = new Loans();

    expect(loans.take(10_000, ledger, city)).toBeUndefined();
    expect(city.money).toBe(11_000);
    expect(ledger.current.get('LoanProceeds')).toBe(10_000);
    expect(loans.active).toEqual([{ principal: 10_000, monthlyPayment: 889, monthsLeft: LOAN_TERM_MONTHS }]);

    expect(loans.take(12_345, ledger, city), 'only the bank sizes are lent').toBeTypeOf('string');
    expect(city.money, 'a refused loan moves nothing').toBe(11_000);

    expect(loans.take(25_000, ledger, city)).toBeUndefined();
    expect(loans.take(50_000, ledger, city)).toBeUndefined();
    expect(loans.take(10_000, ledger, city), 'no more than three loans at once').toBeTypeOf('string');
    expect(ledger.current.total()).toBe(city.money - 1_000);
  });

  it('budgetReportLoanPaymentsCloseEveryMonthUntilRepaid', () => {
    const w = economyWorld(new MapGrid(8, 8), 20_000);
    w.economyConfig = { ...ECONOMY_CONFIG, daysPerMonth: 2 };
    w.loans.active = [
      { principal: 10_000, monthlyPayment: 889, monthsLeft: 12 },
      { principal: 25_000, monthlyPayment: monthlyPayment(25_000), monthsLeft: 1 },
    ];

    days(w, 2);
    expect(w.budget.last, 'no payment in the middle of a month').toBeNull();

    days(w, 3);
    const report = w.budget.last!;
    expect(report, 'the second day closes a two-day month').not.toBeNull();
    expect(report.lines.get('LoanRepayment'), 'both loans pay on the last day of the month').toBe(-(889 + monthlyPayment(25_000)));
    expect(report.lines.total()).toBe(report.moneyEnd - report.moneyStart);
    expect(w.loans.active, 'the repaid loan is gone, the other has a month less').toEqual([{ principal: 10_000, monthlyPayment: 889, monthsLeft: 11 }]);
  });
});
