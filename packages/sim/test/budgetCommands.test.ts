// U6: the budget screen's levers as GameCommands (docs/plans/2026-09-15-web-remaining-work.md, Q4 (a)). The steps
// are those of on_budget_action in rust-final crates/simcity_frontend/src/game/hud/budget_panel.rs; here they go
// through COMMAND_APPLY, so they are deterministic and a replay of the commands repeats them.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../src/app';
import type { GameCommand } from '../src/commands';
import { newBuilding } from '../src/buildings/building';
import { MAX_FUNDING_PERCENT, MAX_TAX_PERCENT, TAX_ZONES, applyDailyEconomy } from '../src/economy/economy';
import { WEALTH_CLASSES } from '../src/economy/wealth';
import { fingerprint } from '../src/fingerprint';
import { buildHeadlessGame, reseed } from '../src/headless';
import { applyGameCommandsToGrid } from '../src/map/apply';
import { MapGrid } from '../src/map/grid';
import { SERVICE_KINDS } from '../src/services/stations';
import { requestState } from '../src/state';
import { SECOND_NS } from '../src/timer';
import { createWorld, type World } from '../src/world';
import { roadRow, t, worldOn } from './buildings/helpers';

/** Ten ticks a game hour, 240 a day: a ten-day budget month closes in 2 400 ticks. */
function fastGame(): World {
  const w = createWorld({ gameHourNs: SECOND_NS });
  requestState(w, 'InGame');
  frame(w, 0);
  reseed(w, 42n);
  return w;
}

/** Queue the commands and run one fixed tick, whose COMMAND_APPLY applies them. */
function apply(w: World, ...commands: GameCommand[]): void {
  w.commands.push(...commands);
  step(w, 1);
}

const taxUp: GameCommand = { kind: 'AdjustTaxRate', zone: 'Commercial', wealth: 'High', delta: 1 };
const taxDown: GameCommand = { kind: 'AdjustTaxRate', zone: 'Commercial', wealth: 'High', delta: -1 };

