import {parseRegion} from '../region/model/save';
import type {RegionState} from '../region/model/types';
import {LIFE_RULES} from '../region/model/life/rules';
import type {AuthoredWorldDefinition} from '../city/life/definition';
import {CityLife} from '../city/life/world';
import {lifeCarKit} from '../city/life/population';
import type {Household, Resident, OwnedCar} from '../city/life/types';
import {AUTHORIZED_LEGACY_REPLAN_ID} from './legacyLayout';

export interface LegacyMigrationIssue {
  readonly code:
    | 'construction'
    | 'arrival'
    | 'resident-operation'
    | 'vehicle-operation'
    | 'delivery-operation'
    | 'traffic-reservation'
    | 'road-closure'
    | 'authored-definition'
    | 'housing-capacity'
    | 'parking-capacity'
    | 'account-target';
  readonly ids: readonly string[];
  readonly message: string;
}

export interface LegacyIdentity {
  readonly externalId: string;
  readonly nativeId: number;
}

export interface LegacyMigrationReport {
  readonly status: 'eligible' | 'unsupported';
  readonly regionId: string;
  readonly seed: string;
  readonly requiresAuthoredDefinition: true;
  readonly identities: {
    readonly families: readonly LegacyIdentity[];
    readonly people: readonly LegacyIdentity[];
    readonly cars: readonly LegacyIdentity[];
  };
  readonly calendar: {
    readonly startingMinute: number;
    readonly secondsPerMinute: number;
    readonly elapsedSeconds: number;
    readonly remainderSeconds: number;
    readonly day: number;
    readonly minute: number;
  };
  readonly balances: {
    readonly treasury: number;
    readonly families: number;
    readonly investors: number;
    readonly businesses: number;
    readonly moneyInAccounts: number;
    readonly externalMoney: number;
    readonly conservedMoney: number;
    readonly goodsInAccountsAndCargo: number;
    readonly conservedGoods: number;
  };
  readonly issues: readonly LegacyMigrationIssue[];
}

export class LegacyMigrationError extends Error {
  readonly original: unknown;

  constructor(
    message: string,
    original: unknown,
    readonly report: LegacyMigrationReport | null = null,
  ) {
    super(message);
    this.name = 'LegacyMigrationError';
    this.original = structuredClone(original);
  }
}

function parseLegacy(value: unknown): RegionState {
  try {
    return parseRegion(value);
  } catch (error) {
    throw new LegacyMigrationError(
      'Не удалось прочитать сохранение региона: ' +
        (error instanceof Error ? error.message : String(error)),
      value,
    );
  }
}

