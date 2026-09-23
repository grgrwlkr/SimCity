// The advisor (B8), ported from crates/simcity_sim/src/game/advisor.rs at tag rust-final: the city's problems ranked by
// how badly they hurt, each named with the thing that is missing and its numbers, never a general phrase. Reassessed
// once a game hour, and once when the game starts.
import { isOperational, isZonedKind, type Building } from './buildings/building';
import { CRIME_EMPTIES_HOMES_FROM, FIRE_HAZARD_LIMIT, HEALTH_FOR_LEVEL_THREE } from './cityFields';
import { BUILDING_KINDS, type TilePos } from './commands';
import { WEALTH_CLASSES } from './economy/wealth';
import { MASK_FIRE, MASK_MEDICAL, MASK_POLICE } from './services/coverage';
import { UTILITY_KINDS, utilityMask, type UtilityKind } from './utilities';
import type { MapGrid } from './map/grid';
import { periodTicks } from './rates';
import { SECOND_NS } from './timer';
import type { World } from './world';

/** Unemployment the advisor lets pass. */
const UNEMPLOYMENT_TOLERATED = 0.08;
/** Zone demand above which the player is told the city wants more of it. */
const DEMAND_UNMET = 0.5;
/** Residents beyond a school's reach worth a word. */
const SCHOOL_REACH_WORTH = 100;
/** Shares of the city above which crime and fire risk are worth a word. */
const CRIME_SHARE_WORTH = 0.1;
const FIRE_SHARE_WORTH = 0.1;
/** Share of homes in poor health worth a word. */
const POOR_HEALTH_SHARE_WORTH = 0.2;
/** A monthly deficit this large is as bad as a deficit gets. */
const DEFICIT_AT_WORST = 10_000;

/** What a problem is about; on equal severity the earlier kind comes first. */
export const PROBLEM_KINDS = [
  'PowerShortage',
  'WaterShortage',
  'GarbageShortage',
  'NoPower',
  'NoWater',
  'NoGarbage',
  'EmptyTreasury',
  'BudgetDeficit',
  'Unemployment',
  'HousingWanted',
  'JobsWanted',
  'SchoolReach',
  'SchoolOvercrowded',
  'Crime',
  'FireRisk',
  'PoorHealth',
] as const;
export type ProblemKind = (typeof PROBLEM_KINDS)[number];

/** One problem as the player reads it. */
export interface Problem {
  readonly kind: ProblemKind;
  /** How badly it hurts, 0..1; the list is ordered by it. */
  readonly severity: number;
  readonly text: string;
  /** Where to look, when the problem has a place. */
  readonly at: TilePos | null;
}

/** The city's problems, worst first. */
export class Advisor {
  /** Bumps on every assessment; 0 until the first. */
  version = 0;
  problems: Problem[] = [];

  worst(): Problem | undefined {
    return this.problems[0];
  }

  /** Nothing assessed: a new city is read afresh on its next tick. */
  reset(): void {
    this.version = 0;
    this.problems = [];
  }
}

/** One utility as the advisor reads it, in units. */
export interface UtilityReading {
  supply: number;
  demand: number;
  supplied: number;
  /** Open zoned buildings the utility does not reach. */
  buildingsWithout: number;
  /** The first of them, top row first. */
  firstWithout: TilePos | null;
}

/** Everything the advisor weighs, read from the city. */
export interface AdvisorInputs {
  /** Open zoned buildings. */
  buildings: number;
  /** Power, water and garbage collection, in `UTILITY_KINDS` order. */
  utilities: [UtilityReading, UtilityReading, UtilityReading];
  workers: number;
  unemployed: number;
  /** Residents without a job by the class of their home: low, middle, high. */
  unemployedByClass: [number, number, number];
  demandResidential: number;
  demandCommercial: number;
  demandIndustrial: number;
  population: number;
  /** Whether the city may build a school yet. */
  schoolOpen: boolean;
  /** Residents of homes no school reaches. */
  residentsBeyondSchool: number;
  /** The most crowded school: residents within its reach, its places, where it stands. */
  crowdedSchool: { readonly residents: number; readonly places: number; readonly at: TilePos } | null;
  /** Shares of built tiles with high crime and high fire hazard, and of homes in poor health. */
  crimeShare: number;
  fireShare: number;
  poorHealthShare: number;
  /** Shares of buildings police, fire stations and hospitals cover. */
  policeCover: number;
  fireCover: number;
  medicalCover: number;
  money: number;
  /** Taxes less upkeep and loan payments so far this month; construction and loans taken are left out. */
  monthRunningNet: number;
  monthDays: number;
}

