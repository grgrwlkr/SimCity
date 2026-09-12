// Port of the tests in crates/simcity_sim/src/game/citizens.rs, and of the trip loop they left untested: moving
// in, driving to work and back, and the cars of citizens who left.
import { describe, expect, it } from 'vitest';
import { newBuilding, type Building } from '../src/buildings/building';
import {
  CITIZEN_TRIP_TIMEOUT_SECS,
  citizenTripPlanner,
  cleanupHomelessCitizens,
  despawnOrphanedOwnedCars,
  handleTripFinished,
  newCitizen,
  recoverStuckTrips,
  spawnCitizensFromResidential,
} from '../src/citizens';
import { emptyEvents } from '../src/events';
import { MapGrid } from '../src/map/grid';
import { SECOND_NS } from '../src/timer';
import { refSlot, resolveVehicle, spawnVehicle } from '../src/traffic/vehicles';
import type { World } from '../src/world';
import { t, worldOn } from './buildings/helpers';

function home(w: World, anchor = t(5, 5), occupancy = 5): Building {
  return w.buildings.add(newBuilding({ kind: 'Residential', anchor, capacityResidents: 8, occupancyResidents: occupancy, targetOccupancyResidents: occupancy }));
}

const liveIds = (w: World) => w.citizens.all().map((c) => c.id);

describe('citizens', () => {
  it('recoverStuckTripsRevertsOrphanedButKeepsInProgressAndStable', () => {
    const w = worldOn(new MapGrid(16, 16));
    const house = home(w, t(1, 1));
    const trip = { lastPlace: t(5, 5), tourMode: 'Car', carParkedAt: t(9, 9) } as const;
    // Departed far past the timeout, at a clock near zero.
    const stuck = w.citizens.add({ ...newCitizen(house), ...trip, state: 'ToShop', tripDepartedAtSec: -(CITIZEN_TRIP_TIMEOUT_SECS + 50), tripPurpose: 'Shop' });
    const fresh = w.citizens.add({ ...newCitizen(house), ...trip, state: 'ToWork', tripDepartedAtSec: -1, tripPurpose: 'Work' });
    const stable = w.citizens.add({ ...newCitizen(house), ...trip, state: 'AtWork', tripDepartedAtSec: -(CITIZEN_TRIP_TIMEOUT_SECS + 50), tripPurpose: 'Work' });

    recoverStuckTrips(w);

    expect(stuck.state, 'an orphaned citizen in transit goes back home').toBe('AtHome');
    expect(stuck.carParkedAt, 'with the car at home').toEqual(house.anchor);
    expect(fresh.state, 'a trip within the timeout is left alone').toBe('ToWork');
    expect(stable.state, 'a citizen in a stable state is never touched').toBe('AtWork');
  });

  it('cleanupDespawnsOverCapacityCitizensHighestIdFirst', () => {
    const w = worldOn(new MapGrid(16, 16));
    const house = home(w, t(5, 5), 5);
    for (let i = 0; i < 5; i++) w.citizens.add(newCitizen(house));

    cleanupHomelessCitizens(w);
    expect(liveIds(w), 'no one leaves a building at its occupancy').toEqual([1, 2, 3, 4, 5]);

    house.occupancyResidents = 2;
    cleanupHomelessCitizens(w);
    expect(liveIds(w), 'the surplus goes, highest ids first').toEqual([1, 2]);

    house.occupancyResidents = 0;
    cleanupHomelessCitizens(w);
    expect(liveIds(w), 'an empty building keeps no residents').toEqual([]);
  });

  it('citizensMoveIntoOpenHomesUpToTheirOccupancyEightATick', () => {
    const w = worldOn(new MapGrid(32, 16));
    const house = home(w, t(2, 2), 12);
    w.buildings.add(newBuilding({ kind: 'Residential', anchor: t(10, 2), occupancyResidents: 5, phase: { kind: 'UnderConstruction', daysRemaining: 1 } }));

    spawnCitizensFromResidential(w);
    expect(w.citizens.all(), 'eight move in on the first tick').toHaveLength(8);
    spawnCitizensFromResidential(w);
    expect(w.citizens.all().filter((c) => c.home === house.id), 'the rest on the next, and no one into a building site').toHaveLength(12);
    expect(w.citizens.all()).toHaveLength(12);
  });

  it('aCitizenWithAJobDrivesToWorkAndBackHome', () => {
    const w = worldOn(new MapGrid(32, 16));
    const house = home(w, t(2, 2));
    const shop = w.buildings.add(newBuilding({ kind: 'Commercial', anchor: t(20, 2), capacityJobs: 5 }));
    const worker = w.citizens.add({ ...newCitizen(house), workplace: shop.id });

    // The decision timer is two seconds; shopping waits for ten.
    citizenTripPlanner(w, 2 * SECOND_NS);
    expect(w.events.tripRequested).toEqual([{ citizen: worker.id, from: house.anchor, carParkedAt: house.anchor, to: shop.anchor, purpose: 'Work', mode: 'Car' }]);
    expect(worker.state).toBe('ToWork');

    w.events = emptyEvents();
    w.events.tripFinished.push({ citizen: worker.id, purpose: 'Work' });
    handleTripFinished(w);
    expect(worker.state).toBe('AtWork');
    expect(worker.carParkedAt, 'the car stays where it was driven').toEqual(shop.anchor);

    w.events = emptyEvents();
    // Past the five-second stay, on the next decision.
    citizenTripPlanner(w, 6 * SECOND_NS);
    expect(w.events.tripRequested).toEqual([{ citizen: worker.id, from: shop.anchor, carParkedAt: shop.anchor, to: house.anchor, purpose: 'ReturnHome', mode: 'Car' }]);

    w.events = emptyEvents();
    w.events.tripFinished.push({ citizen: worker.id, purpose: 'ReturnHome' });
    handleTripFinished(w);
    expect(worker.state).toBe('AtHome');
    expect(worker.carParkedAt).toEqual(house.anchor);
  });

  it('aLateArrivalOfAnAbandonedTripChangesNothing', () => {
    const w = worldOn(new MapGrid(16, 16));
    const worker = w.citizens.add(newCitizen(home(w)));
    w.events.tripFinished.push({ citizen: worker.id, purpose: 'Work' });
    handleTripFinished(w);
    expect(worker.state).toBe('AtHome');
  });

  it('theParkedCarOfACitizenWhoLeftIsRemovedAndOneOnTheRoadWhenItParks', () => {
    const w = worldOn(new MapGrid(16, 16));
    const house = home(w, t(5, 5), 2);
    const [first, second] = [w.citizens.add(newCitizen(house)), w.citizens.add(newCitizen(house))];
    const parked = spawnVehicle(w, { route: [t(0, 0)], carOwner: second.id });
    w.vehicles.parked[refSlot(w.vehicles, parked)] = 1;
    const driving = spawnVehicle(w, { route: [t(1, 0)], carOwner: first.id });

    house.occupancyResidents = 0;
    cleanupHomelessCitizens(w);
    despawnOrphanedOwnedCars(w);
    expect(resolveVehicle(w.vehicles, parked), 'a parked car of a citizen who left goes').toBeUndefined();
    expect(resolveVehicle(w.vehicles, driving), 'a car on the road finishes its leg first').toBeDefined();

    w.vehicles.parked[refSlot(w.vehicles, driving)] = 1;
    despawnOrphanedOwnedCars(w);
    expect(resolveVehicle(w.vehicles, driving), 'and goes once parked').toBeUndefined();
  });
});
