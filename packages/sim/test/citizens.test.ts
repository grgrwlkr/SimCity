// Port of the tests in crates/simcity_sim/src/game/citizens.rs, and of what they left untested: moving in, the day of
// a citizen (TS: work in the morning, home after the shift, shopping in the evening near home, nobody out at night),
// and the cars of citizens who left.
import { describe, expect, it } from 'vitest';
import { newBuilding, type Building } from '../src/buildings/building';
import {
  CITIZEN_TRIP_TIMEOUT_SECS,
  NEAREST_SHOPS,
  citizenTripPlanner,
  cleanupHomelessCitizens,
  despawnOrphanedOwnedCars,
  handleTripFinished,
  newCitizen,
  recoverStuckTrips,
  spawnCitizensFromResidential,
} from '../src/citizens';
import type { TilePos } from '../src/commands';
import { emptyEvents, type TripRequested } from '../src/events';
import { MapGrid } from '../src/map/grid';
import { refSlot, resolveVehicle, spawnVehicle } from '../src/traffic/vehicles';
import { adjacentRoadTowards } from '../src/transport/anchors';
import type { World } from '../src/world';
import { roadRow, t, worldOn } from './buildings/helpers';

function home(w: World, anchor = t(5, 5), occupancy = 5): Building {
  return w.buildings.add(newBuilding({ kind: 'Residential', anchor, capacityResidents: 8, occupancyResidents: occupancy, targetOccupancyResidents: occupancy }));
}

const liveIds = (w: World) => w.citizens.all().map((c) => c.id);

/** Sets the clock to `day`, `hh:mm`. */
function at(w: World, day: number, hour: number, minute = 0): void {
  w.city.day = day;
  w.city.hour = hour;
  w.city.minute = minute;
}

/** The planner at `day`, `hh:mm`; the trips it requested. */
function planAt(w: World, day: number, hour: number, minute = 0): TripRequested[] {
  at(w, day, hour, minute);
  w.events = emptyEvents();
  citizenTripPlanner(w);
  return [...w.events.tripRequested];
}

/** A trip of `citizen` arriving at `day`, `hh:mm`. */
function arrive(w: World, citizen: number, purpose: 'Work' | 'Shop' | 'ReturnHome', day: number, hour: number, minute = 0): void {
  at(w, day, hour, minute);
  w.events = emptyEvents();
  w.events.tripFinished.push({ citizen, purpose });
  handleTripFinished(w);
}