/** `of` is the utility in the genitive («нет воды»), `station` the station in the genitive («нет водокачки»). */
const UTILITY_WORDS: Readonly<
  Record<UtilityKind, { shortage: ProblemKind; missing: ProblemKind; of: string; stations: string; verb: string; station: string }>
> = {
  Power: { shortage: 'PowerShortage', missing: 'NoPower', of: 'электричества', stations: 'электростанции', verb: 'дают', station: 'электростанции' },
  Water: { shortage: 'WaterShortage', missing: 'NoWater', of: 'воды', stations: 'водокачки', verb: 'дают', station: 'водокачки' },
  Garbage: { shortage: 'GarbageShortage', missing: 'NoGarbage', of: 'вывоза мусора', stations: 'свалки', verb: 'принимают', station: 'свалки' },
};

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
/** A share as the interface prints it: «18 %», the sign held to its number by a no-break space. */
const percent = (share: number): string => `${Math.round(clamp01(share) * 100)}\u00a0%`;

/** The Russian noun form a count takes: 1 здание, 3 здания, 5 зданий, 11 зданий, 21 здание. */
function plural(count: number, one: string, few: string, many: string): string {
  const tens = Math.abs(count) % 100;
  const units = tens % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  return units >= 2 && units <= 4 ? few : many;
}
const buildingsWord = (count: number): string => `${thousands(count)} ${plural(count, 'здание', 'здания', 'зданий')}`;
const residentsWord = (count: number): string => `${thousands(count)} ${plural(count, 'житель', 'жителя', 'жителей')}`;

