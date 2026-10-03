import {
  buyHouseholdGoods,
  gameDay,
  gameMinute,
  recordFamilyFinance,
} from './economy';
import {LIFE_RULES} from './rules';
import type {
  LifeRegion,
  MutableRegion,
  RegionalBuilding,
  RegionalFamily,
  RegionalPerson,
  RegionalRoute,
  RegionalTrip,
  RegionMobilityPort,
  TripPurpose,
} from './types';

const peopleIndices = new WeakMap<
  RegionalPerson[],
  Map<string, RegionalPerson>
>();

function peopleById(state: LifeRegion): Map<string, RegionalPerson> {
  let index = peopleIndices.get(state.life.people);

  if (!index || index.size !== state.life.people.length) {
    index = new Map(state.life.people.map(person => [person.id, person]));
    peopleIndices.set(state.life.people, index);
  }

  return index;
}

export function regionalPopulation(
  state: LifeRegion,
  settlementId?: string,
): number {
  const homes = new Map(
    state.life.buildings.map(building => [building.id, building]),
  );

  return state.life.families.reduce(
    (population, family) =>
      population +
      (family.status === 'settled' &&
      (!settlementId ||
        homes.get(family.homeId ?? '')?.settlementId === settlementId)
        ? family.memberIds.length
        : 0),
    0,
  );
}

function adults(state: LifeRegion, family: RegionalFamily): RegionalPerson[] {
  const people = peopleById(state);

  return family.memberIds
    .map(id => people.get(id)!)
    .filter(
      person =>
        person.age >= LIFE_RULES.workerAge &&
        person.age < LIFE_RULES.retirementAge,
    );
}

function reachable(
  mobility: RegionMobilityPort,
  from: string,
  to: string,
): RegionalRoute | null {
  return mobility.route(from, to, 'walk') ?? mobility.route(from, to, 'car');
}

function bindTrip(state: MutableRegion, trip: RegionalTrip): void {
  const people = peopleById(state);

  for (const id of [trip.actorId, ...trip.passengerIds]) {
    const person = people.get(id);

    if (person) {
      person.tripId = trip.id;
      person.placeId = null;
      person.reason = null;
    }
  }

  updateResidentActivities(state);
}

export function updateResidentActivities(state: MutableRegion): void {
  const people = peopleById(state);

  for (const trip of state.life.trips) {
    const person = people.get(trip.actorId);

    if (person) {
      person.activity =
        trip.mode === 'walk' || trip.phase !== 'travel' ? 'walking' : 'driving';
    }

    for (const id of trip.passengerIds) {
      const passenger = people.get(id);

      if (passenger) {
        passenger.activity = 'passenger';
      }
    }
  }
}

function assignJobs(
  state: MutableRegion,
  family: RegionalFamily,
  mobility: RegionMobilityPort,
  vacancies: Map<string, number>,
): void {
  if (!family.homeId) {
    return;
  }

  for (const person of adults(state, family)) {
    if (person.jobId) {
      continue;
    }

    const choices: Array<{building: RegionalBuilding; length: number}> = [];

    for (const building of state.life.buildings) {
      if (
        building.stage !== 'ready' ||
        building.qualification > person.qualification ||
        (vacancies.get(building.id) ?? 0) <= 0
      ) {
        continue;
      }

      const path = reachable(mobility, family.homeId, building.id);

      if (
        path &&
        path.lane.length / LIFE_RULES.walkMetersPerMinute <=
          LIFE_RULES.maximumCommuteMinutes
      ) {
        choices.push({building, length: path.lane.length});
      }
    }

    choices.sort(
      (a, b) =>
        a.length - b.length || a.building.id.localeCompare(b.building.id, 'en'),
    );
    const chosen = choices[0]?.building;

    if (chosen) {
      person.jobId = chosen.id;
      person.reason = null;
      vacancies.set(chosen.id, (vacancies.get(chosen.id) ?? 0) - 1);
    } else {
      person.reason = 'no-job';
    }
  }
}

