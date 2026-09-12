// The living city behind `?scenario=living`: the generated city with its utility stations, grown by its own citizens;
// the scenario only counts their trips for the HUD.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
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
    expect(stats.travelling).toBe(w.citizens.all().filter((c) => c.state === 'ToWork' || c.state === 'ToShop' || c.state === 'ToHome').length);
    scenario.advance(w);
    expect(scenario.stats(w), 'an advance without a tick counts nothing twice').toEqual(stats);
  }, 120_000);
});