/** The city's problems, worst first. */
export function assess(inputs: AdvisorInputs): Problem[] {
  const problems: Problem[] = [];
  const add = (kind: ProblemKind, severity: number, text: string, at: TilePos | null): void => {
    problems.push({ kind, severity: clamp01(severity), text, at });
  };

  UTILITY_KINDS.forEach((kind, index) => {
    const reading = inputs.utilities[index]!;
    const words = UTILITY_WORDS[kind];
    if (reading.supply > 0 && reading.supplied < reading.demand) {
      const short = (reading.demand - reading.supplied) / reading.demand;
      add(
        words.shortage,
        0.6 + 0.4 * short,
        `Не хватает ${words.of}: ${words.stations} ${words.verb} ${thousands(reading.supply)}, городу нужно ${thousands(reading.demand)}`,
        reading.firstWithout,
      );
    } else if (reading.buildingsWithout > 0) {
      const share = reading.buildingsWithout / Math.max(inputs.buildings, 1);
      const count = buildingsWord(reading.buildingsWithout);
      if (reading.supply === 0) {
        add(words.missing, 0.6 + 0.4 * share, `В городе нет ${words.station}: ${count} без ${words.of}`, reading.firstWithout);
      } else {
        add(words.missing, 0.5 + 0.4 * share, `${count} без ${words.of}: нет дороги до ${words.station}`, reading.firstWithout);
      }
    }
  });

  if (inputs.money < 0) {
    add('EmptyTreasury', 1, `Казна пуста: долг $${thousands(-inputs.money)}`, null);
  } else if (inputs.monthDays > 0 && inputs.monthRunningNet < 0) {
    const deficit = -inputs.monthRunningNet;
    add(
      'BudgetDeficit',
      0.3 + 0.5 * Math.min(deficit / DEFICIT_AT_WORST, 1),
      `Дефицит бюджета: содержание и выплаты по займам превышают налоги на $${thousands(deficit)} за этот месяц`,
      null,
    );
  }

  if (inputs.workers > 0) {
    const rate = inputs.unemployed / inputs.workers;
    if (rate > UNEMPLOYMENT_TOLERATED) {
      // The class with the most residents out of work; the lower class on a tie.
      let worst = 0;
      for (let index = 1; index < inputs.unemployedByClass.length; index++) {
        if (inputs.unemployedByClass[index]! > inputs.unemployedByClass[worst]!) worst = index;
      }
      const cls = (['бедных', 'из среднего класса', 'богатых'] as const)[worst];
      add(
        'Unemployment',
        0.3 + 2 * (rate - UNEMPLOYMENT_TOLERATED),
        `Безработица ${percent(rate)}: ${residentsWord(inputs.unemployed)} без работы, больше всего ${cls}`,
        null,
      );
    }
  }

  if (inputs.demandResidential > DEMAND_UNMET) {
    add('HousingWanted', 0.2 + 0.8 * (inputs.demandResidential - DEMAND_UNMET), `Нужно жильё: жилой спрос ${percent(inputs.demandResidential)}`, null);
  }
  const jobs = Math.max(inputs.demandCommercial, inputs.demandIndustrial);
  if (jobs > DEMAND_UNMET) {
    add(
      'JobsWanted',
      0.2 + 0.8 * (jobs - DEMAND_UNMET),
      `Нужны рабочие места: торговый спрос ${percent(inputs.demandCommercial)}, промышленный ${percent(inputs.demandIndustrial)}`,
      null,
    );
  }

  // A school the player cannot build yet is no advice at all.
  if (inputs.schoolOpen && inputs.population > 0) {
    if (inputs.residentsBeyondSchool >= SCHOOL_REACH_WORTH) {
      const share = inputs.residentsBeyondSchool / inputs.population;
      add(
        'SchoolReach',
        0.25 + 0.4 * Math.min(share, 1),
        `Нет школы рядом: ${residentsWord(inputs.residentsBeyondSchool)} вне охвата школ`,
        null,
      );
    }
    const crowded = inputs.crowdedSchool;
    if (crowded !== null) {
      const missing = 1 - crowded.places / Math.max(crowded.residents, 1);
      add(
        'SchoolOvercrowded',
        0.25 + 0.4 * Math.max(missing, 0),
        `Школа переполнена: ${residentsWord(crowded.residents)} на ${thousands(crowded.places)} ${plural(crowded.places, 'место', 'места', 'мест')}`,
        crowded.at,
      );
    }
  }

  if (inputs.crimeShare > CRIME_SHARE_WORTH) {
    add(
      'Crime',
      0.2 + 0.6 * inputs.crimeShare,
      `Высокая преступность в ${percent(inputs.crimeShare)} города: полиция охватывает ${percent(inputs.policeCover)} зданий`,
      null,
    );
  }
  if (inputs.fireShare > FIRE_SHARE_WORTH) {
    add(
      'FireRisk',
      0.2 + 0.6 * inputs.fireShare,
      `Пожароопасно в ${percent(inputs.fireShare)} города: пожарные части охватывают ${percent(inputs.fireCover)} зданий`,
      null,
    );
  }
  if (inputs.poorHealthShare > POOR_HEALTH_SHARE_WORTH) {
    add(
      'PoorHealth',
      0.2 + 0.5 * inputs.poorHealthShare,
      `Плохое здоровье в ${percent(inputs.poorHealthShare)} домов: больницы охватывают ${percent(inputs.medicalCover)} зданий`,
      null,
    );
  }

  return problems.sort((a, b) => b.severity - a.severity || PROBLEM_KINDS.indexOf(a.kind) - PROBLEM_KINDS.indexOf(b.kind));
}