const inside = (b: Building, p: TilePos) => p.x >= b.anchor.x && p.x < b.anchor.x + b.width && p.y >= b.anchor.y && p.y < b.anchor.y + b.length;

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

  // TS: only a citizen whose trip has no car on the road and no place in the backlog is orphaned; Rust took every trip
  // past the timeout, and a long trip in a jam sent its driver home while the car drove on.
  it('aCitizenWhoseCarIsStillOnTheRoadIsNotSentHome', () => {
    const w = worldOn(new MapGrid(16, 16));
    const house = home(w, t(1, 1));
    const departed = -(CITIZEN_TRIP_TIMEOUT_SECS + 50);
    const driving = w.citizens.add({ ...newCitizen(house), state: 'ToWork', tripDepartedAtSec: departed, tripPurpose: 'Work' });
    const waiting = w.citizens.add({ ...newCitizen(house), state: 'ToShop', tripDepartedAtSec: departed, tripPurpose: 'Shop' });
    spawnVehicle(w, { route: [t(0, 0)], passenger: { citizen: driving.id, purpose: 'Work' }, carOwner: driving.id });
    w.tripBacklog.push({ citizen: waiting.id, from: t(1, 1), carParkedAt: t(1, 1), to: t(9, 9), purpose: 'Shop', mode: 'Car' });

    recoverStuckTrips(w);

    expect(driving.state, 'a long trip in a jam is still a trip').toBe('ToWork');
    expect(waiting.state, 'and so is one waiting for its car').toBe('ToShop');
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
    const departures = w.citizens.all().map((c) => c.workDeparture);
    expect(departures.every((m) => m >= 6 * 60 && m < 9 * 60), `everyone leaves for work between 06:00 and 09:00: ${departures.join(' ')}`).toBe(true);
    expect(new Set(departures).size, 'and not all at once').toBeGreaterThan(1);
  });

  it('aWorkerLeavesInTheMorningAndComesHomeAfterTheShift', () => {
    const w = worldOn(new MapGrid(32, 16));
    const house = home(w, t(2, 2));
    const shop = w.buildings.add(newBuilding({ kind: 'Commercial', anchor: t(20, 2), capacityJobs: 5 }));
    const worker = w.citizens.add({ ...newCitizen(house, { workDeparture: 7 * 60 + 30, shiftMinutes: 8 * 60 }), workplace: shop.id });

    expect(planAt(w, 1, 6), 'at six the worker is still at home').toEqual([]);
    expect(planAt(w, 1, 7, 30), 'and leaves at half past seven').toEqual([
      { citizen: worker.id, from: house.anchor, carParkedAt: house.anchor, to: shop.anchor, purpose: 'Work', mode: 'Car' },
    ]);
    expect(worker.state).toBe('ToWork');

    arrive(w, worker.id, 'Work', 1, 8, 10);
    expect(worker.state).toBe('AtWork');
    expect(worker.carParkedAt, 'the car stays where it was driven').toEqual(shop.anchor);
    expect(planAt(w, 1, 16, 9), 'eight hours after arriving the shift is not over a minute early').toEqual([]);
    expect(planAt(w, 1, 16, 10), 'and ends on the minute').toEqual([
      { citizen: worker.id, from: shop.anchor, carParkedAt: shop.anchor, to: house.anchor, purpose: 'ReturnHome', mode: 'Car' },
    ]);

    arrive(w, worker.id, 'ReturnHome', 1, 16, 40);
    expect(worker.state).toBe('AtHome');
    expect(worker.carParkedAt).toEqual(house.anchor);
  });

  it('aWorkerAtHomeAtNightStaysHomeUntilTheirMorning', () => {
    const w = worldOn(new MapGrid(32, 16));
    const house = home(w, t(2, 2));
    const shop = w.buildings.add(newBuilding({ kind: 'Commercial', anchor: t(20, 2), capacityJobs: 5 }));
    w.citizens.add({ ...newCitizen(house, { workDeparture: 7 * 60 }), workplace: shop.id });

    const night: TripRequested[] = [];
    for (let minute = 23 * 60; minute < (24 + 7) * 60; minute += 30) {
      night.push(...planAt(w, 1 + Math.floor(minute / (24 * 60)), Math.floor(minute / 60) % 24, minute % 60));
    }
    expect(night, 'nobody sets out between eleven at night and seven').toEqual([]);
    expect(planAt(w, 2, 7).map((trip) => trip.purpose)).toEqual(['Work']);
  });

  // TS: a shopper goes to one of the shops nearest home, and only in the evening after work; Rust sent them to any shop
  // in town every nine to eighteen seconds.
  it('workersShopInTheEveningAtAShopNearHome', () => {
    const w = worldOn(new MapGrid(64, 16));
    const west = home(w, t(2, 2), 8);
    const east = home(w, t(50, 2), 8);
    const shops = [8, 14, 20, 26, 32, 38, 44, 56].map((x) => w.buildings.add(newBuilding({ kind: 'Commercial', anchor: t(x, 8), capacityJobs: 5 })));
    const workers = Array.from({ length: 120 }, (_, i) => w.citizens.add({ ...newCitizen(i % 2 === 0 ? west : east), workplace: shops[0]!.id }));

    const trips: Array<readonly [minute: number, trip: TripRequested]> = [];
    for (let minute = 12 * 60; minute < 21 * 60; minute += 5) {
      for (const trip of planAt(w, 1, Math.floor(minute / 60), minute % 60)) trips.push([minute, trip]);
    }

    const shopping = trips.filter(([, trip]) => trip.purpose === 'Shop');
    expect(shopping.length, 'some go shopping').toBeGreaterThan(10);
    expect(shopping.length, 'most do not').toBeLessThan(workers.length / 2);
    expect(shopping.every(([minute]) => minute >= 17 * 60 && minute < 20 * 60), 'between five and eight in the evening').toBe(true);
    for (const [, trip] of shopping) {
      const from = w.citizens.get(trip.citizen)!.home === west.id ? west : east;
      const nearest = [...shops].sort((a, b) => Math.abs(a.anchor.x - from.anchor.x) - Math.abs(b.anchor.x - from.anchor.x)).slice(0, NEAREST_SHOPS);
      expect(nearest.some((shop) => inside(shop, trip.to)), `a shop near (${from.anchor.x},${from.anchor.y}), not (${trip.to.x},${trip.to.y})`).toBe(true);
    }
  });

  // TS: a trip starts and parks beside the road on the side the footprint has one; Rust used the anchor, so the trips
  // of every building whose anchor corner faced away from its road were dropped by the vehicle spawn.
  it('aCitizenWhoseHomeAnchorIsAwayFromTheRoadLeavesFromTheSideOnIt', () => {
    const grid = new MapGrid(40, 30);
    roadRow(grid, 19, 10, 39);
    const w = worldOn(grid);
    // Rows 16..18 above the road: the anchor corner is two rows from it.
    const house = home(w, t(16, 16), 1);
    const shop = w.buildings.add(newBuilding({ kind: 'Commercial', anchor: t(30, 20), capacityJobs: 5 }));
    const worker = w.citizens.add({ ...newCitizen(house, { workDeparture: 7 * 60 }), workplace: shop.id });

    const trip = planAt(w, 1, 7)[0]!;

    expect(trip.citizen).toBe(worker.id);
    expect(inside(house, trip.from) && inside(house, trip.carParkedAt!), 'the trip leaves from the home').toBe(true);
    expect(adjacentRoadTowards(w.grid, trip.carParkedAt!, trip.to), 'from a tile beside the road').toBeDefined();
    expect(inside(shop, trip.to), 'to the workplace').toBe(true);
    expect(adjacentRoadTowards(w.grid, trip.to, trip.from), 'and parks beside the road there').toBeDefined();
  });

  it('aLateArrivalOfAnAbandonedTripChangesNothing', () => {
    const w = worldOn(new MapGrid(16, 16));
    const worker = w.citizens.add(newCitizen(home(w)));
    arrive(w, worker.id, 'Work', 1, 9);
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
