import {vehicleKit, type VehicleKit} from '../assetKits';
import {distance} from './network';
import type {
  Business,
  Household,
  HousingUnit,
  LifePlace,
  LifeProfile,
  OwnedCar,
  Resident,
} from './types';
import type {ParkingBook} from './parking';
import type {NativeCalendar} from './definition';

export interface NativePopulationEconomy {
  registriesChanged(): void;
  readonly retailPrice: number;
  availableStock(id: string): number;
  recordRetail(id: string, value: number): void;
  recordWage(value: number): void;
  recordConsumption(quantity: number): void;
  recordFamilyCapital(value: number, goods?: number): number;
  payRent(unit: HousingUnit, value: number): void;
  payHome(unit: HousingUnit, value: number): void;
}

export const MINUTE_SECONDS = 3;
export const INITIAL_MINUTE = 450;
export class LifeRandom {
  state = 2166136261;

  constructor(seed: string) {
    for (const c of seed) {
      this.state = Math.imul(this.state ^ c.charCodeAt(0), 16777619);
    }
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let n = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);

    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);

    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  }

  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
}
const MALE = [
  'Алексей',
  'Михаил',
  'Денис',
  'Илья',
  'Никита',
  'Андрей',
  'Павел',
  'Роман',
  'Антон',
  'Дмитрий',
  'Лев',
  'Тимофей',
];
const FEMALE = [
  'Анна',
  'Мария',
  'Елена',
  'Полина',
  'Алиса',
  'Вера',
  'Ольга',
  'Софья',
  'Ирина',
  'Дарья',
  'Нина',
  'Татьяна',
];
const SURNAMES = [
  'Соколов',
  'Морозов',
  'Волков',
  'Орлов',
  'Громов',
  'Лебедев',
  'Белов',
  'Смирнов',
  'Фролов',
  'Крылов',
  'Лазарев',
  'Титов',
  'Котов',
  'Зайцев',
  'Романов',
  'Егоров',
];
const PRICES = [250000, 550000, 950000] as const;

export function lifeCarKit(seed: string, id: number, tier: number): VehicleKit {
  return {
    ...vehicleKit(seed, 10000 + id),
    body: (['hatchback', 'sedan', 'estate'] as const)[tier]!,
    length: [2.8, 3.2, 3.8][tier]!,
    width: 1.5,
  };
}

export const carName = (tier: number) =>
  ['Компактный автомобиль', 'Седан', 'Семейный универсал'][tier]!;

export class Population {
  readonly people: Resident[] = [];
  readonly families: Household[] = [];
  readonly units: HousingUnit[] = [];
  readonly cars: OwnedCar[] = [];
  readonly businesses: Business[] = [];
  readonly random: LifeRandom;
  treasury = 1000000000;
  born = 0;
  arrivals = 0;
  private readonly places = new Map<string, LifePlace>();
  private economy: NativePopulationEconomy | undefined;

  setEconomicProvider(provider: NativePopulationEconomy): void {
    this.economy = provider;
  }

  constructor(
    readonly profile: LifeProfile,
    readonly parking: ParkingBook,
    count = 180,
    initialCars = true,
    private readonly options: {
      calendar?: NativeCalendar | undefined;
      deliveredGoods?: boolean;
      startingCash?: number | undefined;
    } = {},
  ) {
    this.random = new LifeRandom(profile.seed + '/life');
    this.treasury = this.options.startingCash ?? this.treasury;

    for (const p of profile.places) {
      this.registerPlace(p);
    }

    for (let i = 0; i < count; i++) {
      this.createFamily(0, false);
    }

    this.assignJobs(0, 0);

    if (initialCars) {
      for (const f of this.families) {
        this.buyCar(f, 0, true);
      }
    }
  }

