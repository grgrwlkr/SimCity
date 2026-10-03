import {buildingBalance, debitBuilding, payBuildingSale} from './economy';
import {LIFE_RULES} from './rules';
import type {
  MutableRegion,
  RegionalBuilding,
  RegionalDelivery,
  RegionalTrip,
  RegionMobilityPort,
} from './types';

function active(delivery: RegionalDelivery): boolean {
  return delivery.state !== 'waiting' && delivery.state !== 'delivered';
}

function bayBusy(state: MutableRegion, placeId: string): boolean {
  return state.life.deliveries.some(
    delivery =>
      active(delivery) &&
      (delivery.sourceId === placeId || delivery.targetId === placeId),
  );
}

function orderStock(state: MutableRegion): void {
  const targets = new Set(
    state.life.deliveries
      .filter(delivery => delivery.state !== 'delivered')
      .map(delivery => delivery.targetId),
  );

  for (const target of state.life.buildings) {
    if (
      target.stage !== 'ready' ||
      (target.kind !== 'commercial' && target.kind !== 'warehouse') ||
      target.inventory >= target.inventoryCapacity / 2 ||
      targets.has(target.id)
    ) {
      continue;
    }

    state.life.deliveries.push({
      id: `delivery-${state.life.nextId++}`,
      sourceId: null,
      targetId: target.id,
      quantity: Math.min(
        LIFE_RULES.deliverySize,
        target.inventoryCapacity - target.inventory,
      ),
      cargo: 0,
      state: 'waiting',
      tripId: null,
      phaseSeconds: 0,
      unitPrice: 0,
      reason: null,
    });
  }
}

interface Supply {
  id: string;
  stock: number;
  price: number;
  building: RegionalBuilding | null;
}

function loadOrder(
  state: MutableRegion,
  mobility: RegionMobilityPort,
  delivery: RegionalDelivery,
  target: RegionalBuilding,
): void {
  if (
    state.life.deliveries.filter(active).length >= LIFE_RULES.maxTrucks ||
    bayBusy(state, target.id)
  ) {
    delivery.reason = 'delivery-busy';

    return;
  }

  // Warehouses aggregate production/imports; they do not circulate stock among themselves.
  const sources: Supply[] = state.life.buildings
    .filter(
      source =>
        source.id !== target.id &&
        source.stage === 'ready' &&
        (source.kind === 'industrial' ||
          (source.kind === 'warehouse' && target.kind === 'commercial')),
    )
    .map(source => ({
      id: source.id,
      stock: source.inventory,
      price:
        source.kind === 'warehouse'
          ? LIFE_RULES.warehousePrice
          : LIFE_RULES.wholesalePrice,
      building: source,
    }));

  sources.sort(
    (a, b) =>
      Number(b.building?.settlementId === target.settlementId) -
      Number(a.building?.settlementId === target.settlementId),
  );
  sources.push(
    ...state.externalEntries.map(entry => ({
      id: entry.id,
      stock: state.life.economy.externalGoods,
      price: LIFE_RULES.importPrice,
      building: null,
    })),
  );

  let reason = state.externalEntries.length
    ? 'out-of-stock'
    : 'no-external-entry';

  for (const source of sources) {
    if (source.stock <= 0) {
      continue;
    }
    if (bayBusy(state, source.id)) {
      reason = 'delivery-busy';
      continue;
    }
    if (!mobility.route(source.id, target.id, 'truck')) {
      reason = 'no-route';
      continue;
    }

    const affordable = Math.floor(
      (buildingBalance(state, target) - LIFE_RULES.deliveryFee) / source.price,
    );
    const quantity = Math.min(
      delivery.quantity,
      source.stock,
      target.inventoryCapacity - target.inventory,
      affordable,
    );

    if (quantity <= 0) {
      reason = 'insufficient-funds';
      continue;
    }

    const value = quantity * source.price;

    if (!payBuildingSale(state, target.id, source.id, value)) {
      reason = 'insufficient-funds';
      continue;
    }

    debitBuilding(state, target, LIFE_RULES.deliveryFee);
    state.life.economy.externalMoney += LIFE_RULES.deliveryFee;

    if (source.building) {
      source.building.inventory -= quantity;
    } else {
      state.life.economy.externalGoods -= quantity;
    }

    delivery.sourceId = source.id;
    delivery.quantity = quantity;
    delivery.cargo = quantity;
    delivery.unitPrice = source.price;
    delivery.state = 'loading';
    delivery.phaseSeconds = 0;
    delivery.reason = null;

    return;
  }

  delivery.reason = reason;
}

