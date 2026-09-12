// The city scenario behind `?scenario=city`: commuters drive their own cars between home and work on the
// test city, park there, and drive back later.
import { describe, expect, it } from 'vitest';
import { step } from '../../src/app';
import { CityCommuteScenario } from '../../src/scenarios/cityCommute';
import { routeDirectionOk } from '../../src/traffic/reroute';
import { loadTestCity } from '../testCity';

describe('city commute scenario', () => {
  it('commutersDriveParkAndComeBack', () => {
    const w = loadTestCity();
    const scenario = new CityCommuteScenario(w, { citizens: 300 });
    for (let i = 0; i < 1500; i++) {
      scenario.advance(w);
      step(w, 1);
    }

    const v = w.vehicles;
    const parked = v.order.filter((slot) => v.parked[slot] === 1);
    const driving = v.order.filter((slot) => v.parked[slot] !== 1);
    expect(w.trafficLights.length, 'the city keeps its lights').toBe(6);
    expect(scenario.requested, 'trips leave').toBeGreaterThan(250);
    expect(scenario.arrived, 'and arrive').toBeGreaterThan(100);
    expect(parked.length, 'cars stand parked at home or work').toBeGreaterThan(20);
    expect(driving.length, 'while others drive').toBeGreaterThan(50);
    const wrongWay = driving.filter((slot) => !routeDirectionOk(w.pathPool.remainingFrom(v.pathHandle[slot]!, v.pathCursor[slot]!) ?? [], w.grid));
    expect(wrongWay.length, 'no route against a lane').toBe(0);
  });

  it('anArrivalCountsOnceWhenTheHostAdvancesWithoutATick', () => {
    // The host feeds a scenario before every step tick and again once per frame.
    const w = loadTestCity();
    const scenario = new CityCommuteScenario(w, { citizens: 300 });
    let seen = 0;
    for (let i = 0; i < 1500 && seen === 0; i++) {
      step(w, 1);
      scenario.advance(w);
      seen = scenario.arrived;
      scenario.advance(w);
      expect(scenario.arrived, `tick ${w.tick}: advance twice, count once`).toBe(seen);
    }
    expect(seen, 'the run saw an arrival').toBeGreaterThan(0);
  });
});
