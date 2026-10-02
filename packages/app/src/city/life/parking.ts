import { distance } from './network';
import type { Household, LifePlace, LifeProfile, ParkingSlot } from './types';

export class ParkingBook {
  readonly slots: ParkingSlot[];
  constructor(readonly profile: LifeProfile) {
    this.slots = structuredClone(profile.slots);
  }
  canUse(slot: ParkingSlot, household: number, homeBlock: string): boolean {
    const f = this.profile.facilities[slot.facility]!;
    if (slot.household !== null && slot.household !== household) {
      return false;
    }
    if (f.kind === 'private') {
      return slot.household === household;
    }
    return !f.residentsOnly || f.blockId === homeBlock;
  }
  available(
    facility: number,
    household: number,
    homeBlock: string,
    car: number | null = null,
  ): ParkingSlot | undefined {
    return this.profile.facilities[facility]!.slots.map((id) => this.slots[id]!).find(
      (s) =>
        this.canUse(s, household, homeBlock) &&
        (s.occupant === null || s.occupant === car) &&
        (s.reserved === null || s.reserved === car),
    );
  }
  reserve(facility: number, car: number, household: number, homeBlock: string): ParkingSlot | undefined {
    const slot = this.available(facility, household, homeBlock, car);
    if (slot) {
      slot.reserved = car;
    }
    return slot;
  }
  leaseHome(family: Household, home: LifePlace): ParkingSlot | undefined {
    if (home.parking === null) {
      const nearby = this.profile.facilities
        .filter((f) => f.kind === 'street' && distance(home.door, f.access.point) < 65)
        .sort((a, b) => distance(home.door, a.access.point) - distance(home.door, b.access.point));
      for (const f of nearby) {
        const slot = this.available(f.id, family.id, home.blockId);
        if (slot) {
          return slot;
        }
      }
      return undefined;
    }
    const facility = this.profile.facilities[home.parking]!;
    const slot = facility.slots
      .map((id) => this.slots[id]!)
      .find((s) => s.occupant === null && s.reserved === null && (s.household === null || s.household === family.id));
    if (slot) {
      slot.household = family.id;
    }
    return slot;
  }
  park(slotId: number, car: number): void {
    const slot = this.slots[slotId];
    if (!slot || (slot.occupant !== null && slot.occupant !== car) || slot.reserved !== car) {
      throw new Error('Parking place is not reserved for this car');
    }
    slot.occupant = car;
    slot.reserved = null;
  }
  leave(car: number): void {
    for (const slot of this.slots) {
      if (slot.occupant === car) {
        slot.occupant = null;
      }
    }
  }
  cancel(car: number): void {
    for (const slot of this.slots) {
      if (slot.reserved === car) {
        slot.reserved = null;
      }
    }
  }
}