function reportFor(state: RegionState): LegacyMigrationReport {
  const life = state.life;
  const issues: LegacyMigrationIssue[] = [];
  const add = (
    code: LegacyMigrationIssue['code'],
    ids: string[],
    message: string,
  ): void => {
    if (ids.length) {
      issues.push({code, ids, message});
    }
  };

  add(
    'construction',
    life.buildings.filter(b => b.stage !== 'ready').map(b => b.id),
    'Стройки требуют переноса исходного lifecycle и активной операции.',
  );
  add(
    'arrival',
    life.families.filter(f => f.status !== 'settled').map(f => f.id),
    'Ожидание и прибытие семей требуют совместимого native arrival state.',
  );
  add(
    'resident-operation',
    life.people
      .filter(p => p.activity !== 'home' || p.tripId !== null)
      .map(p => p.id),
    'Поддержан перенос жителей дома; текущая поездка или работа не сбрасывается.',
  );
  add(
    'vehicle-operation',
    life.cars
      .filter(
        c =>
          c.driverId !== null ||
          c.tripId !== null ||
          c.parkedAt === null ||
          c.parkingSlot === null ||
          !life.buildings.some(b => b.id === c.parkedAt),
      )
      .map(c => c.id)
      .concat(life.trips.map(t => t.id)),
    'Активное движение и парковочные манёвры требуют отдельного route importer.',
  );
  add(
    'delivery-operation',
    life.deliveries
      .filter(
        d => d.state !== 'delivered' || d.cargo !== 0 || d.tripId !== null,
      )
      .map(d => d.id),
    'Груз и текущая погрузка сохраняются в исходнике до совместимого importer.',
  );
  add(
    'road-closure',
    [...life.closingRoadIds],
    'Закрытие занятой дороги нельзя завершать автоматически при переносе.',
  );
  const traffic = life.traffic;

  if (
    traffic &&
    (traffic.owners.some(owner => owner >= 0) ||
      traffic.held.some(gate => gate >= 0) ||
      traffic.vehicles.some(v => v.active || v.speed !== 0))
  ) {
    issues.push({
      code: 'traffic-reservation',
      ids: traffic.vehicles.filter(v => v.active).map(v => String(v.id)),
      message: 'Активный traffic или резервации требуют сохранения маршрутов.',
    });
  }

  const families = life.families.reduce((sum, f) => sum + f.cash, 0);
  const investors = life.investors.reduce((sum, i) => sum + i.cash, 0);
  const businesses = life.buildings.reduce((sum, b) => sum + b.cash, 0);
  const moneyInAccounts = state.cash + families + investors + businesses;
  const goodsInAccountsAndCargo =
    life.families.reduce((sum, f) => sum + f.goods, 0) +
    life.buildings.reduce((sum, b) => sum + b.inventory, 0) +
    life.deliveries.reduce((sum, d) => sum + d.cargo, 0);
  const minute =
    LIFE_RULES.startingMinute +
    life.elapsedSeconds / LIFE_RULES.secondsPerMinute;
  const identities = (items: ReadonlyArray<{id: string}>): LegacyIdentity[] =>
    items.map((item, nativeId) => ({externalId: item.id, nativeId}));

  return {
    status: issues.length ? 'unsupported' : 'eligible',
    regionId: state.id,
    seed: state.seed,
    requiresAuthoredDefinition: true,
    identities: {
      families: identities(life.families),
      people: identities(life.people),
      cars: identities(life.cars),
    },
    calendar: {
      startingMinute: LIFE_RULES.startingMinute,
      secondsPerMinute: LIFE_RULES.secondsPerMinute,
      elapsedSeconds: life.elapsedSeconds,
      remainderSeconds: life.remainderSeconds,
      day: Math.floor(minute / 1440),
      minute: minute % 1440,
    },
    balances: {
      treasury: state.cash,
      families,
      investors,
      businesses,
      moneyInAccounts,
      externalMoney: life.economy.externalMoney,
      conservedMoney: moneyInAccounts + life.economy.externalMoney,
      goodsInAccountsAndCargo,
      conservedGoods:
        goodsInAccountsAndCargo +
        life.economy.externalGoods +
        life.economy.consumed -
        life.economy.produced,
    },
    issues,
  };
}

/** Eligibility is a preflight result, not proof that native geometry was imported. */
export function inspectLegacyRegionMigration(
  value: unknown,
): LegacyMigrationReport {
  return reportFor(parseLegacy(value));
}

