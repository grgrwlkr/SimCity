// Gate of stage 3½c: the living city drives a whole day of rush hours by meso traffic. On an hour of 60 s a tick carries
// six game seconds; the numbers are written to the stage plan.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import { LivingCityScenario } from '../../src/scenarios/livingCity';
import { requestState } from '../../src/state';
import { SECOND_NS } from '../../src/timer';
import { createWorld } from '../../src/world';

const TICKS_PER_DAY = 24 * 600;

describe('stage 3½c gate', () => {
  it('theLivingCityDrivesADayOfRushHoursByMeso', () => {
    const w = createWorld({ gameHourNs: 60 * SECOND_NS });
    requestState(w, 'InGame');
    frame(w, 0);
    new LivingCityScenario(w);

    let carTrips = 0;
    let arrivals = 0;
    let longestQueue = 0;
    let busiest = 0;
    for (let tick = 0; tick < TICKS_PER_DAY; tick++) {
      step(w, 1);
      carTrips += w.events.tripRequested.filter((trip) => trip.pocket === true).length;
      arrivals += w.events.tripFinished.length;
      if (tick % 10 === 0) {
        const m = w.mesoTraffic;
        busiest = Math.max(busiest, m.carCount());
        for (let link = 0; link < w.meso.linkCount; link++) longestQueue = Math.max(longestQueue, m.carsOn(link));
      }
    }

    const m = w.mesoTraffic;
    const summary = `car trips ${carTrips}, arrived ${arrivals}, still driving ${m.carCount()}, waiting to leave ${m.pending.length}, forced pushes ${m.stats.forcedPushes}, longest queue ${longestQueue}, busiest ${busiest}, errors ${[...w.systemErrors.keys()].join(' ')}`;
    console.log(summary);
    expect([...w.systemErrors.keys()], summary).toEqual([]);
    expect(carTrips, `the city drives: ${summary}`).toBeGreaterThan(1000);
    expect(arrivals / (carTrips - m.carCount() - m.pending.length), `and gets there: ${summary}`).toBeGreaterThan(0.9);
  }, 300_000);
});
