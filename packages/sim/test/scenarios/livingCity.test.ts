// The living city behind `?scenario=living`: the generated city with its utility stations, grown by its own citizens;
// the scenario only counts their trips for the HUD.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import { isOperational } from '../../src/buildings/building';
import { CITIZEN_STATES } from '../../src/citizens';
import type { BuildingKind } from '../../src/commands';
import { LivingCityScenario } from '../../src/scenarios/livingCity';
import { requestState } from '../../src/state';
import { SECOND_NS } from '../../src/timer';
import { createWorld } from '../../src/world';

/** On a ten-tick hour: the city takes days to grow. */
function livingCity() {
  const w = createWorld({ gameHourNs: SECOND_NS });
  requestState(w, 'InGame');
  frame(w, 0);
  return { w, scenario: new LivingCityScenario(w) };
}

describe('living city', () => {
  it('theLivingCityStandsItsStationsBesideItsRoadsForFree', () => {
    const { w } = livingCity();
    const count = (kind: BuildingKind) => w.buildings.all().filter((b) => b.kind === kind).length;
    expect([count('PowerPlant'), count('WaterPump')], 'power and water for every district').toEqual([3, 3]);
    expect(w.city.money, 'a demonstration city costs the treasury nothing').toBe(25_000);
    expect(w.budget.current.isEmpty(), 'and the month starts with nothing on its lines').toBe(true);
  });

  // At a real-time clock a house takes eight hours to build: the city opens built and lived in, with room left to grow.
  it('theLivingCityOpensBuiltAndLivedIn', () => {
    const { w } = livingCity();
    const open = (kind: BuildingKind) => w.buildings.all().filter((b) => b.kind === kind && isOperational(b)).length;
    expect([open('Residential'), open('Commercial'), open('Industrial')].every((n) => n > 20), 'homes, shops and works stand open').toBe(true);
    const zoned = w.grid.zone.filter((zone) => zone !== 0).length;
    const built = w.grid.zone.filter((zone, i) => zone !== 0 && w.grid.building[i] !== 0).length;
    expect(built / zoned, 'with zoned land left to grow on').toBeLessThan(0.8);

    const citizens = w.citizens;
    expect(citizens.count, 'thousands live there from the start').toBeGreaterThan(2000);
    const views = citizens.refs().map((ref) => citizens.view(ref)!);
    expect(views.filter((c) => c.workplace !== null).length / views.length, 'most of them with a job').toBeGreaterThan(0.5);
    expect(views.filter((c) => c.carStatus === 'Parked').length, 'their cars parked').toBeGreaterThan(0);
    expect(w.city.money, 'at no cost to the treasury').toBe(25_000);

    const moved = citizens.count;
    for (let i = 0; i < 240; i++) step(w, 1);
    expect(citizens.count, 'and a day later they still live there').toBeGreaterThan(0.8 * moved);
  }, 120_000);

  // Stage 3½: somewhere to go besides work and the shops, one of each for now.
  it('theLivingCityHasAParkAndACafeItsPeopleGoTo', () => {
    const { w, scenario } = livingCity();
    const open = (kind: BuildingKind) => w.buildings.all().filter((b) => b.kind === kind && isOperational(b));
    expect([open('Park').length, open('Cafe').length], 'a park and a café, open from the start').toEqual([1, 1]);

    const purposes = new Map<string, number>();
    for (let i = 0; i < 240; i++) {
      scenario.advance(w);
      step(w, 1);
      for (const trip of w.events.tripRequested) purposes.set(trip.purpose, (purposes.get(trip.purpose) ?? 0) + 1);
    }
    expect(purposes.get('Park') ?? 0, `people go to the park: ${JSON.stringify([...purposes])}`).toBeGreaterThan(0);
    expect(purposes.get('Cafe') ?? 0, 'and to the café').toBeGreaterThan(0);
    const stats = scenario.stats(w);
    expect(stats.arrived, `arrivals on foot count too: ${JSON.stringify(stats)}`).toBeGreaterThan(0.9 * (stats.requested - stats.travelling));
  }, 120_000);

  it('itsCitizensMoveInAndDriveOnTheirOwn', () => {
    const { w, scenario } = livingCity();
    for (let i = 0; i < 10 * 240; i++) {
      scenario.advance(w);
      step(w, 1);
    }
    // The host snapshots after the last tick of a frame: its trips count before the next advance, and only once after it.
    const stats = scenario.stats(w);
    expect(stats.citizens, 'people moved in').toBeGreaterThan(0);
    expect(stats.requested, 'and set out').toBeGreaterThan(0);
    const states = w.citizens.refs().map((ref) => w.citizens.view(ref)!.state);
    expect(stats.travelling).toBe(states.filter((state) => state.startsWith('To')).length);
    scenario.advance(w);
    expect(scenario.stats(w), 'an advance without a tick counts nothing twice').toEqual(stats);
  }, 120_000);

  // Stage 3½b: the counts by state, home and workplace are kept as citizens change, never recounted; they must agree.
  it('stateCountsMatchARecount', () => {
    const { w, scenario } = livingCity();
    for (let i = 0; i < 3 * 240; i++) {
      scenario.advance(w);
      step(w, 1);
    }
    const citizens = w.citizens;
    const views = citizens.refs().map((ref) => citizens.view(ref)!);
    expect(views.length, 'people moved in').toBeGreaterThan(0);
    for (const state of CITIZEN_STATES) expect(citizens.stateCount(state), state).toBe(views.filter((c) => c.state === state).length);
    for (const b of w.buildings.all()) {
      expect(citizens.residentsOf(b.id), `residents of building ${b.id}`).toBe(views.filter((c) => c.home === b.id).length);
      expect(citizens.workersOf(b.id), `workers of building ${b.id}`).toBe(views.filter((c) => c.workplace === b.id).length);
    }
    expect(w.parking.totalUsed(), 'every car of a citizen holds one spot').toBe(views.filter((c) => c.carStatus !== 'None').length);
    expect(w.vehicles.order.filter((slot) => w.vehicles.parked[slot] === 1), 'and no vehicle slot while it stands').toEqual([]);
  }, 120_000);
});