  registerPlace(p: LifePlace): void {
    if (this.places.has(p.id)) {
      throw new Error(`Duplicate native place ${p.id}`);
    }

    this.places.set(p.id, p);

    if (p.kind === 'home') {
      for (let i = 0; i < p.capacity; i++) {
        this.units.push({
          id: this.units.length,
          building: p.id,
          capacity: p.building?.plot ? 4 : 3 + (p.building!.floors % 2),
          price: p.price,
          rent: Math.round(p.price / 3000),
          tenant: null,
          owner: null,
        });
      }
    } else if (p.kind !== 'park') {
      this.businesses.push({
        building: p.id,
        balance: this.options.deliveredGoods ? 0 : 1000000,
        stock: p.kind === 'shop' && !this.options.deliveredGoods ? 120 : 0,
        jobs: p.kind === 'school' ? 12 : p.capacity,
        workers: [],
      });
    }
  }

  hasPlace(id: string): boolean {
    return this.places.has(id);
  }

  unregisterPlace(id: string): void {
    if (
      this.units.some(
        unit =>
          unit.building === id && (unit.tenant !== null || unit.owner !== null),
      ) ||
      this.businesses.some(
        business =>
          business.building === id &&
          (business.workers.length || business.stock || business.balance),
      )
    ) {
      throw new Error('Здание занято или хранит имущество');
    }

    for (const unit of this.units.filter(unit => unit.building === id)) {
      unit.retired = true;
    }

    const index = this.businesses.findIndex(
      business => business.building === id,
    );

    if (index >= 0) {
      this.businesses.splice(index, 1);
    }

    this.places.delete(id);
  }

  place(id: string): LifePlace {
    const p = this.places.get(id);

    if (!p) {
      throw new Error(`Unknown city address ${id}`);
    }

    return p;
  }

  home(f: Household): LifePlace {
    return this.place(this.units[f.home]!.building);
  }

  age(p: Resident, day: number): number {
    return Math.max(0, Math.floor((day - p.birthDay) / 365));
  }

  event(p: Resident, at: number, text: string): void {
    p.history.push({at, text});

    if (p.history.length > 14) {
      p.history.shift();
    }
  }

  familyEvent(f: Household, at: number, text: string): void {
    for (const id of f.members) {
      this.event(this.people[id]!, at, text);
    }
  }

  private person(
    family: Household,
    day: number,
    age: number,
    female: boolean,
    parents: number[],
    at: number,
  ): Resident {
    const home = this.home(family);
    const id = this.people.length;
    const p: Resident = {
      id,
      name: `${this.random.pick(female ? FEMALE : MALE)} ${family.surname}${female ? 'а' : ''}`,
      family: family.id,
      birthDay: day - age * 365 - (age ? this.random.int(0, 364) : 0),
      parents,
      education: age < 18 ? 0 : this.random.int(0, 3),
      lifespan: this.random.int(76, 94),
      preference: this.random.next(),
      job: null,
      activity: 'home',
      location: home.id,
      position: {...home.door},
      dx: 0,
      dz: 1,
      nextAt: at + this.random.int(0, 45),
      trip: null,
      workStarted: 0,
      paidDay: -1,
      errandsDay: -1,
      leisureDay: -1,
      earnings: 0,
      history: [],
    };

    this.people.push(p);
    family.members.push(id);

    return p;
  }