function arrive(
  state: MutableRegion,
  family: RegionalFamily,
  mobility: RegionMobilityPort,
): void {
  const home = state.life.buildings.find(
    building => building.id === family.homeId,
  );

  if (!home || home.stage !== 'ready') {
    family.reason = home ? 'waiting-construction' : 'waiting-home';

    return;
  }

  const driver = adults(state, family).find(person => person.jobId !== null);

  if (!driver) {
    family.reason = 'no-job';

    return;
  }

  const car = state.life.cars.find(candidate => candidate.id === family.carId);
  const entries = state.externalEntries
    .filter(entry => !car || car.parkedAt === entry.id)
    .map(entry => ({entry, route: mobility.route(entry.id, home.id, 'car')}))
    .filter(candidate => candidate.route !== null);

  entries.sort(
    (a, b) =>
      a.route!.lane.length - b.route!.lane.length ||
      a.entry.id.localeCompare(b.entry.id, 'en'),
  );
  const candidate = entries[0];

  if (!candidate) {
    family.reason = 'no-external-route';

    return;
  }

  const fuel = Math.max(1, Math.ceil(candidate.route!.lane.length / 1000)) * 2;

  if (family.cash < fuel) {
    family.reason = 'insufficient-funds';

    return;
  }

  const vehicle = car ?? mobility.createCar(family.id, candidate.entry.id);

  if (!vehicle) {
    family.reason = 'arrival-queue';

    return;
  }

  const trip = mobility.start({
    actorId: driver.id,
    passengerIds: family.memberIds.filter(id => id !== driver.id),
    vehicleId: vehicle.id,
    fromId: candidate.entry.id,
    toId: home.id,
    mode: 'car',
    purpose: 'arrival',
  });

  if (!trip) {
    family.reason = 'arrival-queue';

    return;
  }

  family.cash -= fuel;
  recordFamilyFinance(state, family, 'travel', fuel);
  state.life.economy.externalMoney += fuel;
  family.status = 'arriving';
  family.reason = null;
  bindTrip(state, trip);
}

function startPersonTrip(
  state: MutableRegion,
  person: RegionalPerson,
  family: RegionalFamily,
  destination: string,
  purpose: TripPurpose,
  mobility: RegionMobilityPort,
): boolean {
  if (!person.placeId || person.tripId || person.placeId === destination) {
    return false;
  }

  const car = state.life.cars.find(candidate => candidate.id === family.carId);
  const carRoute =
    car?.parkedAt === person.placeId &&
    car.tripId === null &&
    car.driverId === null
      ? mobility.route(person.placeId, destination, 'car')
      : null;
  const fuel = carRoute
    ? Math.max(1, Math.ceil(carRoute.lane.length / 1000)) * 2
    : 0;
  const request = {
    actorId: person.id,
    fromId: person.placeId,
    toId: destination,
    purpose,
  };
  let trip: RegionalTrip | null = null;

  if (car && carRoute && family.cash >= fuel) {
    trip = mobility.start({...request, mode: 'car', vehicleId: car.id});

    if (trip) {
      family.cash -= fuel;
      recordFamilyFinance(state, family, 'travel', fuel);
      state.life.economy.externalMoney += fuel;
    }
  }
  if (!trip) {
    trip = mobility.start({...request, mode: 'walk'});
  }
  if (!trip) {
    person.reason = 'no-route';

    return false;
  }

  bindTrip(state, trip);

  return true;
}

function shoppingDestination(
  state: LifeRegion,
  person: RegionalPerson,
  mobility: RegionMobilityPort,
): string | null {
  if (!person.placeId) {
    return null;
  }

  const candidates: Array<{id: string; length: number}> = [];

  for (const building of state.life.buildings) {
    if (
      building.stage !== 'ready' ||
      building.kind !== 'commercial' ||
      building.inventory === 0
    ) {
      continue;
    }

    const path = reachable(mobility, person.placeId, building.id);

    if (path) {
      candidates.push({id: building.id, length: path.lane.length});
    }
  }

  candidates.sort(
    (a, b) => a.length - b.length || a.id.localeCompare(b.id, 'en'),
  );

  return candidates[0]?.id ?? null;
}

