import {refreshAccess} from '../parcels';
import type {RegionState, RejectReason} from '../types';
import type {MutableRegion, RegionalBuilding} from './types';

type RemovalResult = {state: RegionState} | {reason: RejectReason};

function buildingOccupied(
  state: RegionState,
  building: RegionalBuilding,
): boolean {
  const id = building.id;

  return (
    building.inventory > 0 ||
    state.life.families.some(
      family => family.homeId === id && family.status !== 'waiting',
    ) ||
    state.life.people.some(
      person => person.jobId === id || person.placeId === id,
    ) ||
    state.life.cars.some(car => car.parkedAt === id) ||
    state.life.trips.some(trip => trip.fromId === id || trip.toId === id) ||
    state.life.deliveries.some(
      delivery =>
        (delivery.sourceId === id || delivery.targetId === id) &&
        ((delivery.state !== 'delivered' && delivery.state !== 'waiting') ||
          delivery.cargo > 0 ||
          delivery.tripId !== null),
    )
  );
}

function entryBusy(
  state: RegionState,
  ids: ReadonlySet<string>,
  includeTrips: boolean,
): boolean {
  return (
    state.life.cars.some(
      car => car.parkedAt !== null && ids.has(car.parkedAt),
    ) ||
    state.life.people.some(
      person =>
        person.placeId !== null &&
        ids.has(person.placeId) &&
        (includeTrips || person.tripId === null),
    ) ||
    state.life.deliveries.some(
      delivery =>
        ((delivery.sourceId !== null && ids.has(delivery.sourceId)) ||
          ids.has(delivery.targetId)) &&
        (includeTrips
          ? (delivery.state !== 'delivered' && delivery.state !== 'waiting') ||
            delivery.cargo > 0 ||
            delivery.tripId !== null
          : delivery.state === 'loading' || delivery.state === 'unloading'),
    ) ||
    (includeTrips &&
      state.life.trips.some(trip => ids.has(trip.fromId) || ids.has(trip.toId)))
  );
}

function clearHistory(
  draft: MutableRegion,
  removed: ReadonlySet<string>,
): void {
  draft.life.deliveries = draft.life.deliveries.filter(
    delivery =>
      !(
        (delivery.state === 'delivered' || delivery.state === 'waiting') &&
        delivery.cargo === 0 &&
        delivery.tripId === null &&
        ((delivery.sourceId !== null && removed.has(delivery.sourceId)) ||
          removed.has(delivery.targetId))
      ),
  );
}

function dropRoad(draft: MutableRegion, id: string): void {
  const entries = new Set(
    draft.externalEntries
      .filter(entry => entry.roadId === id)
      .map(entry => entry.id),
  );

  draft.roads = draft.roads.filter(road => road.id !== id);
  draft.settlements = draft.settlements.filter(
    settlement => settlement.townHall?.roadId !== id,
  );
  draft.externalEntries = draft.externalEntries.filter(
    entry => entry.roadId !== id,
  );
  draft.life.closingRoadIds = draft.life.closingRoadIds.filter(
    roadId => roadId !== id,
  );
  draft.roadRevision++;
  clearHistory(draft, entries);
  const refreshed = refreshAccess(draft);

  draft.parcels = refreshed.parcels;
  draft.warehouses = refreshed.warehouses;
}

function hallHasLots(state: RegionState, roadId: string): boolean {
  const hall = state.settlements.find(
    settlement => settlement.townHall?.roadId === roadId,
  );

  return (
    hall !== undefined &&
    [...state.parcels, ...state.warehouses].some(
      lot => lot.settlementId === hall.id,
    )
  );
}

/** Called after arrivals are applied, so existing journeys keep their road until completion. */
export function finishRoadClosures(draft: MutableRegion): void {
  for (const id of [...draft.life.closingRoadIds]) {
    const entries = new Set(
      draft.externalEntries
        .filter(entry => entry.roadId === id)
        .map(entry => entry.id),
    );

    if (
      hallHasLots(draft, id) ||
      entryBusy(draft, entries, true) ||
      draft.life.trips.some(trip => trip.route.roadIds.includes(id))
    ) {
      continue;
    }

    dropRoad(draft, id);
    draft.revision++;
  }
}

/** Commands copy life only when a successful removal needs to change durable records. */
export function removeRegionalObject(
  state: RegionState,
  selectedId: string,
): RemovalResult {
  const building = state.life.buildings.find(
    value => value.id === selectedId || value.lotId === selectedId,
  );
  const id = building?.lotId ?? selectedId;
  const hall = state.settlements.find(
    value => value.id === id || value.townHall?.roadId === id,
  );
  const roadId =
    hall?.townHall?.roadId ??
    (state.roads.some(road => road.id === id) ? id : undefined);

  if (
    hall &&
    [...state.parcels, ...state.warehouses].some(
      lot => lot.settlementId === hall.id,
    )
  ) {
    return {reason: 'has-parcels'};
  }
  if (roadId !== undefined) {
    const entries = new Set(
      state.externalEntries
        .filter(entry => entry.roadId === roadId)
        .map(entry => entry.id),
    );

    if (entryBusy(state, entries, false)) {
      return {reason: 'busy-entry'};
    }

    const draft: MutableRegion = {...state, life: structuredClone(state.life)};
    const occupied = state.life.trips.some(
      trip =>
        trip.route.roadIds.includes(roadId) ||
        entries.has(trip.fromId) ||
        entries.has(trip.toId),
    );

    if (occupied) {
      if (!draft.life.closingRoadIds.includes(roadId)) {
        draft.life.closingRoadIds.push(roadId);
        draft.roadRevision++;
      }

      return {state: refreshAccess(draft)};
    }
    if (entryBusy(state, entries, true)) {
      return {reason: 'busy-entry'};
    }

    dropRoad(draft, roadId);

    return {state: draft};
  }
  if (hall) {
    return {
      state: {
        ...state,
        settlements: state.settlements.filter(value => value.id !== hall.id),
      },
    };
  }
  if (state.externalEntries.some(entry => entry.id === id)) {
    const removed = new Set([id]);

    if (entryBusy(state, removed, true)) {
      return {reason: 'busy-entry'};
    }

    const draft: MutableRegion = {
      ...state,
      life: structuredClone(state.life),
      externalEntries: state.externalEntries.filter(entry => entry.id !== id),
    };

    clearHistory(draft, removed);
    draft.roadRevision++;

    return {state: draft};
  }
  if (
    !state.parcels.some(lot => lot.id === id) &&
    !state.warehouses.some(lot => lot.id === id)
  ) {
    return {reason: 'not-found'};
  }
  if (building && buildingOccupied(state, building)) {
    return {reason: 'occupied-building'};
  }

  const draft: MutableRegion = {
    ...state,
    parcels: state.parcels.filter(lot => lot.id !== id),
    warehouses: state.warehouses.filter(lot => lot.id !== id),
    life: structuredClone(state.life),
  };

  if (building) {
    const owner =
      draft.life.families.find(family => family.id === building.ownerId) ??
      draft.life.investors.find(investor => investor.id === building.ownerId);

    if (owner) {
      owner.cash += building.cash;
    } else if (building.ownerId === 'region') {
      draft.cash += building.cash;
    } else {
      draft.life.economy.externalMoney += building.cash;
    }

    for (const family of draft.life.families) {
      if (family.homeId === building.id) {
        family.homeId = null;
        family.reason = 'waiting-home';
      }
    }

    draft.life.buildings = draft.life.buildings.filter(
      value => value.id !== building.id,
    );
    clearHistory(draft, new Set([building.id]));
  }

  return {state: draft};
}