export function migrateLegacyRegionSave(
  value: unknown,
  definition: AuthoredWorldDefinition,
  options: {allowReplanForId?: string} = {},
): {
  definition: AuthoredWorldDefinition;
  world: ReturnType<CityLife['save']>;
  report: LegacyMigrationReport;
} {
  const state = parseLegacy(value);
  const report = reportFor(state);
  const fail: (
    code: LegacyMigrationIssue['code'],
    ids: string[],
    message: string,
  ) => never = (code, ids, message) => {
    throw new LegacyMigrationError(message, value, {
      ...report,
      status: 'unsupported',
      issues: [...report.issues, {code, ids, message}],
    });
  };

  if (report.status === 'unsupported') {
    throw new LegacyMigrationError(
      'Сохранение региона содержит неподдержанные активные операции.',
      value,
      report,
    );
  }

  const replan =
    options.allowReplanForId === AUTHORIZED_LEGACY_REPLAN_ID &&
    state.id === AUTHORIZED_LEGACY_REPLAN_ID;

  if (options.allowReplanForId !== undefined && !replan) {
    fail(
      'authored-definition',
      [state.id],
      'Перестройка этого сохранения не разрешена.',
    );
  }
  if (
    definition.kind !== 'authored' ||
    definition.seed !== state.seed ||
    (!replan &&
      JSON.stringify(definition.roads) !== JSON.stringify(state.roads))
  ) {
    fail(
      'authored-definition',
      [],
      'Описание должно содержать авторские дороги именно сохранённого региона.',
    );
  }

  const families = new Map(
    report.identities.families.map(id => [id.externalId, id.nativeId]),
  );
  const people = new Map(
    report.identities.people.map(id => [id.externalId, id.nativeId]),
  );
  const cars = new Map(
    report.identities.cars.map(id => [id.externalId, id.nativeId]),
  );
  const sourceBuildings = new Map(state.life.buildings.map(b => [b.id, b]));
  const profile = structuredClone(definition.profile);

  for (const building of state.life.buildings) {
    const place = profile.places.find(p => p.id === building.id);
    const kind =
      building.kind === 'residential'
        ? 'home'
        : building.kind === 'commercial'
          ? 'shop'
          : 'factory';

    if (!place || place.kind !== kind) {
      fail(
        'authored-definition',
        [building.id],
        'Нативное описание не содержит соответствующий исходному типу адрес.',
      );
    }
    if (building.kind !== 'residential') {
      place.capacity = building.jobs;
    } else if (building.cash !== 0 || building.inventory !== 0) {
      fail(
        'account-target',
        [building.id],
        'Для отдельного счёта или запаса жилого здания нет нативного account target.',
      );
    }
  }

  const {life, cash, ...document} = state;
  const importedDefinition: AuthoredWorldDefinition = {
    ...structuredClone(definition),
    profile,
    calendar: {
      startingMinute: LIFE_RULES.startingMinute,
      secondsPerMinute: LIFE_RULES.secondsPerMinute,
    },
    metadata: {
      ...structuredClone(definition.metadata ?? {}),
      legacyMigration: {
        version: 1,
        document,
        identities: report.identities,
        investors: structuredClone(life.investors),
        ledger: structuredClone(life.economy),
        familyHistory: life.families.map(family =>
          Object.fromEntries(
            Object.entries(family).filter(
              ([key]) => key !== 'cash' && key !== 'goods',
            ),
          ),
        ),
        residentHistory: structuredClone(life.people),
        buildingHistory: life.buildings.map(building =>
          Object.fromEntries(
            Object.entries(building).filter(
              ([key]) => key !== 'cash' && key !== 'inventory',
            ),
          ),
        ),
        deliveries: structuredClone(life.deliveries),
        completedTrips: life.completedTrips,
        completedDeliveries: life.completedDeliveries,
        originalTraffic: structuredClone(life.traffic),
        nativeDefaults: {
          parents: [],
          lifespan: 100,
          preference: 0.5,
          babyDueDay: null,
          history: [],
        },
      },
    },
  };
  const world = CityLife.fromDefinition(importedDefinition, {
    initialFamilies: 0,
  });
  const population = world.population.save();
  const parking = structuredClone(world.parking.slots);
  const familyHomes = new Map<string, number>();

  for (const unit of population.units) {
    const home = sourceBuildings.get(unit.building);

    if (home) {
      unit.owner = families.get(home.ownerId) ?? null;
      unit.rent = 0;
    }
  }

  for (const family of life.families) {
    const home = sourceBuildings.get(family.homeId ?? '');
    const unit = population.units.find(
      u => u.building === family.homeId && u.tenant === null,
    );

    if (!home || !unit) {
      fail(
        'housing-capacity',
        [family.id],
        'Нет свободного настоящего нативного жилья для исходной семьи.',
      );
    }

    unit.tenant = families.get(family.id)!;
    unit.owner = families.get(home.ownerId) ?? null;
    unit.capacity = Math.max(unit.capacity, family.memberIds.length);
    unit.rent = 0;
    familyHomes.set(family.id, unit.id);
  }

  population.families = life.families.map((family, id): Household => ({
    id,
    surname: '',
    members: family.memberIds.map(id => people.get(id)!),
    home: familyHomes.get(family.id)!,
    balance: family.cash,
    food: family.goods,
    cars: family.carId === null ? [] : [cars.get(family.carId)!],
    babyDueDay: null,
    goal: family.reason ?? '',
    arrived: true,
  }));
  population.people = life.people.map((person, id): Resident => {
    const family = life.families[families.get(person.familyId)!]!;
    const place = profile.places.find(p => p.id === person.placeId);
    const job =
      person.jobId === null
        ? null
        : profile.places.find(p => p.id === person.jobId);

    if (
      !place ||
      person.placeId !== family.homeId ||
      (person.jobId !== null && !job)
    ) {
      fail(
        'authored-definition',
        [person.id],
        'Текущий адрес или рабочее место отсутствует в нативном описании.',
      );
    }

    return {
      id,
      name: person.name,
      family: families.get(person.familyId)!,
      birthDay: report.calendar.day - person.age * 365,
      parents: [],
      education: person.qualification,
      lifespan: Math.max(100, person.age + 1),
      preference: 0.5,
      job: job
        ? {
            building: job.id,
            title: job.name,
            wage: job.wage,
            start: LIFE_RULES.workStartMinute,
            shift: LIFE_RULES.workEndMinute - LIFE_RULES.workStartMinute,
          }
        : null,
      activity: 'home',
      location: place.id,
      position: structuredClone(place.door),
      dx: 0,
      dz: 1,
      nextAt: life.elapsedSeconds,
      trip: null,
      workStarted: life.elapsedSeconds,
      paidDay: report.calendar.day - 1,
      errandsDay: family.lastShopDay,
      leisureDay: -1,
      earnings: 0,
      history: [],
    };
  });

  for (const business of population.businesses) {
    const source = sourceBuildings.get(business.building);

    business.balance = source?.cash ?? 0;
    business.stock = source?.inventory ?? 0;
    business.jobs = source?.jobs ?? business.jobs;
    business.workers = population.people
      .filter(person => person.job?.building === business.building)
      .map(person => person.id);
  }

  population.cars = life.cars.map((car, id): OwnedCar => {
    const place = profile.places.find(p => p.id === car.parkedAt);
    const facility =
      place?.parking === null || place?.parking === undefined
        ? undefined
        : profile.facilities[place.parking];
    const slotId = facility?.slots[car.parkingSlot!];
    const slot = slotId === undefined ? undefined : parking[slotId];

    if (
      !facility ||
      !slot ||
      slot.occupant !== null ||
      slot.reserved !== null
    ) {
      fail(
        'parking-capacity',
        [car.id],
        'Исходная парковка не помещается в действительную нативную facility.',
      );
    }

    slot.occupant = id;
    slot.household = families.get(car.familyId)!;

    return {
      id,
      owner: families.get(car.familyId)!,
      driver: null,
      slot: slot.id,
      status: 'parked',
      facility: facility.id,
      targetSlot: null,
      waitUntil: 0,
      price: 0,
      tier: 0,
    };
  });
  population.treasury = cash;
  population.born = 0;
  population.arrivals = life.people.length;
  world.population.restore(population);
  const carVehicleIds = population.cars.map(car => {
    const slot = parking[car.slot!]!;

    return world.traffic.addCar(lifeCarKit(state.seed, car.id, car.tier), {
      ...slot.position,
      dx: Math.sin(slot.yaw),
      dz: Math.cos(slot.yaw),
    });
  });
  const saved = world.save();

  saved.tick = life.elapsedSeconds / 0.05;
  saved.requested = life.elapsedSeconds + life.remainderSeconds;
  saved.dayDone = report.calendar.day;
  saved.nextImmigration = life.elapsedSeconds + 900;
  saved.nextAssets = life.elapsedSeconds + 180;
  saved.carsAdded = life.cars.length;
  saved.parking = parking;
  saved.traffic.tick = saved.tick;
  saved.traffic.lastTime = life.elapsedSeconds;

  if (saved.version === 3) {
    saved.vehicleIds.cars = carVehicleIds;
  }

  const loaded = CityLife.fromSave(saved, importedDefinition);

  return {definition: importedDefinition, world: loaded.save(), report};
}