/** Called once per game second. Cargo is the sole owner of stock between loading and unloading. */
export function stepLogistics(
  state: MutableRegion,
  mobility: RegionMobilityPort,
): void {
  orderStock(state);
  const buildings = new Map(
    state.life.buildings.map(value => [value.id, value]),
  );

  for (const delivery of state.life.deliveries) {
    const target = buildings.get(delivery.targetId);

    if (!target || target.stage !== 'ready') {
      delivery.reason = 'no-destination';
      continue;
    }

    switch (delivery.state) {
      case 'waiting':
        loadOrder(state, mobility, delivery, target);
        break;

      case 'loading': {
        delivery.phaseSeconds = Math.min(
          delivery.phaseSeconds + 1,
          LIFE_RULES.loadingSeconds,
        );

        if (
          delivery.phaseSeconds < LIFE_RULES.loadingSeconds ||
          !delivery.sourceId
        ) {
          break;
        }
        if (!mobility.route(delivery.sourceId, delivery.targetId, 'truck')) {
          delivery.reason = 'no-route';
          break;
        }

        const trip = mobility.start({
          actorId: delivery.id,
          fromId: delivery.sourceId,
          toId: delivery.targetId,
          mode: 'truck',
          purpose: 'delivery',
        });

        if (!trip) {
          delivery.reason = 'delivery-busy';
          break;
        }

        delivery.tripId = trip.id;
        delivery.state = 'in-transit';
        delivery.phaseSeconds = 0;
        delivery.reason = null;
        break;
      }

      case 'unloading': {
        delivery.phaseSeconds = Math.min(
          delivery.phaseSeconds + 1,
          LIFE_RULES.unloadingSeconds,
        );

        if (delivery.phaseSeconds < LIFE_RULES.unloadingSeconds) {
          break;
        }
        if (target.inventory + delivery.cargo > target.inventoryCapacity) {
          delivery.reason = 'storage-full';
          break;
        }

        target.inventory += delivery.cargo;
        delivery.cargo = 0;
        delivery.state = 'delivered';
        delivery.reason = null;
        state.life.completedDeliveries++;
        break;
      }

      case 'in-transit':
      case 'delivered':
        break;
    }
  }

  let retired =
    state.life.deliveries.filter(
      delivery => delivery.state === 'delivered' && delivery.cargo === 0,
    ).length - 100;

  if (retired > 0) {
    state.life.deliveries = state.life.deliveries.filter(delivery => {
      if (
        retired > 0 &&
        delivery.state === 'delivered' &&
        delivery.cargo === 0
      ) {
        retired--;

        return false;
      }

      return true;
    });
  }
}

export function completeDelivery(
  state: MutableRegion,
  trip: RegionalTrip,
): void {
  const delivery = state.life.deliveries.find(
    value => value.id === trip.actorId,
  );

  if (
    trip.purpose !== 'delivery' ||
    trip.mode !== 'truck' ||
    !delivery ||
    delivery.state !== 'in-transit' ||
    delivery.tripId !== trip.id ||
    delivery.targetId !== trip.toId ||
    delivery.sourceId !== trip.fromId
  ) {
    return;
  }

  delivery.tripId = null;
  delivery.state = 'unloading';
  delivery.phaseSeconds = 0;
  delivery.reason = null;
}
