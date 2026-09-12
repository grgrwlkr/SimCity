// Port of crates/simcity_sim/src/game/economy.rs: the budget ledger every dollar moves through, daily taxes by zone
// and wealth class, upkeep of roads, services and utilities, service funding and loans. The config is
// `assets/config/economy.ron` as a constant until the RON loader of stage 6.
import { isOperational } from '../buildings/building';
import type { City } from '../city';
import type { MapGrid } from '../map/grid';
import { serviceStations, type ServiceKind } from '../services/stations';
import type { World } from '../world';
import type { WealthClass } from './wealth';

const f32 = Math.fround;

/** A daily amount per wealth class (`f32`). */
export type ClassIncome = Readonly<Record<WealthClass, number>>;

export interface EconomyConfig {
  readonly happinessTarget: number;
  /** Daily upkeep of a hundred road tiles, dollars: a tile costs a tenth of a dollar a day at the default. */
  readonly roadUpkeepPer100Tiles: number;
  /** Game days in one budget month: the report closes when they have passed. */
  readonly daysPerMonth: number;
  /** Daily taxable income of one resident, commercial job and industrial job of each class. */
  readonly residentIncome: ClassIncome;
  readonly commercialIncome: ClassIncome;
  readonly industrialIncome: ClassIncome;
  /** Daily upkeep of one station of each kind, whatever its footprint, from the day it opens. */
  readonly fireStationUpkeep: number;
  readonly policeStationUpkeep: number;
  readonly hospitalUpkeep: number;
  readonly powerPlantUpkeep: number;
  readonly waterPumpUpkeep: number;
  readonly landfillUpkeep: number;
  readonly schoolUpkeep: number;
  readonly universityUpkeep: number;
  readonly parkUpkeep: number;
}

const classIncome = (low: number, middle: number, high: number): ClassIncome => ({ Low: f32(low), Middle: f32(middle), High: f32(high) });

/** `assets/config/economy.ron`; at the default 9 % rate low earns 0.6 of middle, high 1.6. */
export const ECONOMY_CONFIG: EconomyConfig = {
  happinessTarget: f32(0.7),
  roadUpkeepPer100Tiles: 10,
  daysPerMonth: 10,
  residentIncome: classIncome(13.3, 22.2, 35.5),
  commercialIncome: classIncome(40, 66.7, 106.7),
  industrialIncome: classIncome(53.3, 88.9, 142.2),
  fireStationUpkeep: 20,
  policeStationUpkeep: 15,
  hospitalUpkeep: 30,
  powerPlantUpkeep: 40,
  waterPumpUpkeep: 25,
  landfillUpkeep: 20,
  schoolUpkeep: 25,
  universityUpkeep: 60,
  parkUpkeep: 5,
};

export const TAX_ZONES = ['Residential', 'Commercial', 'Industrial'] as const;
export type TaxZone = (typeof TAX_ZONES)[number];

export const DEFAULT_TAX_PERCENT = 9;
export const MAX_TAX_PERCENT = 20;

const clampPercent = (percent: number, max: number) => Math.min(Math.max(Math.trunc(percent), 0), max);

/** Tax rates in whole percent, one per zone and wealth class. */
export class TaxRates {
  readonly percent: Record<TaxZone, Record<WealthClass, number>> = {
    Residential: { Low: DEFAULT_TAX_PERCENT, Middle: DEFAULT_TAX_PERCENT, High: DEFAULT_TAX_PERCENT },
    Commercial: { Low: DEFAULT_TAX_PERCENT, Middle: DEFAULT_TAX_PERCENT, High: DEFAULT_TAX_PERCENT },
    Industrial: { Low: DEFAULT_TAX_PERCENT, Middle: DEFAULT_TAX_PERCENT, High: DEFAULT_TAX_PERCENT },
  };

  get(zone: TaxZone, wealth: WealthClass): number {
    return this.percent[zone][wealth];
  }

  /** Clamped to `MAX_TAX_PERCENT`. */
  set(zone: TaxZone, wealth: WealthClass, percent: number): void {
    this.percent[zone][wealth] = clampPercent(percent, MAX_TAX_PERCENT);
  }
}

export const DEFAULT_FUNDING_PERCENT = 100;
export const MAX_FUNDING_PERCENT = 150;

/** How much of its full budget each service gets, in whole percent. */
export class ServiceFunding {
  readonly percent: Record<ServiceKind, number> = { Fire: DEFAULT_FUNDING_PERCENT, Police: DEFAULT_FUNDING_PERCENT, Medical: DEFAULT_FUNDING_PERCENT };
  /** Bumps on every change, so coverage recomputes without a map edit (Bevy's change detection in Rust). */
  version = 0;

  get(kind: ServiceKind): number {
    return this.percent[kind];
  }

  /** Clamped to `MAX_FUNDING_PERCENT`. */
  set(kind: ServiceKind, percent: number): void {
    const next = clampPercent(percent, MAX_FUNDING_PERCENT);
    if (next === this.percent[kind]) return;
    this.percent[kind] = next;
    this.version += 1;
  }