/** Group digits by thousands the way the interface prints money (`formatMoney`, HudBar.tsx): 6200 reads "6 200", a no-break space between the groups. */
export function thousands(value: number): string {
  const digits = String(Math.abs(value));
  let grouped = value < 0 ? '-' : '';
  for (let index = 0; index < digits.length; index++) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += '\u00a0';
    grouped += digits[index];
  }
  return grouped;
}

/**
 * The bits of `layer` over a building's footprint, OR-ed together, stopping once all of `wanted` are in. Plain index
 * arithmetic: on the metropolis the footprints hold millions of tiles, and a `TilePos` a tile made the hour's
 * assessment cost a quarter of a second.
 */
function footprintBits(grid: MapGrid, b: Building, layer: Uint8Array, wanted: number): number {
  const x0 = Math.max(b.anchor.x, 0);
  const x1 = Math.min(b.anchor.x + b.width, grid.width);
  const y0 = Math.max(b.anchor.y, 0);
  const y1 = Math.min(b.anchor.y + b.length, grid.height);
  let bits = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * grid.width;
    for (let x = x0; x < x1; x++) {
      bits |= layer[row + x]!;
      if ((bits & wanted) === wanted) return bits;
    }
  }
  return bits;
}

const RESIDENTIAL_CODE = 1 + BUILDING_KINDS.indexOf('Residential');
const COMMERCIAL_CODE = 1 + BUILDING_KINDS.indexOf('Commercial');
const INDUSTRIAL_CODE = 1 + BUILDING_KINDS.indexOf('Industrial');