  createFamily(at: number, immigrant: boolean): Household | null {
    const homes = this.profile.places.filter(p => p.kind === 'home');

    if (!homes.length) {
      return null;
    }

    const preferred = homes[this.families.length % homes.length]!;
    const unit =
      this.units.find(
        u => !u.retired && u.tenant === null && u.building === preferred.id,
      ) ?? this.units.find(u => !u.retired && u.tenant === null);

    if (!unit) {
      return null;
    }

    const id = this.families.length;
    const day = Math.floor(
      ((this.options.calendar?.startingMinute ?? INITIAL_MINUTE) +
        at / (this.options.calendar?.secondsPerMinute ?? MINUTE_SECONDS)) /
        1440,
    );
    const f: Household = {
      id,
      surname: this.random.pick(SURNAMES),
      members: [],
      home: unit.id,
      balance:
        id % 5 === 0
          ? this.random.int(4000000, 5700000)
          : Math.round(60000 + this.random.next() ** 2 * 1700000),
      food: this.random.int(7, 15),
      cars: [],
      babyDueDay: null,
      goal: 'Накопления на жильё',
      arrived: !immigrant,
    };

    if (this.economy) {
      f.food = this.economy.recordFamilyCapital(f.balance, f.food);
    }

    this.families.push(f);
    unit.tenant = id;
    const years = this.random.int(27, 63);
    const a = this.person(f, day, years, false, [], at);
    const b = this.person(
      f,
      day,
      Math.max(24, years + this.random.int(-3, 2)),
      true,
      [],
      at,
    );

    this.person(
      f,
      day,
      this.random.int(6, 16),
      this.random.next() < 0.5,
      [a.id, b.id],
      at,
    );

    if (years < 40 && unit.capacity > 3 && this.random.next() < 0.3) {
      f.babyDueDay = day + this.random.int(2, 12);
    }
    if (f.balance >= unit.price + 180000) {
      this.buyHome(f, at);
    } else {
      const deposit = unit.rent * 7;

      f.balance -= deposit;
      this.treasury += deposit;
      this.familyEvent(f, at, `Арендовано жильё: ${this.home(f).name}`);
    }

    this.familyEvent(
      f,
      at,
      immigrant ? 'Семья переезжает в город' : 'Семья живёт в городе',
    );

    return f;
  }

  nextHome(): LifePlace | null {
    const homes = this.profile.places.filter(place => place.kind === 'home');
    const preferred = homes[this.families.length % homes.length];
    const unit =
      this.units.find(
        unit =>
          !unit.retired &&
          unit.tenant === null &&
          unit.building === preferred?.id,
      ) ?? this.units.find(unit => !unit.retired && unit.tenant === null);

    return unit ? this.place(unit.building) : null;
  }

  assignJobs(day: number, at: number): void {
    for (const p of this.people) {
      if (
        p.activity === 'dead' ||
        p.job ||
        this.age(p, day) < 18 ||
        this.age(p, day) >= 65
      ) {
        continue;
      }

      const home = this.home(this.families[p.family]!);
      const choices = this.businesses.filter(
        b =>
          b.workers.length < b.jobs &&
          this.place(b.building).education <= p.education,
      );

      choices.sort(
        (a, b) =>
          this.place(b.building).wage -
            distance(home.door, this.place(b.building).door) * 16 -
            (this.place(a.building).wage -
              distance(home.door, this.place(a.building).door) * 16) ||
          a.building.localeCompare(b.building),
      );
      const business = choices[0];

      if (!business) {
        continue;
      }

      const place = this.place(business.building);

      business.workers.push(p.id);
      p.job = {
        building: place.id,
        title:
          place.kind === 'factory'
            ? 'Работник производства'
            : place.kind === 'office'
              ? 'Специалист'
              : place.kind === 'school'
                ? 'Преподаватель'
                : place.kind === 'cafe'
                  ? 'Сотрудник кафе'
                  : 'Продавец',
        wage: place.wage,
        start: 480 + (p.id % 3) * 30,
        shift: 480,
      };
      this.event(p, at, `Устроился на работу: ${place.name}`);
    }
  }

  buyHome(f: Household, at: number): boolean {
    const unit = this.units[f.home]!;

    if (unit.owner !== null || f.balance < unit.price + 60000) {
      return false;
    }

    f.balance -= unit.price;

    if (this.economy) {
      this.economy.payHome(unit, unit.price);
    } else {
      this.treasury += unit.price;
    }

    unit.owner = f.id;
    f.goal = 'Семейные накопления';
    this.familyEvent(f, at, `Куплено жильё: ${this.home(f).name}`);

    return true;
  }

