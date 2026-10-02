// Emergencies of crates/simcity_sim/src/game/emergencies/systems.rs. Its `emergencies/tests.rs` pins the map markers and is
// ported with the renderer (packages/render/test/emergencyMarkers.test.ts); `city_field_tests` is ported here, and the rest
// are TS tests of the systems Rust left untested: spawn, dispatch, resolution, failure.
import { describe, expect, it } from 'vitest';
import { step } from '../src/app';
import { EMERGENCY_MAX_ACTIVE, pickEmergencySite, spawnEmergencies, startEmergency } from '../src/emergencies';
import { emptyEvents } from '../src/events';
import { stdRngSeedFromU64 } from '../src/rng';
import type { World } from '../src/world';
import { layRoads } from './meso/helpers';
import { SIZED_IN_TICKS } from './scenarios/sizedInTicks';
import { place, street, t } from './services/helpers';

/** Steps `w` a tick at a time until `done` holds, at most `limit` ticks; the ticks it took. */
function until(w: World, done: () => boolean, limit: number): number {
  for (let ticks = 0; ticks < limit; ticks++) {
    if (done()) return ticks;
    step(w, 1);
  }
  return done() ? limit : Infinity;
}

describe('emergencies', () => {
  // Not in Rust: the feed's names live in a leaf module, so the service vehicles read them without importing this one.
  it('emergencyNamesLiveInALeafModule', async () => {
    const { EMERGENCY_NAMES } = await import('../src/emergencyNames');
    expect(EMERGENCY_NAMES).toEqual({ Fire: 'Пожар', Crime: 'Преступление', Medical: 'Вызов скорой' });
  });

  it('cityFieldsFireHazardSetsWhereFiresBreakOut', () => {
    const [risky, safe] = [t(1, 1), t(9, 9)];
    const sites = [
      [risky, 0.9],
      [safe, 0.05],
    ] as const;
    const rng = stdRngSeedFromU64(7n);
    let fires = 0;
    for (let i = 0; i < 1000; i++) if (pickEmergencySite(sites, 'Fire', rng) === risky) fires += 1;
    expect(fires, `${fires} of 1000 fires at the hazardous building`).toBeGreaterThan(800);
    let crimes = 0;
    for (let i = 0; i < 1000; i++) if (pickEmergencySite(sites, 'Crime', rng) === risky) crimes += 1;
    expect(crimes, `fire hazard does not draw crime: ${crimes} of 1000`).toBeGreaterThanOrEqual(350);
    expect(crimes).toBeLessThan(650);
    expect(pickEmergencySite([], 'Fire', rng)).toBeUndefined();
  });

  it('aBigCityHasAnEmergencyAnHourAndNeverMoreThanItsCap', () => {
    const w = street();
    place(w, 'Residential', t(20, 9));
    w.emergencies.baseSpawnChance = 0.06;
    w.city.population = 10_000;
    const hour = () => {
      w.events = emptyEvents();
      w.events.hourAdvanced.push({ hour: 3, day: 1 });
      spawnEmergencies(w);
    };
    hour();
    expect(w.emergencies.active, 'a hundred times the chance of a village: one an hour').toHaveLength(1);
    expect(w.notifications.history().at(-1)!.text).toMatch(/^(Пожар|Преступление|Вызов скорой)$/);
    for (let i = 0; i < 20; i++) hour();
    expect(w.emergencies.active).toHaveLength(EMERGENCY_MAX_ACTIVE);
    w.events = emptyEvents();
    spawnEmergencies(w);
    expect(w.emergencies.active, 'nothing breaks out between the hours').toHaveLength(EMERGENCY_MAX_ACTIVE);
  });

  it('aFireIsServedFromTheNearestStation', () => {
    const w = street();
    const far = place(w, 'FireStation', t(6, 9));
    const near = place(w, 'FireStation', t(48, 9));
    const house = place(w, 'Residential', t(38, 9));
    const fire = startEmergency(w, 'Fire', house.anchor, 0.5);
    step(w, 1);

    const sent = w.fleet.services.find((v) => v.mission === fire.id);
    expect(sent?.station, 'the nearer station sends a vehicle').toBe(near.id);
    expect(sent!.state).toBe('EnRoute');
    expect(w.fleet.services.filter((v) => v.station === far.id).every((v) => v.state === 'AtStation')).toBe(true);

    expect(until(w, () => fire.responded, 600), 'it gets there').toBeLessThan(600);
    expect(sent!.state).toBe('OnScene');
    // Six game hours on the scene, 3 600 ticks on an hour of a minute.
    expect(until(w, () => !w.emergencies.active.includes(fire), 4000), 'the fire is put out and the emergency is over').toBeGreaterThan(3000);
    expect([fire.resolved, fire.failed, w.emergencies.stats.resolvedInTime]).toEqual([true, false, 1]);
    expect(sent!.state).toBe('Returning');
    expect(until(w, () => sent!.state === 'AtStation', 600), 'and the vehicle comes back').toBeLessThan(600);
    expect(w.fleet.services.every((v) => v.state === 'AtStation' && v.mission === -1)).toBe(true);
  }, SIZED_IN_TICKS);

  it('anEmergencyNobodyServesFailsAndHurtsHappiness', () => {
    const w = street();
    const house = place(w, 'Residential', t(38, 9));
    w.city.happiness = Math.fround(0.65);
    const fire = startEmergency(w, 'Fire', house.anchor, 0.5);
    // Twelve game hours to respond; the city opens at midnight and no day turns meanwhile.
    step(w, 11 * 600);
    expect(fire.failed).toBe(false);
    step(w, 2 * 600);
    expect([fire.failed, w.emergencies.active.length, w.emergencies.stats.failedResponses]).toEqual([true, 0, 1]);
    expect(w.city.happiness).toBeCloseTo(0.65 - 0.05 * 0.5, 5);
  }, SIZED_IN_TICKS);

  it('anEmergencyAStationCannotReachIsLeftToOthers', () => {
    const w = street();
    // A second street on rows 1..2, joined to nothing, with the station on it.
    layRoads(w, [[t(20, 2), t(40, 2), 'TwoLane']]);
    const station = place(w, 'PoliceStation', t(30, 3));
    const house = place(w, 'Residential', t(38, 9));
    const crime = startEmergency(w, 'Crime', house.anchor, 0.5);
    step(w, 5);
    expect(crime.triedStations, 'its trip found no way').toEqual([station.id]);
    expect(crime.assignedVehicle).toBe(-1);
    expect(w.fleet.services.every((v) => v.state === 'AtStation')).toBe(true);
    const dropped = w.mesoTraffic.stats.dropped;
    step(w, 50);
    expect(w.mesoTraffic.stats.dropped, 'and it is not sent again').toBe(dropped);
  });
});