/** Everything in the city the advisor reads. A source not laid over this map yet reads as nothing wrong. */
export function advisorInputs(w: World): AdvisorInputs {
  const grid = w.grid;
  const len = grid.len();
  const zoned: Building[] = w.buildings.all().filter((b) => isOperational(b) && isZonedKind(b.kind));
  const noReading = (): UtilityReading => ({ supply: 0, demand: 0, supplied: 0, buildingsWithout: 0, firstWithout: null });
  const utilities: AdvisorInputs['utilities'] = [noReading(), noReading(), noReading()];

  UTILITY_KINDS.forEach((kind, index) => {
    const totals = w.utilitySupply.totals(kind);
    utilities[index] = { ...utilities[index]!, supply: totals.supply, demand: totals.demand, supplied: totals.supplied };
  });
  const served = w.utilityNetwork.served;
  if (served.length === len) {
    const masks = UTILITY_KINDS.map(utilityMask);
    const all = masks.reduce((a, m) => a | m, 0);
    for (const b of zoned) {
      const bits = footprintBits(grid, b, served, all);
      if (bits === all) continue;
      masks.forEach((mask, index) => {
        if ((bits & mask) !== 0) return;
        // The count and the first of them, top row first, without sorting them all.
        const reading = utilities[index]!;
        reading.buildingsWithout += 1;
        const first = reading.firstWithout;
        if (first === null || b.anchor.y < first.y || (b.anchor.y === first.y && b.anchor.x < first.x)) reading.firstWithout = { ...b.anchor };
      });
    }
  }

  const employment = w.employmentStats;
  const unemployedByClass = WEALTH_CLASSES.map((cls) => employment.unemployedByClass[cls]) as [number, number, number];

  let residentsBeyondSchool = 0;
  let crowdedSchool: AdvisorInputs['crowdedSchool'] = null;
  const civic = w.civicCoverage;
  if (civic.covers(len)) {
    for (const b of zoned) {
      if (b.kind !== 'Residential') continue;
      const idx = grid.idx({ x: b.anchor.x + (b.width >> 1), y: b.anchor.y + (b.length >> 1) });
      if (idx === undefined || civic.get('School', idx) <= 0) residentsBeyondSchool += b.occupancyResidents;
    }
    // The weakest school short of its places; the first of equals.
    let weakest: (typeof civic.sources)[number] | null = null;
    for (const source of civic.sources) {
      if (source.kind !== 'School' || source.strength >= 1) continue;
      if (weakest === null || source.strength < weakest.strength) weakest = source;
    }
    if (weakest !== null) crowdedSchool = { residents: weakest.residents, places: weakest.capacity, at: { ...weakest.anchor } };
  }

  let crimeShare = 0;
  let fireShare = 0;
  let poorHealthShare = 0;
  const fields = w.cityFields;
  if (fields.covers(len)) {
    const crime = fields.values('Crime');
    const fire = fields.values('FireHazard');
    const health = fields.values('Health');
    let built = 0;
    let crimeTiles = 0;
    let fireTiles = 0;
    let homes = 0;
    let sick = 0;
    for (let idx = 0; idx < len; idx++) {
      const code = grid.building[idx]!;
      if (code !== RESIDENTIAL_CODE && code !== COMMERCIAL_CODE && code !== INDUSTRIAL_CODE) continue;
      built += 1;
      if (crime[idx]! >= CRIME_EMPTIES_HOMES_FROM) crimeTiles += 1;
      if (fire[idx]! >= FIRE_HAZARD_LIMIT) fireTiles += 1;
      if (code === RESIDENTIAL_CODE) {
        homes += 1;
        if (health[idx]! < HEALTH_FOR_LEVEL_THREE) sick += 1;
      }
    }
    crimeShare = crimeTiles / Math.max(built, 1);
    fireShare = fireTiles / Math.max(built, 1);
    poorHealthShare = sick / Math.max(homes, 1);
  }

  // The coverage index's own totals are counted at the last map edit; buildings grow without one, so the cover is
  // counted here over the buildings standing now.
  let policeCover = 0;
  let fireCover = 0;
  let medicalCover = 0;
  const coverage = w.serviceCoverage;
  if (coverage.coverageMap.length === len) {
    let police = 0;
    let fire = 0;
    let medical = 0;
    for (const b of zoned) {
      const mask = footprintBits(grid, b, coverage.coverageMap, MASK_POLICE | MASK_FIRE | MASK_MEDICAL);
      if ((mask & MASK_POLICE) !== 0) police += 1;
      if ((mask & MASK_FIRE) !== 0) fire += 1;
      if ((mask & MASK_MEDICAL) !== 0) medical += 1;
    }
    const whole = Math.max(zoned.length, 1);
    policeCover = police / whole;
    fireCover = fire / whole;
    medicalCover = medical / whole;
  }

  const lines = w.budget.current;
  return {
    buildings: zoned.length,
    utilities,
    workers: employment.employed + employment.unemployed,
    unemployed: employment.unemployed,
    unemployedByClass,
    demandResidential: w.rciDemand.residential,
    demandCommercial: w.rciDemand.commercial,
    demandIndustrial: w.rciDemand.industrial,
    population: w.city.population,
    schoolOpen: w.milestones.isUnlocked('School'),
    residentsBeyondSchool,
    crowdedSchool,
    crimeShare,
    fireShare,
    poorHealthShare,
    policeCover,
    fireCover,
    medicalCover,
    money: w.city.money,
    monthRunningNet: lines.total() - lines.get('Construction') - lines.get('LoanProceeds'),
    monthDays: w.budget.daysElapsed,
  };
}

/**
 * `update_advisor`: reassess the city on the tick a game hour turns, and on the first tick of a game. Not in Rust: once
 * more on the tick the first game minute of employment, demand and coverage is in (they run once a game minute, before
 * this system), since the first assessment read them empty and would stand for an hour. Runs every tick; a tick with
 * nothing new costs two checks.
 */
export function updateAdvisor(w: World): void {
  const firstMinuteIn = w.advisor.version === 1 && (w.tick + 1) % periodTicks(w, 60 * SECOND_NS) === 0;
  if (w.events.hourAdvanced.length === 0 && w.advisor.version > 0 && !firstMinuteIn) return;
  w.advisor.problems = assess(advisorInputs(w));
  w.advisor.version += 1;
}