  buyCar(f: Household, at: number, initial = false): OwnedCar | null {
    if (
      f.cars.length ||
      (!initial && !f.arrived) ||
      f.balance < PRICES[0] + 60000
    ) {
      return null;
    }

    const tier =
      f.balance > PRICES[2] + 250000
        ? 2
        : f.balance > PRICES[1] + 150000
          ? 1
          : 0;
    const home = this.home(f);
    const own = this.parking.leaseHome(f, home);

    if (!own) {
      f.goal = 'Нужно место для машины';

      return null;
    }

    const dealer = this.profile.facilities.find(
      facility =>
        facility.kind === 'underground' &&
        !facility.residentsOnly &&
        this.parking.available(facility.id, f.id, home.blockId),
    );
    const location = initial
      ? own
      : dealer
        ? this.parking.available(dealer.id, f.id, home.blockId)
        : undefined;

    if (!location) {
      return null;
    }

    const id = this.cars.length;
    const price = PRICES[tier];

    f.balance -= price;
    this.treasury += price;
    const car: OwnedCar = {
      id,
      owner: f.id,
      driver: null,
      slot: location.id,
      status: 'parked',
      facility: null,
      targetSlot: null,
      waitUntil: 0,
      price,
      tier,
    };

    location.reserved = id;
    this.parking.park(location.id, id);
    this.cars.push(car);
    f.cars.push(id);
    this.familyEvent(f, at, `Куплен ${carName(tier).toLowerCase()}`);
    f.goal =
      this.units[f.home]!.owner === f.id
        ? 'Семейные накопления'
        : 'Накопления на своё жильё';

    return car;
  }

  payWage(p: Resident, day: number, seconds: number): void {
    if (!p.job || p.paidDay === day) {
      return;
    }

    const employer = this.businesses.find(b => b.building === p.job!.building)!;
    const attended = Math.min(
      p.job.shift * (this.options.calendar?.secondsPerMinute ?? MINUTE_SECONDS),
      Math.max(0, seconds - p.workStarted),
    );
    const wage = Math.min(
      employer.balance,
      Math.floor(
        (p.job.wage * attended) /
          (p.job.shift *
            (this.options.calendar?.secondsPerMinute ?? MINUTE_SECONDS)),
      ),
    );

    employer.balance -= wage;
    this.families[p.family]!.balance += wage;
    p.earnings += wage;
    this.economy?.recordWage(wage);
    p.paidDay = day;
    this.event(
      p,
      seconds,
      `Получена зарплата: ${wage.toLocaleString('ru-RU')} ₽`,
    );
  }

  shop(p: Resident, place: LifePlace, at: number): void {
    const f = this.families[p.family]!;
    const business = this.businesses.find(b => b.building === place.id);

    if (!business) {
      return;
    }

    const quantity = Math.max(
      0,
      Math.min(
        this.economy?.availableStock(place.id) ?? business.stock,
        f.members.length * 6 - f.food,
        Math.floor(f.balance / (this.economy?.retailPrice ?? 160)),
      ),
    );
    const cost = quantity * (this.economy?.retailPrice ?? 160);

    f.balance -= cost;
    business.balance += cost;
    business.stock -= quantity;
    this.economy?.recordRetail(place.id, cost);
    f.food += quantity;
    this.event(
      p,
      at,
      quantity
        ? `Куплены продукты для семьи: ${cost.toLocaleString('ru-RU')} ₽`
        : 'Покупку пришлось отложить',
    );
  }

