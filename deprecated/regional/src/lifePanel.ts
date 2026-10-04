import type {RegionState} from '../../../packages/app/src/region/model/types';
import type {
  RegionalFamily,
  RegionalTrip,
} from '../../../packages/app/src/region/model/life/types';
import {LIFE_RULES} from '../../../packages/app/src/region/model/life/rules';
import {regionalPopulation} from './model/life/residents';
import {developmentReason} from './model/life/development';

const reasons: Record<string, string> = {
  disconnected: 'Дорожная сеть не связана с внешним въездом',
  'insufficient-capital': 'Владельцу не хватает капитала на строительство',
  'insufficient-funds': 'Недостаточно средств',
  'waiting-construction': 'Ждёт завершения строительства',
  'no-external-route': 'Нет маршрута от внешнего въезда',
  'arrival-queue': 'Ожидает въезда',
  'waiting-shift': 'Ожидает начала смены',
  'unpaid-wages': 'Работодателю не хватает средств на зарплату',
  'no-school': 'Школа пока недоступна',
  'no-goods': 'Нет доступных товаров',
  'delivery-busy': 'Транспорт занят',
  'no-destination': 'Место доставки недоступно',
  'storage-full': 'Склад заполнен',
  'missing-lot': 'Участок удалён',
  'no-road': 'Нет подъезда к дороге',
  'no-external-entry': 'Нет связи с внешним въездом',
  'no-demand': 'Пока нет спроса',
  'no-funds': 'Недостаточно средств у владельца',
  'waiting-home': 'Ожидает свободное жильё',
  'no-route': 'Нет доступного маршрута',
  'no-parking': 'Нет свободной парковки',
  'no-job': 'Нет подходящей работы',
  'no-stock': 'Нет товара',
  'out-of-stock': 'У поставщиков нет свободного товара',
  constructing: 'Идёт строительство',
  ready: 'Здание готово',
};
const activities = {
  outside: 'За пределами региона',
  home: 'Дома',
  work: 'На работе',
  shopping: 'Покупает товары',
  walking: 'Идёт пешком',
  driving: 'За рулём',
  passenger: 'Пассажир',
  waiting: 'Ожидает',
};
const kinds = {
  residential: 'Жилой дом',
  commercial: 'Магазин',
  industrial: 'Предприятие',
  warehouse: 'Склад',
};

export function lifeReason(reason: string | null): string {
  return reason ? (reasons[reason] ?? reason) : 'Нет препятствий';
}

export function cityLifeSummary(
  state: RegionState,
  settlementId: string,
): {
  population: number;
  employed: number;
  stock: number;
  ready: number;
  constructing: number;
  warehouseUpkeep: number;
} {
  const buildings = state.life.buildings.filter(
    building => building.settlementId === settlementId,
  );
  const homes = new Set(buildings.map(building => building.id));
  const families = state.life.families.filter(
    family =>
      family.status === 'settled' &&
      family.homeId !== null &&
      homes.has(family.homeId),
  );
  const people = new Set(families.flatMap(family => family.memberIds));

  return {
    warehouseUpkeep:
      state.warehouses.filter(
        warehouse => warehouse.settlementId === settlementId,
      ).length * LIFE_RULES.warehouseUpkeep,
    population: regionalPopulation(state, settlementId),
    employed: state.life.people.filter(
      person => people.has(person.id) && person.jobId !== null,
    ).length,
    stock: buildings.reduce((sum, building) => sum + building.inventory, 0),
    ready: buildings.filter(building => building.stage === 'ready').length,
    constructing: buildings.filter(
      building => building.stage === 'constructing',
    ).length,
  };
}

export function selectedTrip(
  state: RegionState,
  id: string,
): RegionalTrip | undefined {
  const person = state.life.people.find(value => value.id === id);
  const car = state.life.cars.find(value => value.id === id);
  const delivery = state.life.deliveries.find(
    value => value.id === id || value.tripId === id,
  );

  return state.life.trips.find(
    trip =>
      trip.id === id ||
      trip.id === (person?.tripId ?? car?.tripId ?? delivery?.tripId) ||
      trip.vehicleId === id ||
      trip.actorId === id,
  );
}

function familyFinanceDetail(family: RegionalFamily | undefined): string {
  const finance = family?.finance;

  if (!finance) {
    return '\nУчтённые расходы: история ещё не ведётся.';
  }

  const since =
    finance.sinceSeconds > 0
      ? ` с ${Math.floor((finance.sinceSeconds + LIFE_RULES.startingMinute * LIFE_RULES.secondsPerMinute) / LIFE_RULES.secondsPerDay) + 1}-го дня`
      : '';
  const amount = (value: number): string => value.toLocaleString('ru-RU');

  return `\nУчтённые расходы${since}: строительство ${amount(finance.construction)}, товары ${amount(finance.goods)}, поездки ${amount(finance.travel)}. Получено зарплаты: ${amount(finance.wages)}.`;
}