  /** The reach of a station at its funding: below full funding it shrinks in proportion, never under half; above, it does not grow. */
  scaledRadius(kind: ServiceKind, radius: number): number {
    const percent = Math.min(Math.max(this.get(kind), 50), DEFAULT_FUNDING_PERCENT);
    return Math.trunc((radius * percent + 50) / 100);
  }

  /** What a station costs a day at its funding, rounded to the dollar. */
  scaledUpkeep(kind: ServiceKind, upkeep: number): number {
    return Math.trunc((upkeep * this.get(kind) + 50) / 100);
  }
}

export const LOAN_SIZES = [10_000, 25_000, 50_000] as const;
export const LOAN_MONTHLY_INTEREST_PERCENT = 1;
export const LOAN_TERM_MONTHS = 12;
export const MAX_ACTIVE_LOANS = 3;

/** Money borrowed from the bank, repaid in equal monthly payments. */
export interface Loan {
  readonly principal: number;
  readonly monthlyPayment: number;
  monthsLeft: number;
}

/** The annuity payment for `principal` over the term, rounded up to the dollar; `(1 + r)^12` by multiplication. */
export function monthlyPayment(principal: number): number {
  const rate = LOAN_MONTHLY_INTEREST_PERCENT / 100;
  let growth = 1;
  for (let month = 0; month < LOAN_TERM_MONTHS; month++) growth *= 1 + rate;
  return Math.ceil((principal * rate) / (1 - 1 / growth));
}

export class Loans {
  active: Loan[] = [];

  /** Borrow one of `LOAN_SIZES`: the money arrives today as a loan line. The refusal, if the bank refuses. */
  take(principal: number, ledger: BudgetLedger, city: City): string | undefined {
    if (!(LOAN_SIZES as readonly number[]).includes(principal)) return 'the bank lends $10 000, $25 000 or $50 000';
    if (this.active.length >= MAX_ACTIVE_LOANS) return 'the bank will not lend to a city with three loans open';
    ledger.post('LoanProceeds', principal, city);
    this.active.push({ principal, monthlyPayment: monthlyPayment(principal), monthsLeft: LOAN_TERM_MONTHS });
    return undefined;
  }

  /** Charge every active loan its payment and drop the ones repaid. */
  chargeMonth(ledger: BudgetLedger, city: City): void {
    for (const loan of this.active) {
      ledger.post('LoanRepayment', -loan.monthlyPayment, city);
      loan.monthsLeft = Math.max(loan.monthsLeft - 1, 0);
    }
    this.active = this.active.filter((loan) => loan.monthsLeft > 0);
  }
}

export const BUDGET_ITEMS = [
  'ResidentialTax',
  'CommercialTax',
  'IndustrialTax',
  'RoadMaintenance',
  'ServiceMaintenance',
  'UtilityMaintenance',
  'Construction',
  'LoanProceeds',
  'LoanRepayment',
] as const;
export type BudgetItem = (typeof BUDGET_ITEMS)[number];

/** Amounts per budget line, whole dollars; income positive, spending negative. */
export class BudgetLines {
  private readonly amounts = new Map<BudgetItem, number>();

  get(item: BudgetItem): number {
    return this.amounts.get(item) ?? 0;
  }

  add(item: BudgetItem, amount: number): void {
    this.amounts.set(item, this.get(item) + amount);
  }

  total(): number {
    let sum = 0;
    for (const amount of this.amounts.values()) sum += amount;
    return sum;
  }

  isEmpty(): boolean {
    return this.amounts.size === 0;
  }

  /** The lines posted, in `BUDGET_ITEMS` order. */
  entries(): Array<readonly [BudgetItem, number]> {
    return BUDGET_ITEMS.filter((item) => this.amounts.has(item)).map((item) => [item, this.get(item)] as const);
  }
}

/** A closed budget month. */
export interface BudgetReport {
  readonly month: number;
  readonly moneyStart: number;
  readonly moneyEnd: number;
  readonly lines: BudgetLines;
}

/** The one way money enters or leaves the treasury, so the monthly report always adds up to the change in money. */
export class BudgetLedger {
  /** The month in progress, from 0 at the start of a game. */
  month = 0;
  /** Days of the current month that have passed. */
  daysElapsed = 0;
  /** The treasury when the current month began. */
  moneyStart = 0;
  current = new BudgetLines();
  last: BudgetReport | null = null;

  /** Count afresh from `money`: a new game, a scenario's starting funds, a load. */
  restart(money: number): void {
    this.month = 0;
    this.daysElapsed = 0;
    this.moneyStart = money;
    this.current = new BudgetLines();
    this.last = null;
  }

  /** Move `amount` into (positive) or out of (negative) the treasury under `item`. */
  post(item: BudgetItem, amount: number, city: City): void {
    if (amount === 0) return;
    city.money += amount;
    this.current.add(item, amount);
  }

  /** Whether the day being counted next is the last of the month. */
  closesMonthToday(daysPerMonth: number): boolean {
    return this.daysElapsed + 1 >= Math.max(daysPerMonth, 1);
  }

