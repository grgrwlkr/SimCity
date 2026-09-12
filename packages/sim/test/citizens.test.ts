// Port of the tests in crates/simcity_sim/src/game/citizens.rs, and of what they left untested: moving in, the day of
// a citizen (TS: work in the morning, home after the shift, shopping in the evening near home, nobody out at night),
// the typed arrays and the minute queue, and how a citizen gets there — on foot or by the car in their pocket (3½b).
import { describe, expect, it } from 'vitest';
import { newBuilding, type Building } from '../src/buildings/building';
import {
  CITIZEN_TRIP_TIMEOUT_SECS,
  NEAREST_SHOPS,
  citizenSlot,
  citizenTripPlanner,
  cleanupHomelessCitizens,
  handleTripFinished,
  newCitizen,
  recoverStuckTrips,
  spawnCitizensFromResidential,
} from '../src/citizens';
import type { TilePos } from '../src/commands';
import { emptyEvents, type TripRequested } from '../src/events';
import { MapGrid } from '../src/map/grid';
import { buildingPlace, giveCar, takeParking } from '../src/parking';
import { spawnVehicle } from '../src/traffic/vehicles';
import { adjacentRoadTowards } from '../src/transport/anchors';
import type { World } from '../src/world';
import { roadRow, t, worldOn } from './buildings/helpers';

function home(w: World, anchor = t(5, 5), occupancy = 5): Building {
  return w.buildings.add(newBuilding({ kind: 'Residential', anchor, capacityResidents: 8, occupancyResidents: occupancy, targetOccupancyResidents: occupancy }));
}

const shopAt = (w: World, x: number, y = 2, jobs = 5) => w.buildings.add(newBuilding({ kind: 'Commercial', anchor: t(x, y), capacityJobs: jobs }));

const view = (w: World, ref: number) => w.citizens.view(ref)!;

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

/** A car trip of `citizen` arriving at `day`, `hh:mm`. */
function arrive(w: World, citizen: number, purpose: 'Work' | 'Shop' | 'ReturnHome', day: number, hour: number, minute = 0): void {
  at(w, day, hour, minute);
  w.events = emptyEvents();
  w.events.tripFinished.push({ citizen, purpose });
  handleTripFinished(w);
}

const inside = (b: Building, p: TilePos) => p.x >= b.anchor.x && p.x < b.anchor.x + b.width && p.y >= b.anchor.y && p.y < b.anchor.y + b.length;

/** A home, a shop and a thousand of its workers starting work a minute apart in tens, 07:00 to 08:39, three minutes' walk away. */
function morningCrowd() {
  const w = worldOn(new MapGrid(32, 16));
  const house = home(w, t(2, 2));
  const shop = shopAt(w, 20);
  for (let i = 0; i < 1000; i++) w.citizens.add({ ...newCitizen(house, { workStart: 7 * 60 + (i % 100) }), workplace: shop.id });
  return w;
}

/** A town two kilometres long: a home at its west end, a worker starting at seven at `workplace`. */
function commuter(width: number, workplaceX: number, options: { car?: boolean; jobs?: number } = {}) {
  const w = worldOn(new MapGrid(width, 16));
  const house = home(w, t(2, 2));
  const work = shopAt(w, workplaceX, 2, options.jobs ?? 5);
  const worker = w.citizens.add({ ...newCitizen(house, { workStart: 7 * 60 }), workplace: work.id });
  if (options.car === true) expect(giveCar(w, worker), 'the car parks at home').toBe(true);
  return { w, house, work, worker };
}