export function lifeInspection(
  state: RegionState,
  id: string,
): {title: string; detail: string} | null {
  const building = state.life.buildings.find(
    value => value.id === id || value.lotId === id,
  );
  const person = state.life.people.find(value => value.id === id);
  const car = state.life.cars.find(value => value.id === id);
  const delivery = state.life.deliveries.find(
    value => value.id === id || value.tripId === id,
  );
  const cityName = (buildingId: string | null) => {
    if (state.externalEntries.some(entry => entry.id === buildingId)) {
      return 'Внешний поставщик';
    }

    const cityId = state.life.buildings.find(
      value => value.id === buildingId,
    )?.settlementId;

    return (
      state.settlements.find(value => value.id === cityId)?.name ??
      'Не назначено'
    );
  };
  const trip = selectedTrip(state, id);
  const travel = trip
    ? `\nВ пути: ${Math.floor((state.life.elapsedSeconds - trip.startedAt) / 60)} мин. Осталось по маршруту: ${Math.ceil(Math.max(0, trip.route.lane.length - trip.distance))} м. Ожидание: ${Math.floor(trip.waitingSeconds)} с.`
    : '';

  if (building) {
    const residents = state.life.families
      .filter(
        family => family.homeId === building.id && family.status === 'settled',
      )
      .reduce((sum, family) => sum + family.memberIds.length, 0);
    const employees = state.life.people.filter(
      value => value.jobId === building.id,
    ).length;
    const working = state.life.people.filter(
      value =>
        value.jobId === building.id &&
        value.placeId === building.id &&
        value.activity === 'work',
    ).length;
    const owner = state.life.families.find(
      value => value.id === building.ownerId,
    );
    const funds =
      building.kind === 'warehouse'
        ? `Бюджет региона: ${state.cash.toLocaleString('ru-RU')}`
        : building.kind === 'residential'
          ? `Средства владельца: ${owner?.cash.toLocaleString('ru-RU') ?? 'нет данных'}`
          : `Счёт предприятия: ${building.cash.toLocaleString('ru-RU')}`;
    const capacity =
      building.kind === 'residential'
        ? `Жители: ${residents} / ${building.capacity}`
        : building.jobs > 0
          ? `Назначено работников: ${employees} / ${building.jobs}. На смене: ${working}`
          : '';
    const inventory =
      building.kind === 'residential'
        ? ''
        : `Запас: ${building.inventory} / ${building.inventoryCapacity}. `;
    const lot = [...state.parcels, ...state.warehouses].find(
      value => value.id === building.lotId,
    );
    const access = lot?.access ? '' : '\nНет подъезда к дороге.';

    return {
      title: kinds[building.kind],
      detail: `${cityName(building.id)} · ${building.stage === 'ready' ? 'Готово' : `Строительство ${Math.floor((building.progressSeconds / building.durationSeconds) * 100)}%`}\n${capacity}${capacity ? '.\n' : ''}${inventory}${funds}.${access}`,
    };
  }
  if (person) {
    const family = state.life.families.find(
      value => value.id === person.familyId,
    );

    return {
      title: person.name,
      detail: `${person.age} лет · квалификация ${person.qualification}\nДом: ${cityName(family?.homeId ?? null)}. Работа: ${cityName(person.jobId)}.\n${activities[person.activity]}. ${lifeReason(person.reason ?? family?.reason ?? null)}.\nБюджет семьи: ${Math.round(family?.cash ?? 0).toLocaleString('ru-RU')}. Товары: ${family?.goods ?? 0}.${familyFinanceDetail(family)}${travel}`,
    };
  }
  if (car) {
    const family = state.life.families.find(value => value.id === car.familyId);
    const driver = state.life.people.find(value => value.id === car.driverId);

    return {
      title: 'Семейный автомобиль',
      detail: `Семья: ${family?.memberIds.map(member => state.life.people.find(value => value.id === member)?.name ?? member).join(', ') ?? car.familyId}.\n${driver ? `Водитель: ${driver.name}` : 'Припаркован'}. Дом: ${cityName(family?.homeId ?? null)}.${travel}`,
    };
  }
  if (delivery) {
    const stages = {
      waiting: 'Ожидает',
      loading: 'Погрузка',
      'in-transit': 'В пути',
      unloading: 'Разгрузка',
      delivered: 'Доставлено',
    };

    return {
      title: 'Доставка товара',
      detail: `${stages[delivery.state]} · ${lifeReason(delivery.reason)}\nОткуда: ${delivery.sourceId ? cityName(delivery.sourceId) : 'Поставщик ещё не выбран'}. Куда: ${cityName(delivery.targetId)}.\nГруз: ${delivery.cargo}, заказ: ${delivery.quantity}. Цена за товар: ${delivery.unitPrice}.${travel}`,
    };
  }
  if (
    state.parcels.some(value => value.id === id) ||
    state.warehouses.some(value => value.id === id)
  ) {
    return {
      title: 'Участок застройки',
      detail: lifeReason(developmentReason(state, id)),
    };
  }

  return null;
}