  /** Count a day; after `daysPerMonth` of them, close the month into `last`. */
  endOfDay(daysPerMonth: number, city: City): void {
    this.daysElapsed += 1;
    if (this.daysElapsed < Math.max(daysPerMonth, 1)) return;
    this.last = { month: this.month, moneyStart: this.moneyStart, moneyEnd: city.money, lines: this.current };
    this.current = new BudgetLines();
    this.month += 1;
    this.daysElapsed = 0;
    this.moneyStart = city.money;
  }
}

function stationUpkeep(cfg: EconomyConfig, kind: ServiceKind): number {
  return kind === 'Fire' ? cfg.fireStationUpkeep : kind === 'Police' ? cfg.policeStationUpkeep : cfg.hospitalUpkeep;
}

/** Road tiles on dry land; roads are kept up per tile. */
function countRoadTiles(grid: MapGrid): number {
  let roads = 0;
  for (let idx = 0; idx < grid.len(); idx++) if (grid.water[idx] === 0 && grid.roadKind[idx] !== 0) roads += 1;
  return roads;
}

/**
 * `apply_daily_economy` (PostSimStep::Economy), once per advanced day. Tax is owed per open building: its people,
 * their class's taxable income and that zone's rate for the class, rounded once per zone, so the posted line is
 * exactly what moves money. Loan payments fall on the last day of the month, inside the report they belong to.
 */
export function applyDailyEconomy(w: World): void {
  const cfg = w.economyConfig;
  const city = w.city;
  const ledger = w.budget;
  const rates = w.taxRates;
  for (let day = 0; day < w.events.dayAdvanced.length; day++) {
    const owed: Record<(typeof TAX_ZONES)[number], number> = { Residential: 0, Commercial: 0, Industrial: 0 };
    let civicUpkeep = 0;
    let utilityUpkeep = 0;
    for (const b of w.buildings.all()) {
      if (!isOperational(b)) continue;
      const wealth = b.profile.class;
      switch (b.kind) {
        case 'Residential':
          owed.Residential += (b.occupancyResidents * cfg.residentIncome[wealth] * rates.get('Residential', wealth)) / 100;
          break;
        case 'Commercial':
          owed.Commercial += (b.occupancyJobs * cfg.commercialIncome[wealth] * rates.get('Commercial', wealth)) / 100;
          break;
        case 'Industrial':
          owed.Industrial += (b.occupancyJobs * cfg.industrialIncome[wealth] * rates.get('Industrial', wealth)) / 100;
          break;
        case 'School':
          civicUpkeep += cfg.schoolUpkeep;
          break;
        case 'University':
          civicUpkeep += cfg.universityUpkeep;
          break;
        case 'Park':
          civicUpkeep += cfg.parkUpkeep;
          break;
        case 'PowerPlant':
          utilityUpkeep += cfg.powerPlantUpkeep;
          break;
        case 'WaterPump':
          utilityUpkeep += cfg.waterPumpUpkeep;
          break;
        case 'Landfill':
          utilityUpkeep += cfg.landfillUpkeep;
          break;
        default:
          break;
      }
    }
    const residentialTax = Math.round(owed.Residential);
    const commercialTax = Math.round(owed.Commercial);
    const industrialTax = Math.round(owed.Industrial);
    const roadUpkeep = Math.trunc((countRoadTiles(w.grid) * cfg.roadUpkeepPer100Tiles + 50) / 100);
    let serviceUpkeep = civicUpkeep;
    for (const station of serviceStations(w)) serviceUpkeep += w.serviceFunding.scaledUpkeep(station.kind, stationUpkeep(cfg, station.kind));

    const income = residentialTax + commercialTax + industrialTax;
    const expense = roadUpkeep + serviceUpkeep + utilityUpkeep;
    city.lastIncome = income;
    city.lastExpense = expense;
    ledger.post('ResidentialTax', residentialTax, city);
    ledger.post('CommercialTax', commercialTax, city);
    ledger.post('IndustrialTax', industrialTax, city);
    ledger.post('RoadMaintenance', -roadUpkeep, city);
    ledger.post('ServiceMaintenance', -serviceUpkeep, city);
    ledger.post('UtilityMaintenance', -utilityUpkeep, city);

    // Happiness drifts toward a target, lower while the city loses money, up to 0.06 higher at full service coverage.
    const base = income - expense < 0 ? f32(cfg.happinessTarget - f32(0.05)) : cfg.happinessTarget;
    const target = Math.min(Math.max(f32(base + f32(f32(0.06) * w.serviceCoverage.overall())), 0), 1);
    city.happiness = Math.min(Math.max(f32(city.happiness + f32(f32(target - city.happiness) * f32(0.02))), 0), 1);

    if (ledger.closesMonthToday(cfg.daysPerMonth)) w.loans.chargeMonth(ledger, city);
    ledger.endOfDay(cfg.daysPerMonth, city);
  }
}

/** Every service at full funding and no rate moved: what a new game starts with. */
export function resetEconomyPolicy(w: World): void {
  w.taxRates = new TaxRates();
  w.serviceFunding = new ServiceFunding();
  w.loans = new Loans();
  w.budget.restart(w.city.money);
}