describe('budget commands', () => {
  it('taxCommandStepsOneRateByAPoint', () => {
    const w = buildHeadlessGame();
    apply(w, taxUp);
    expect(w.taxRates.get('Commercial', 'High')).toBe(10);
    expect(w.taxRates.get('Commercial', 'Low'), 'only the one rate moves').toBe(9);
    apply(w, taxDown, taxDown);
    expect(w.taxRates.get('Commercial', 'High')).toBe(8);

    apply(w, { kind: 'AdjustTaxRate', zone: 'Industrial', wealth: 'Low', delta: -50 });
    expect(w.taxRates.get('Industrial', 'Low'), 'never under zero').toBe(0);
    apply(w, { kind: 'AdjustTaxRate', zone: 'Industrial', wealth: 'Low', delta: 50 });
    expect(w.taxRates.get('Industrial', 'Low'), 'capped').toBe(MAX_TAX_PERCENT);
  });

  it('fundingCommandStepsTenPercent', () => {
    const w = buildHeadlessGame();
    const version = w.serviceFunding.version;
    apply(w, { kind: 'AdjustServiceFunding', service: 'Police', delta: -10 });
    expect(w.serviceFunding.get('Police')).toBe(90);
    apply(w, { kind: 'AdjustServiceFunding', service: 'Medical', delta: 10 });
    expect(w.serviceFunding.get('Medical')).toBe(110);
    expect(w.serviceFunding.get('Fire'), 'only the one service moves').toBe(100);
    expect(w.serviceFunding.version, 'coverage learns of the change').toBe(version + 2);

    apply(w, { kind: 'AdjustServiceFunding', service: 'Fire', delta: 1_000 });
    expect(w.serviceFunding.get('Fire'), 'capped').toBe(MAX_FUNDING_PERCENT);
  });

  it('takeLoanCommandPutsMoneyInTheTreasury', () => {
    const w = buildHeadlessGame();
    const money = w.city.money;
    apply(w, { kind: 'TakeLoan', principal: 10_000 });
    expect(w.loans.active).toHaveLength(1);
    expect(w.budget.current.get('LoanProceeds')).toBe(10_000);
    expect(w.city.money, 'no day closed in that tick: the loan is the whole change').toBe(money + 10_000);

    apply(w, { kind: 'TakeLoan', principal: 25_000 }, { kind: 'TakeLoan', principal: 50_000 });
    const before = w.city.money;
    apply(w, { kind: 'TakeLoan', principal: 10_000 });
    expect(w.loans.active, 'the bank refuses a fourth loan').toHaveLength(3);
    expect(w.budget.current.get('LoanProceeds')).toBe(85_000);
    expect(w.city.money, 'a refused loan moves nothing').toBe(before);
  });

  it('monthLinesSumToTheTreasuryChangeWithTheLeversPulled', () => {
    const w = fastGame();
    apply(w, { kind: 'TakeLoan', principal: 10_000 }, taxUp, { kind: 'AdjustServiceFunding', service: 'Fire', delta: -10 });
    // Twelve game days: past the close of the first ten-day month.
    step(w, 12 * 240);
    expect(w.budget.last, 'a month has closed').not.toBeNull();
    const last = w.budget.last!;
    expect(last.lines.get('LoanProceeds')).toBe(10_000);
    expect(last.lines.total()).toBe(last.moneyEnd - last.moneyStart);
    expect(w.budget.current.total()).toBe(w.city.money - w.budget.moneyStart);
  }, 60_000);

  // The levers reach the ledger: over one day of a town with people in every zone and three stations, five
  // points more tax is more tax in every zone and half funding is less station upkeep.
  it('taxAndFundingCommandsChangeTheDaysLines', () => {
    const oneDay = (edits: boolean) => {
      const grid = new MapGrid(16, 16);
      roadRow(grid, 0, 0, 15);
      const w = worldOn(grid);
      w.budget.restart(w.city.money);
      for (const [i, kind] of (['FireStation', 'PoliceStation', 'Hospital'] as const).entries()) w.buildings.add(newBuilding({ kind, anchor: t(i * 4, 1) }));
      for (const [i, kind] of (['Residential', 'Commercial', 'Industrial'] as const).entries()) {
        const [residents, jobs] = kind === 'Residential' ? [40, 0] : [0, 20];
        w.buildings.add(
          newBuilding({
            kind,
            anchor: t(i * 4, 8),
            constructionStartDay: 1,
            capacityResidents: residents,
            capacityJobs: jobs,
            occupancyResidents: residents,
            occupancyJobs: jobs,
            targetOccupancyResidents: residents,
            targetOccupancyJobs: jobs,
            profile: { density: 'Medium', class: 'Middle' },
          }),
        );
      }
      const levers: GameCommand[] = [];
      for (const zone of TAX_ZONES) for (const wealth of WEALTH_CLASSES) levers.push({ kind: 'AdjustTaxRate', zone, wealth, delta: 5 });
      for (const service of SERVICE_KINDS) levers.push({ kind: 'AdjustServiceFunding', service, delta: -50 });
      applyGameCommandsToGrid(w, edits ? levers : []);
      w.events.dayAdvanced.push(2);
      applyDailyEconomy(w);
      return w.budget.current;
    };
    const pulled = oneDay(true);
    const control = oneDay(false);
    for (const item of ['ResidentialTax', 'CommercialTax', 'IndustrialTax'] as const) {
      expect(control.get(item), `${item}: the town pays it`).toBeGreaterThan(0);
      expect(pulled.get(item), `${item}: five points more`).toBeGreaterThan(control.get(item));
    }
    expect(control.get('ServiceMaintenance'), 'the stations cost upkeep').toBeLessThan(0);
    expect(pulled.get('ServiceMaintenance'), 'half funding costs less upkeep').toBeGreaterThan(control.get('ServiceMaintenance'));
  });

  it('twoRunsWithTheSameEditsHaveTheSameFingerprint', () => {
    const run = (edits: boolean): ReturnType<typeof fingerprint> => {
      const w = fastGame();
      step(w, 100);
      // The run without edits ticks as often, so only the commands differ.
      apply(w, ...(edits ? [taxUp, { kind: 'AdjustServiceFunding', service: 'Police', delta: -10 } as const] : []));
      step(w, 500);
      apply(w, ...(edits ? [{ kind: 'TakeLoan', principal: 25_000 } as const, taxDown, taxDown] : []));
      // Past a month's close, so the edited rates, funding and loan payment reach the ledger.
      step(w, 2_400);
      return fingerprint(w);
    };
    const a = run(true);
    expect(run(true), 'the same edits at the same ticks give the same world').toBe(a);
    expect(run(false), 'the edits are in the fingerprint').not.toBe(a);
  }, 60_000);
});
