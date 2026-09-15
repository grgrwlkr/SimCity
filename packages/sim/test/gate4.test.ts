// Gate of stage 4 (docs/plans/2026-09-14-web-phase-4-services.md). The Rust oracle is out of reach of the port — cargo is not
// run — so the stage 2 thresholds are read on the TS world itself: no divergence of state between two runs,
// no micro car waiting for green 600 ticks or longer, no route against a lane, no meso car queued that long past its time,
// no system error; and the systems of the stage at work in the living city — walkers on crossings, the bus at its stops, an
// emergency served and resolved.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../src/app';
import { startEmergency } from '../src/emergencies';
import { fingerprint } from '../src/fingerprint';
import { buildCity } from '../src/scenarios/cityGen';
import { CityCommuteScenario } from '../src/scenarios/cityCommute';
import { LivingCityScenario } from '../src/scenarios/livingCity';
import { requestState } from '../src/state';
import { SECOND_NS } from '../src/timer';
import { routeDirectionOk } from '../src/traffic/reroute';
import { vehicleRef } from '../src/traffic/vehicles';
import { createWorld, type World } from '../src/world';

const TICKS = 3000;
/** The stage 2 soak: 600 ticks, a minute of the real-time clock. */
const SOAK_TICKS = 600;

function livingCity(): World {
  const w = createWorld({ gameHourNs: 60 * SECOND_NS });
  requestState(w, 'InGame');
  frame(w, 0);
  new LivingCityScenario(w);
  // A crime at a house from the start, besides those that break out: four hours on the scene fit the run's five.
  const house = w.buildings.all().find((b) => b.kind === 'Residential')!;
  startEmergency(w, 'Crime', house.anchor, 0.5);
  return w;
}

describe('stage 4 gate', () => {
  it('theFullWorldHoldsStageTwoThresholds', () => {
    const [a, b] = [livingCity(), livingCity()];
    // On an hour of a minute a tick carries six game seconds.
    const soakSecs = SOAK_TICKS * 6;
    let divergedAt = -1;
    let longestQueuedPastTime = 0;
    let ticksWithWalkersOnCrossings = 0;
    let busStops = 0;
    let dispatched = 0;
    let wasDwelling = false;
    for (let tick = 1; tick <= TICKS; tick++) {
      step(a, 1);
      step(b, 1);
      // Every hundredth tick and the last: on every tick the test takes 137 s instead of 2 s, and a divergence stays diverged.
      if (divergedAt < 0 && (tick % 100 === 0 || tick === TICKS) && fingerprint(a) !== fingerprint(b)) divergedAt = tick;
      const m = a.mesoTraffic;
      for (let car = 0; car < m.highWater; car++) if (m.link[car] !== -1) longestQueuedPastTime = Math.max(longestQueuedPastTime, m.nowSec - m.readySec[car]!);
      if (a.pedestrianCrossings.length > 0) ticksWithWalkersOnCrossings += 1;
      const bus = a.fleet.buses[0];
      if (bus !== undefined && bus.state === 'Dwelling' && !wasDwelling) busStops += 1;
      wasDwelling = bus?.state === 'Dwelling';
      dispatched = Math.max(dispatched, a.fleet.services.filter((v) => v.state !== 'AtStation').length);
    }
    const e = a.emergencies;
    const m = a.mesoTraffic;
    const summary = [
      `diverged at ${divergedAt}`,
      `longest queued past its time ${longestQueuedPastTime.toFixed(0)} s`,
      `ticks with walkers on crossings ${ticksWithWalkersOnCrossings}`,
      `bus stops ${busStops}`,
      `most service vehicles out ${dispatched}`,
      `emergencies ${JSON.stringify(e.stats)} active ${e.active.length}`,
      `meso arrived ${m.stats.arrived} pushes ${m.stats.forcedPushes} yields expired ${m.stats.pedestrianYieldsExpired} dropped ${m.stats.dropped}`,
      `citizens ${a.citizens.count} errors ${[...a.systemErrors.keys()].join(' ')}`,
    ].join('; ');
    console.log(`stage 4 gate: ${summary}`);
    expect(divergedAt, `no state diverges between two runs: ${summary}`).toBe(-1);
    expect([...a.systemErrors.keys()], summary).toEqual([]);
    expect(longestQueuedPastTime, `no meso car stands a soak past its time: ${summary}`).toBeLessThan(soakSecs);
    expect(ticksWithWalkersOnCrossings, `walkers cross: ${summary}`).toBeGreaterThan(0);
    expect(busStops, `the bus goes round its stops: ${summary}`).toBeGreaterThanOrEqual(2);
    expect(e.stats.resolvedInTime, `an emergency is served and resolved: ${summary}`).toBeGreaterThanOrEqual(1);
    // The crime of `livingCity` is started by hand; the gate wants emergencies that break out by the hour's roll too.
    const brokeOut = e.stats.totalFires + e.stats.totalCrimes + e.stats.totalMedical - 1;
    expect(brokeOut, `emergencies break out by themselves: ${summary}`).toBeGreaterThanOrEqual(1);
    expect(dispatched, `service vehicles go out: ${summary}`).toBeGreaterThanOrEqual(1);
  }, 600_000);

  it('theCityOfCommutersKeepsItsLightsFlowing', () => {
    const w = createWorld();
    requestState(w, 'InGame');
    frame(w, 0);
    const plan = buildCity(w, { zones: false });
    const scenario = new CityCommuteScenario(w, { citizens: 2000, departureWindowTicks: 3000, stayTicks: [1200, 3600], homes: plan.homes, workplaces: plan.workplaces });
    const v = w.vehicles;
    const waitingSince = new Map<number, number>();
    let longestWaitForGreen = 0;
    let wrongWay = 0;
    for (let tick = 1; tick <= TICKS; tick++) {
      scenario.advance(w);
      step(w, 1);
      for (const slot of v.order) {
        if (v.parked[slot] === 1) continue;
        const ref = vehicleRef(v, slot);
        if (v.trafficState[slot]!.kind === 'WaitingForGreen') {
          if (!waitingSince.has(ref)) waitingSince.set(ref, tick);
          longestWaitForGreen = Math.max(longestWaitForGreen, tick - waitingSince.get(ref)!);
        } else waitingSince.delete(ref);
        if (tick % SOAK_TICKS === 0 && !routeDirectionOk(w.pathPool.remainingFrom(v.pathHandle[slot]!, v.pathCursor[slot]!) ?? [], w.grid)) wrongWay += 1;
      }
    }
    const summary = `requested ${scenario.requested}, arrived ${scenario.arrived}, longest wait for green ${longestWaitForGreen} ticks, wrong way ${wrongWay}, errors ${[...w.systemErrors.keys()].join(' ')}`;
    console.log(`stage 4 gate, micro: ${summary}`);
    // Departures spread over the whole run: most of the later ones are still on their way at its end.
    expect(scenario.requested, summary).toBeGreaterThan(1000);
    expect(scenario.arrived, summary).toBeGreaterThan(0);
    expect(longestWaitForGreen, summary).toBeLessThan(SOAK_TICKS);
    expect(wrongWay, summary).toBe(0);
    expect([...w.systemErrors.keys()], summary).toEqual([]);
  }, 600_000);
});
