// Gate of stage 3b (docs/plans/2026-09-12-web-phase-3-economy.md): a city laid out by commands lives 30 game days with
// its economy computed and no scenario feeding it. Every closed budget month adds up to the change in the treasury,
// citizens hold jobs, and the cars on its roads carry their trips.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import type { GameCommand, ZoneKind } from '../../src/commands';
import type { BudgetReport } from '../../src/economy/economy';
import { roadSegmentCommands } from '../../src/map/roadTool';
import { requestState } from '../../src/state';
import { createWorld } from '../../src/world';

/** Ten ticks a game hour. */
const TICKS_PER_DAY = 240;
const DAYS = 30;

describe('stage 3b gate', () => {
  it('aCityBuiltByCommandsBalancesItsBooksEmploysItsPeopleAndDrivesTheirTrips', () => {
    const w = createWorld();
    requestState(w, 'InGame');
    frame(w, 0);

    // A two-lane road on rows 19..20, zones on both sides, a power plant and a water pump beside it.
    const commands: GameCommand[] = [...roadSegmentCommands({ x: 10, y: 20 }, { x: 62, y: 20 }, 'TwoLane', w.trafficConfig.driveOnRight, false)];
    const zone = (kind: ZoneKind, x0: number, x1: number, y0: number, y1: number) => {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) commands.push({ kind: 'SetZone', pos: { x, y }, zone: kind, density: 'Medium' });
    };
    zone('Residential', 12, 26, 21, 23);
    zone('Residential', 16, 40, 16, 18);
    zone('Commercial', 28, 40, 21, 23);
    zone('Industrial', 42, 56, 21, 23);
    commands.push({ kind: 'PlaceBuilding', pos: { x: 58, y: 21 }, building: 'PowerPlant' });
    commands.push({ kind: 'PlaceBuilding', pos: { x: 12, y: 16 }, building: 'WaterPump' });
    w.commands.push(...commands);

    const reports: BudgetReport[] = [];
    let trips = 0;
    let arrivals = 0;
    let carsWithCitizens = 0;
    for (let tick = 0; tick < DAYS * TICKS_PER_DAY; tick++) {
      step(w, 1);
      const last = w.budget.last;
      if (last !== null && reports.at(-1) !== last) reports.push(last);
      trips += w.events.tripRequested.length;
      arrivals += w.events.tripFinished.length;
      const v = w.vehicles;
      let carrying = 0;
      for (const slot of v.order) if (v.parked[slot] !== 1 && w.citizens.get(v.passengerCitizen[slot]!) !== undefined) carrying += 1;
      carsWithCitizens = Math.max(carsWithCitizens, carrying);
    }

    const summary = `population ${w.city.population}, citizens ${w.citizens.all().length}, employed ${w.employmentStats.employed}, trips ${trips}, arrivals ${arrivals}, money ${w.city.money}`;
    expect(reports.length, `three ten-day months: ${summary}`).toBe(3);
    for (const report of reports) {
      expect(report.lines.total(), `month ${report.month}: ${JSON.stringify(report.lines.entries())}`).toBe(report.moneyEnd - report.moneyStart);
    }
    expect(w.city.population, summary).toBeGreaterThan(0);
    expect(w.employmentStats.employed, `citizens hold jobs: ${summary}`).toBeGreaterThan(0);
    expect(trips, `citizens request trips: ${summary}`).toBeGreaterThan(0);
    expect(arrivals, `and arrive: ${summary}`).toBeGreaterThan(0);
    expect(carsWithCitizens, `cars on the road carry citizens: ${summary}`).toBeGreaterThan(0);
  }, 180_000);
});
