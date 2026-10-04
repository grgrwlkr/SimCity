import type {AuthoredWorldDefinition} from './definition';
import type {LifeProfile, ParkingSlot} from './types';
import type {Population} from './population';

/** Prepare stable native IDs and reject destructive changes before mutation. */
export function reconcileWorldDefinition(
  current: LifeProfile,
  slots: readonly ParkingSlot[],
  population: Population,
  next: AuthoredWorldDefinition,
  tripsActive: boolean,
): AuthoredWorldDefinition {
  const profile = structuredClone(next.profile);
  const removed = current.places.filter(
    place => !profile.places.some(other => other.id === place.id),
  );

  for (const place of removed) {
    if (
      population.people.some(
        person =>
          person.location === place.id ||
          person.trip?.destination === place.id ||
          person.job?.building === place.id,
      ) ||
      population.units.some(
        unit =>
          unit.building === place.id &&
          (unit.owner !== null || unit.tenant !== null),
      ) ||
      population.businesses.some(
        business =>
          business.building === place.id &&
          (business.stock || business.balance || business.workers.length),
      )
    ) {
      throw new Error('Нельзя удалить занятое здание или имущество');
    }
  }

  for (const place of profile.places) {
    const prior = current.places.find(other => other.id === place.id);

    if (
      prior &&
      (prior.kind !== place.kind ||
        prior.capacity !== place.capacity ||
        prior.door.x !== place.door.x ||
        prior.door.z !== place.door.z)
    ) {
      throw new Error('Нельзя перестраивать существующий нативный адрес');
    }
  }

  const facilities = structuredClone(current.facilities);
  const registrySlots = structuredClone(current.slots);
  const facilityMap = new Map<number, number>();

  for (const facility of profile.facilities) {
    const existing = facilities.find(
      other => other.key === facility.key && facility.key !== undefined,
    );
    const id = existing?.id ?? facilities.length;
    const mapped = {...facility, id, slots: [] as number[]};

    facilityMap.set(facility.id, id);

    for (const oldId of facility.slots) {
      const slot = profile.slots[oldId]!;
      const prior = registrySlots.find(
        other => other.key === slot.key && slot.key !== undefined,
      );
      const slotId = prior?.id ?? registrySlots.length;

      if (
        prior &&
        (prior.position.x !== slot.position.x ||
          prior.position.z !== slot.position.z) &&
        slots[slotId] &&
        (slots[slotId].occupant !== null || slots[slotId].reserved !== null)
      ) {
        throw new Error('Нельзя переместить занятую парковку');
      }

      const mappedSlot = {...slot, id: slotId, facility: id};

      mapped.slots.push(slotId);
      registrySlots[slotId] = mappedSlot;
    }

    facilities[id] = mapped;
  }

  for (const facility of facilities) {
    if (!profile.facilities.some(other => other.key === facility.key)) {
      if (
        facility.slots.some(
          id =>
            slots[id]?.occupant !== null ||
            slots[id]?.reserved !== null ||
            slots[id]?.household !== null,
        ) ||
        tripsActive
      ) {
        throw new Error('Нельзя удалить занятую парковку');
      }

      facility.slots = [];
    }
  }

  profile.places = profile.places.map(place => ({
    ...place,
    parking:
      place.parking === null ? null : (facilityMap.get(place.parking) ?? null),
  }));
  profile.facilities = facilities;
  profile.slots = registrySlots;
  profile.bays = profile.bays.map(bay => ({
    ...bay,
    facility: facilityMap.get(bay.facility) ?? bay.facility,
  }));
  profile.garageBuildings = Object.fromEntries(
    Object.entries(profile.garageBuildings).map(([id, facility]) => [
      id,
      facilityMap.get(facility)!,
    ]),
  );

  return {
    ...next,
    profile,
    entries: next.entries.map(entry => ({
      ...entry,
      terminalFacilityId:
        facilityMap.get(entry.terminalFacilityId) ?? entry.terminalFacilityId,
    })),
  };
}