  daily(day: number, at: number): void {
    // Businesses serve the region as well as residents; these are explicit external revenues.
    for (const b of this.businesses) {
      if (!this.options.deliveredGoods) {
        b.balance += this.place(b.building).wage * b.workers.length;
      }

      if (
        !this.options.deliveredGoods &&
        this.place(b.building).kind === 'shop'
      ) {
        const goods = Math.max(0, 120 - b.stock);

        b.balance -= goods * 70;
        b.stock += goods;
      }
    }

    for (const p of this.people) {
      const age = this.age(p, day);

      if (p.job && age >= 65) {
        const employer = this.businesses.find(
          b => b.building === p.job!.building,
        )!;

        employer.workers = employer.workers.filter(id => id !== p.id);
        p.job = null;
        this.event(p, at, 'Вышел на пенсию');
      }
      if (age >= p.lifespan && p.activity === 'home') {
        p.activity = 'dead';
        this.families[p.family]!.members = this.families[
          p.family
        ]!.members.filter(id => id !== p.id);
        this.event(p, at, 'Жизненный путь завершён');
      }
      if (age >= 65 && p.activity !== 'dead') {
        this.families[p.family]!.balance += 1100;
        this.treasury -= 1100;
      }
    }

    for (const f of this.families) {
      if (!f.members.length) {
        this.units[f.home]!.tenant = null;
        this.treasury += f.balance;
        f.balance = 0;

        for (const unit of this.units) {
          if (unit.owner === f.id) {
            unit.owner = null;
          }
        }

        for (const id of f.cars) {
          this.cars[id]!.owner = -1;
          this.parking.leave(id);
          this.parking.cancel(id);
        }

        for (const slot of this.parking.slots) {
          if (slot.household === f.id) {
            slot.household = null;
          }
        }

        continue;
      }

      const used = Math.min(f.food, f.members.length * 2);

      f.food = Math.max(0, f.food - f.members.length * 2);
      this.economy?.recordConsumption(used);
      const unit = this.units[f.home]!;

      if (unit.owner !== f.id) {
        const rent = Math.min(f.balance, unit.rent);

        f.balance -= rent;

        if (this.economy) {
          this.economy.payRent(unit, rent);
        } else if (unit.owner === null) {
          this.treasury += rent;
        } else {
          this.families[unit.owner]!.balance += rent;
        }

        this.familyEvent(f, at, `Оплачена аренда: ${rent} ₽`);
      }

      for (const id of f.cars) {
        const charge = Math.min(f.balance, 120 + this.cars[id]!.tier * 80);

        f.balance -= charge;
        this.treasury += charge;
      }

      if (
        f.babyDueDay !== null &&
        f.babyDueDay <= day &&
        f.members.length < unit.capacity
      ) {
        const parents = f.members
          .filter(id => this.age(this.people[id]!, day) >= 18)
          .slice(0, 2);

        if (parents.length === 2) {
          const baby = this.person(
            f,
            day,
            0,
            this.random.next() < 0.5,
            parents,
            at,
          );

          this.born++;
          this.familyEvent(
            f,
            at,
            `В семье родился ребёнок: ${baby.name.split(' ')[0]}`,
          );
        }

        f.babyDueDay = null;
      }

      this.buyHome(f, at);

      if (
        f.babyDueDay === null &&
        f.members.length < unit.capacity &&
        this.random.next() < 0.008 &&
        f.members.filter(id => {
          const age = this.age(this.people[id]!, day);

          return age >= 23 && age <= 40;
        }).length >= 2
      ) {
        f.babyDueDay = day + 270;
      }
    }

    this.assignJobs(day, at);
  }

  save() {
    return structuredClone({
      people: this.people,
      families: this.families,
      units: this.units,
      cars: this.cars,
      businesses: this.businesses,
      random: this.random.state,
      treasury: this.treasury,
      born: this.born,
      arrivals: this.arrivals,
    });
  }

  restore(saved: ReturnType<Population['save']>): void {
    const s = structuredClone(saved);

    this.people.splice(0, this.people.length, ...s.people);
    this.families.splice(0, this.families.length, ...s.families);
    this.units.splice(0, this.units.length, ...s.units);
    this.cars.splice(0, this.cars.length, ...s.cars);
    this.businesses.splice(0, this.businesses.length, ...s.businesses);
    this.random.state = s.random;
    this.treasury = s.treasury;
    this.born = s.born;
    this.arrivals = s.arrivals;
    this.economy?.registriesChanged();
  }
}