export function stepResidents(
  state: MutableRegion,
  mobility: RegionMobilityPort,
): void {
  if (
    !state.life.initialized ||
    state.life.elapsedSeconds % LIFE_RULES.secondsPerMinute !== 0
  ) {
    return;
  }

  const vacancies = new Map(
    state.life.buildings
      .filter(b => b.stage === 'ready')
      .map(b => [b.id, b.jobs]),
  );

  for (const person of state.life.people) {
    if (person.jobId) {
      vacancies.set(person.jobId, (vacancies.get(person.jobId) ?? 0) - 1);
    }
  }

  const minute = gameMinute(state) % 1440;
  const day = gameDay(state);
  const weekday = day % 7 < 5;

  for (const family of state.life.families) {
    if (
      family.availableAt > state.life.elapsedSeconds ||
      family.status === 'arriving'
    ) {
      continue;
    }

    assignJobs(state, family, mobility, vacancies);

    if (family.status === 'waiting') {
      arrive(state, family, mobility);
      continue;
    }

    const householdAdults = adults(state, family);
    const shopper = householdAdults[0];

    for (const person of householdAdults) {
      if (person.tripId || !person.placeId || !family.homeId) {
        continue;
      }
      if (
        person.placeId === person.jobId &&
        weekday &&
        minute < LIFE_RULES.workEndMinute
      ) {
        person.activity =
          minute >= LIFE_RULES.workStartMinute ? 'work' : 'waiting';
        person.reason =
          minute >= LIFE_RULES.workStartMinute ? null : 'waiting-shift';
        continue;
      }
      if (person.activity === 'work') {
        person.activity = 'waiting';
      }
      if (
        person.jobId &&
        weekday &&
        minute < LIFE_RULES.workEndMinute &&
        minute >= LIFE_RULES.workStartMinute - LIFE_RULES.maximumCommuteMinutes
      ) {
        const route = reachable(mobility, person.placeId, person.jobId);
        const travelMinutes = route
          ? route.lane.length / LIFE_RULES.walkMetersPerMinute
          : LIFE_RULES.maximumCommuteMinutes;

        if (minute >= LIFE_RULES.workStartMinute - travelMinutes) {
          startPersonTrip(
            state,
            person,
            family,
            person.jobId,
            'work',
            mobility,
          );
          continue;
        }
      }

      const shoppingTime = weekday
        ? minute >= LIFE_RULES.workEndMinute
        : minute >= 600;
      const familyShopping = state.life.trips.some(
        trip =>
          trip.purpose === 'shop' && family.memberIds.includes(trip.actorId),
      );

      if (
        person === shopper &&
        shoppingTime &&
        minute < 1260 &&
        family.goods < family.memberIds.length &&
        family.lastShopDay !== day &&
        !familyShopping
      ) {
        const shop = shoppingDestination(state, person, mobility);

        if (
          shop &&
          family.cash >= LIFE_RULES.retailPrice &&
          startPersonTrip(state, person, family, shop, 'shop', mobility)
        ) {
          continue;
        }

        family.reason =
          family.cash < LIFE_RULES.retailPrice
            ? 'insufficient-funds'
            : 'no-goods';
      }
      if (person.placeId !== family.homeId) {
        startPersonTrip(state, person, family, family.homeId, 'home', mobility);
      } else {
        person.activity = 'home';
      }
    }
  }
}

export function completeResidentTrip(
  state: MutableRegion,
  trip: RegionalTrip,
): void {
  const people = peopleById(state);
  const actor = people.get(trip.actorId);

  if (!actor) {
    return;
  }

  const family = state.life.families.find(
    candidate => candidate.id === actor.familyId,
  )!;

  for (const id of [trip.actorId, ...trip.passengerIds]) {
    const person = people.get(id);

    if (person) {
      person.tripId = null;
      person.placeId = trip.toId;
      person.activity =
        trip.purpose === 'work'
          ? 'waiting'
          : trip.purpose === 'shop'
            ? 'shopping'
            : 'home';
      person.reason = person.age < LIFE_RULES.workerAge ? 'no-school' : null;
    }
  }

  if (trip.purpose === 'arrival') {
    family.status = 'settled';
    family.reason = null;
  }
  if (trip.purpose === 'shop') {
    const bought = buyHouseholdGoods(state, family.id, trip.toId);

    if (bought > 0) {
      family.lastShopDay = gameDay(state);
      family.reason = null;
    } else {
      family.reason = 'no-goods';
    }
  }
}
