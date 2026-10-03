import {describe, expect, it} from 'vitest';
import {stepDevelopment} from '../src/region/model/life/development';
import {stepEconomy} from '../src/region/model/life/economy';
import {applyAction} from '../src/region/model/commands';
import {RegionMobility} from '../src/region/model/life/mobility';
import {
  completeResidentTrip,
  stepResidents,
  regionalPopulation,
  updateResidentActivities,
} from '../src/region/model/life/residents';
import type {MutableRegion} from '../src/region/model/life/types';
import {regionalLayout} from './helpers/regionLifeFixture';

function developed(): MutableRegion {
  const state: MutableRegion = regionalLayout();

  for (let second = 1; second <= 2800; second++) {
    state.life.elapsedSeconds = second;
    stepDevelopment(state);
  }

  return state;
}

describe('regional residents', () => {
  it('ends a shift even when a disconnected road prevents the journey home', () => {
    const state = developed();
    const family = state.life.families[0]!;
    const actor = state.life.people.find(
      person => person.id === family.memberIds[0],
    )!;
    const employer = state.life.buildings.find(
      building => building.kind === 'industrial' && building.stage === 'ready',
    )!;

    family.status = 'settled';

    for (const person of state.life.people.filter(
      person => person.familyId === family.id,
    )) {
      person.placeId = family.homeId;
      person.activity = 'home';
    }

    actor.jobId = employer.id;
    actor.placeId = employer.id;
    actor.activity = 'work';
    state.life.elapsedSeconds = 39_600;
    const connector = state.roads.find(road => road.points[0]!.x === -536)!;
    const removed = applyAction(
      state,
      {type: 'remove', id: connector.id},
      state.revision,
    );

    expect(removed.ok).toBe(true);
    const isolated: MutableRegion = removed.state;
    const mobility = new RegionMobility(isolated);

    stepResidents(isolated, mobility);
    const waiting = isolated.life.people.find(
      person => person.id === actor.id,
    )!;

    expect(waiting.activity).toBe('waiting');
    expect(waiting.reason).toBe('no-route');
    isolated.life.elapsedSeconds += 60;
    stepEconomy(isolated);
    expect(waiting.workedSeconds).toBe(0);
    expect(isolated.life.economy.wagesPaid).toBe(0);
  });
  it('arrives through a real external car trip, then has a home and reachable work', () => {
    const state = developed();
    const mobility = new RegionMobility(state);

    expect(regionalPopulation(state)).toBe(0);
    state.life.elapsedSeconds = 2820;
    stepResidents(state, mobility);
    expect(state.life.families.some(f => f.status === 'arriving')).toBe(true);
    expect(regionalPopulation(state)).toBe(0);
    const arrival = state.life.trips.find(t => t.purpose === 'arrival')!;

    expect(arrival.route.lane.length).toBeGreaterThan(1000);

    for (let second = 1; second <= 500; second++) {
      state.life.elapsedSeconds++;

      for (const trip of mobility.step(1)) {
        completeResidentTrip(state, trip);
      }

      updateResidentActivities(state);
    }

    mobility.save();
    expect(regionalPopulation(state)).toBeGreaterThan(0);
    const family = state.life.families.find(f => f.status === 'settled')!;
    const members = state.life.people.filter(p => p.familyId === family.id);

    expect(members.every(p => p.placeId === family.homeId)).toBe(true);
    expect(members.some(p => p.jobId !== null)).toBe(true);
    expect(state.life.cars.filter(c => c.familyId === family.id)).toHaveLength(
      1,
    );
  });
  it('leaves families outside when the entry is disconnected and never invents travel', () => {
    const state = developed();

    state.roads = state.roads.filter(
      road => road.id !== state.externalEntries[0]!.roadId,
    );
    state.roadRevision++;
    state.externalEntries = [];
    state.life.elapsedSeconds = 2820;
    const mobility = new RegionMobility(state);

    stepResidents(state, mobility);
    expect(regionalPopulation(state)).toBe(0);
    expect(state.life.trips).toHaveLength(0);
    expect(
      state.life.families
        .filter(f => f.availableAt <= state.life.elapsedSeconds)
        .some(f => f.reason !== null),
    ).toBe(true);
  });
});