describe('citizens', () => {
  it('recoverStuckTripsRevertsOrphanedButKeepsInProgressAndStable', () => {
    const w = worldOn(new MapGrid(16, 16));
    const house = home(w, t(1, 1));
    const shop = shopAt(w, 9, 9);
    const trip = { lastPlace: t(5, 5), tourMode: 'Car', carStatus: 'Driving', carPlace: buildingPlace(shop.id) } as const;
    takeParking(w, trip.carPlace);
    // Departed far past the timeout, at a clock near zero.
    const stuck = w.citizens.add({ ...newCitizen(house), ...trip, state: 'ToShop', tripDepartedAtSec: -(CITIZEN_TRIP_TIMEOUT_SECS + 50), tripPurpose: 'Shop' });
    const fresh = w.citizens.add({ ...newCitizen(house), state: 'ToWork', tripDepartedAtSec: -1, tripPurpose: 'Work' });
    const stable = w.citizens.add({ ...newCitizen(house), state: 'AtWork', tripDepartedAtSec: -(CITIZEN_TRIP_TIMEOUT_SECS + 50), tripPurpose: 'Work' });

    recoverStuckTrips(w);

    expect(view(w, stuck).state, 'an orphaned citizen in transit goes back home').toBe('AtHome');
    expect(view(w, stuck), 'the car stands where it was going').toMatchObject({ carStatus: 'Parked', carPlace: buildingPlace(shop.id) });
    expect(view(w, fresh).state, 'a trip within the timeout is left alone').toBe('ToWork');
    expect(view(w, stable).state, 'a citizen in a stable state is never touched').toBe('AtWork');
  });

  // TS: only a citizen whose trip has no car on the road, no place in the backlog and no walk under way is orphaned; Rust
  // took every trip past the timeout, and a long trip in a jam sent its driver home while the car drove on.
  it('aCitizenWhoseCarIsStillOnTheRoadIsNotSentHome', () => {
    const w = worldOn(new MapGrid(16, 16));
    const house = home(w, t(1, 1));
    const departed = -(CITIZEN_TRIP_TIMEOUT_SECS + 50);
    const driving = w.citizens.add({ ...newCitizen(house), state: 'ToWork', tripDepartedAtSec: departed, tripPurpose: 'Work' });
    const waiting = w.citizens.add({ ...newCitizen(house), state: 'ToShop', tripDepartedAtSec: departed, tripPurpose: 'Shop' });
    const walking = w.citizens.add({ ...newCitizen(house), state: 'ToShop', tripDepartedAtSec: departed, tripPurpose: 'Shop', nextAt: 900, nextPurpose: 'Shop' });
    spawnVehicle(w, { route: [t(0, 0)], passenger: { citizen: driving, purpose: 'Work' } });
    w.tripBacklog.push({ citizen: waiting, from: t(1, 1), carParkedAt: t(1, 1), to: t(9, 9), purpose: 'Shop', mode: 'Car', pocket: true });

    recoverStuckTrips(w);

    expect(view(w, driving).state, 'a long trip in a jam is still a trip').toBe('ToWork');
    expect(view(w, waiting).state, 'and so is one waiting for its car').toBe('ToShop');
    expect(view(w, walking).state, 'and a long walk').toBe('ToShop');
  });

  it('cleanupSendsTheSurplusAwayTheLastToMoveInFirst', () => {
    const w = worldOn(new MapGrid(16, 16));
    const house = home(w, t(5, 5), 5);
    const residents = Array.from({ length: 5 }, () => w.citizens.add(newCitizen(house)));

    cleanupHomelessCitizens(w);
    expect(w.citizens.refs(), 'no one leaves a building at its occupancy').toEqual(residents);

    house.occupancyResidents = 2;
    cleanupHomelessCitizens(w);
    expect(w.citizens.refs(), 'the surplus goes, the last to move in first').toEqual(residents.slice(0, 2));

    // A newcomer takes a freed slot and is still the last to have moved in.
    house.occupancyResidents = 3;
    w.citizens.add(newCitizen(house));
    house.occupancyResidents = 2;
    cleanupHomelessCitizens(w);
    expect(w.citizens.refs()).toEqual(residents.slice(0, 2));

    house.occupancyResidents = 0;
    cleanupHomelessCitizens(w);
    expect(w.citizens.refs(), 'an empty building keeps no residents').toEqual([]);
    expect(w.citizens.residentsOf(house.id)).toBe(0);
  });

  it('aStaleCitizenRefResolvesToNothing', () => {
    const w = worldOn(new MapGrid(16, 16));
    const house = home(w, t(5, 5), 2);
    const first = w.citizens.add(newCitizen(house));
    const second = w.citizens.add(newCitizen(house));

    w.citizens.remove(first);
    expect(w.citizens.resolve(first), 'a citizen who left resolves to nothing').toBeUndefined();
    expect(w.citizens.view(first)).toBeUndefined();

    const newcomer = w.citizens.add(newCitizen(house));
    expect(citizenSlot(newcomer), 'the newcomer takes the freed slot').toBe(citizenSlot(first));
    expect(newcomer, 'under a new generation').not.toBe(first);
    expect(w.citizens.resolve(first), 'and the old reference still resolves to nothing').toBeUndefined();
    expect(w.citizens.refs(), 'citizens go in slot order').toEqual([newcomer, second]);
    expect(w.citizens.count).toBe(2);
  });

  it('citizensMoveIntoOpenHomesUpToTheirOccupancyEightATick', () => {
    const w = worldOn(new MapGrid(32, 16));
    const house = home(w, t(2, 2), 12);
    w.buildings.add(newBuilding({ kind: 'Residential', anchor: t(10, 2), occupancyResidents: 5, phase: { kind: 'UnderConstruction', hoursRemaining: 1 } }));

    spawnCitizensFromResidential(w);
    expect(w.citizens.count, 'eight move in on the first tick').toBe(8);
    spawnCitizensFromResidential(w);
    expect(w.citizens.residentsOf(house.id), 'the rest on the next, and no one into a building site').toBe(12);
    expect(w.citizens.count).toBe(12);
    const starts = w.citizens.refs().map((ref) => view(w, ref).workStart);
    expect(starts.every((m) => m >= 6 * 60 && m < 9 * 60), `everyone starts work between 06:00 and 09:00: ${starts.join(' ')}`).toBe(true);
    expect(new Set(starts).size, 'and not all at once').toBeGreaterThan(1);
  });

  it('aWorkerDrivesToWorkInTheMorningAndHomeAfterTheShift', () => {
    const { w, house, work, worker } = commuter(200, 150, { car: true });

    expect(planAt(w, 1, 6), 'at six the worker is still at home').toEqual([]);
    // 1.48 km at 40 km/h with no road network measured: 133 s, three minutes before seven.
    expect(planAt(w, 1, 6, 56), 'not yet a minute early').toEqual([]);
    expect(planAt(w, 1, 6, 57), 'and drives the kilometre and a half to start at seven').toEqual([
      { citizen: worker, from: house.anchor, carParkedAt: house.anchor, to: work.anchor, purpose: 'Work', mode: 'Car', pocket: true },
    ]);
    expect(view(w, worker)).toMatchObject({ state: 'ToWork', carStatus: 'Driving', carPlace: buildingPlace(work.id) });
    expect([w.parking.usedAt(buildingPlace(house.id)), w.parking.usedAt(buildingPlace(work.id))], 'the car left its spot at home and holds one at work').toEqual([0, 1]);

    arrive(w, worker, 'Work', 1, 7, 40);
    expect(view(w, worker), 'parked at work').toMatchObject({ state: 'AtWork', carStatus: 'Parked', carParkedAt: work.anchor });
    expect(planAt(w, 1, 15, 39), 'eight hours after arriving the shift is not over a minute early').toEqual([]);
    expect(planAt(w, 1, 15, 40), 'and ends on the minute').toEqual([
      { citizen: worker, from: work.anchor, carParkedAt: work.anchor, to: house.anchor, purpose: 'ReturnHome', mode: 'Car', pocket: true },
    ]);

    arrive(w, worker, 'ReturnHome', 1, 16, 20);
    expect(view(w, worker)).toMatchObject({ state: 'AtHome', carStatus: 'Parked', carPlace: buildingPlace(house.id), carParkedAt: house.anchor });
  });

  it('aCitizenWithoutACarWalks', () => {
    const { w, worker } = commuter(200, 150);
    // 1.48 km at 5 km/h: eighteen minutes before seven.
    expect(planAt(w, 1, 6, 42), 'a kilometre and a half on foot').toMatchObject([{ citizen: worker, mode: 'Walk', carParkedAt: null, purpose: 'Work' }]);
  });

  it('aShortTripIsWalked', () => {
    const { w, house, worker } = commuter(32, 20, { car: true });
    expect(planAt(w, 1, 6, 57), 'two hundred metres are walked').toMatchObject([{ citizen: worker, mode: 'Walk', carParkedAt: null }]);
    expect(view(w, worker), 'and the car stays at home').toMatchObject({ carStatus: 'Parked', carPlace: buildingPlace(house.id) });
  });

  it('aTripWithoutParkingInReachIsWalked', () => {
    const w = worldOn(new MapGrid(400, 16));
    const house = home(w, t(2, 2));
    const nearShop = shopAt(w, 150, 2, 0);
    const farShop = shopAt(w, 360, 2, 0);
    // The only spots out of town: 800 m from the near shop, 1.3 km from the far one.
    const lot = w.buildings.add(newBuilding({ kind: 'Industrial', anchor: t(230, 2), parkingGarage: 5 }));
    const toNear = w.citizens.add({ ...newCitizen(house, { workStart: 7 * 60 }), workplace: nearShop.id });
    const toFar = w.citizens.add({ ...newCitizen(house, { workStart: 7 * 60 }), workplace: farShop.id });
    giveCar(w, toNear);
    giveCar(w, toFar);

    planAt(w, 1, 6);
    const trips = planAt(w, 1, 7);
    expect(trips.find((trip) => trip.citizen === toNear), 'no spot within 400 m of a shop 1.5 km away: on foot').toMatchObject({ mode: 'Walk' });
    expect(trips.find((trip) => trip.citizen === toFar), 'past three kilometres the car goes to the nearest spot farther away').toMatchObject({ mode: 'Car', pocket: true });
    expect(view(w, toFar).carPlace).toBe(buildingPlace(lot.id));
  });

  it('aWalkArrivesAfterDistanceOverWalkingSpeed', () => {
    const { w, worker } = commuter(32, 20);
    // 18 tiles, 180 m at 5 km/h: 2.16 minutes, so the walk leaves at 6:57 and arrives on the third.
    planAt(w, 1, 6, 57);
    expect(planAt(w, 1, 6, 59)).toEqual([]);
    expect(view(w, worker).state, 'still walking after two minutes').toBe('ToWork');
    planAt(w, 1, 7);
    expect(view(w, worker), 'at work at seven, the shift counted from then').toMatchObject({ state: 'AtWork', nextAt: 7 * 60 + 8 * 60 });
  });

  it('aLongerCommuteLeavesEarlier', () => {
    const w = worldOn(new MapGrid(96, 16));
    const house = home(w, t(2, 2));
    const toNear = w.citizens.add({ ...newCitizen(house, { workStart: 8 * 60 }), workplace: shopAt(w, 20).id });
    const toFar = w.citizens.add({ ...newCitizen(house, { workStart: 8 * 60 }), workplace: shopAt(w, 80).id });
    planAt(w, 1, 6);
    // Both start at eight, on foot at 5 km/h: 780 m take ten minutes, 180 m three.
    expect(planAt(w, 1, 7, 49)).toEqual([]);
    expect(planAt(w, 1, 7, 50).map((trip) => trip.citizen)).toEqual([toFar]);
    expect(planAt(w, 1, 7, 57).map((trip) => trip.citizen)).toEqual([toNear]);
  });

  it('aWorkerAtHomeAtNightStaysHomeUntilTheirMorning', () => {
    const w = worldOn(new MapGrid(32, 16));
    const house = home(w, t(2, 2));
    const shop = shopAt(w, 20);
    w.citizens.add({ ...newCitizen(house, { workStart: 7 * 60 }), workplace: shop.id });

    const night: TripRequested[] = [];
    for (let minute = 23 * 60; minute < (24 + 7) * 60; minute += 30) {
      night.push(...planAt(w, 1 + Math.floor(minute / (24 * 60)), Math.floor(minute / 60) % 24, minute % 60));
    }
    expect(night, 'nobody sets out between eleven at night and seven').toEqual([]);
    expect(planAt(w, 2, 7).map((trip) => trip.purpose)).toEqual(['Work']);
  });

  it('thePlannerWakesOnlyCitizensWhoseMinuteHasCome', () => {
    const w = morningCrowd();
    planAt(w, 1, 6);
    planAt(w, 1, 6, 59);

    expect(planAt(w, 1, 7), 'ten of a thousand set out at seven').toHaveLength(10);
    expect(w.citizens.plannerWoken, 'and the ten who set out three minutes ago arrive: only they are looked at').toBe(20);
    expect(planAt(w, 1, 7, 1)).toHaveLength(10);
    expect(w.citizens.plannerWoken).toBe(20);
  });

  it('missedMinutesAreCaughtUpInOrder', () => {
    const w = morningCrowd();
    planAt(w, 1, 6);

    const trips = planAt(w, 1, 7, 30);
    const starts = trips.map((trip) => view(w, trip.citizen).workStart);
    expect(trips, 'the planner skipped from six to half past seven: the departures of 6:57 to 7:30').toHaveLength(340);
    expect(starts, 'in the order of their minutes').toEqual([...starts].sort((a, b) => a - b));
    expect([starts[0], starts.at(-1)]).toEqual([7 * 60, 7 * 60 + 33]);
    expect(view(w, trips[0]!.citizen).state, 'the walk that left at 6:57 ended on the way').toBe('AtWork');
  });

  // TS: a shopper goes to one of the shops nearest home, and only in the evening after work; Rust sent them to any shop
  // in town every nine to eighteen seconds.
  it('workersShopInTheEveningAtAShopNearHome', () => {
    const w = worldOn(new MapGrid(64, 16));
    const west = home(w, t(2, 2), 8);
    const east = home(w, t(50, 2), 8);
    const shops = [8, 14, 20, 26, 32, 38, 44, 56].map((x) => shopAt(w, x, 8));
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
      const from = view(w, trip.citizen).home === west.id ? west : east;
      const nearest = [...shops].sort((a, b) => Math.abs(a.anchor.x - from.anchor.x) - Math.abs(b.anchor.x - from.anchor.x)).slice(0, NEAREST_SHOPS);
      expect(nearest.some((shop) => inside(shop, trip.to)), `a shop near (${from.anchor.x},${from.anchor.y}), not (${trip.to.x},${trip.to.y})`).toBe(true);
    }
  });

  // TS: a trip starts and parks beside the road on the side the footprint has one; Rust used the anchor, so the trips
  // of every building whose anchor corner faced away from its road were dropped by the vehicle spawn.
  it('aCitizenWhoseHomeAnchorIsAwayFromTheRoadLeavesFromTheSideOnIt', () => {
    const grid = new MapGrid(160, 30);
    roadRow(grid, 19, 10, 159);
    const w = worldOn(grid);
    // Rows 16..18 above the road: the anchor corner is two rows from it.
    const house = home(w, t(16, 16), 1);
    const shop = shopAt(w, 150, 20);
    const worker = w.citizens.add({ ...newCitizen(house, { workStart: 7 * 60 }), workplace: shop.id });
    giveCar(w, worker);

    // 1.34 km by car, measured as the crow flies without a road network: three minutes before seven.
    const trip = planAt(w, 1, 6, 57)[0]!;

    expect(trip).toMatchObject({ citizen: worker, mode: 'Car' });
    expect(inside(house, trip.from) && inside(house, trip.carParkedAt!), 'the trip leaves from the home').toBe(true);
    expect(adjacentRoadTowards(w.grid, trip.carParkedAt!, trip.to), 'from a tile beside the road').toBeDefined();
    expect(inside(shop, trip.to), 'to the workplace').toBe(true);
    expect(adjacentRoadTowards(w.grid, trip.to, trip.from), 'and parks beside the road there').toBeDefined();
  });

  it('aLateArrivalOfAnAbandonedTripChangesNothing', () => {
    const w = worldOn(new MapGrid(16, 16));
    const worker = w.citizens.add(newCitizen(home(w)));
    arrive(w, worker, 'Work', 1, 9);
    expect(view(w, worker).state).toBe('AtHome');
  });
});
