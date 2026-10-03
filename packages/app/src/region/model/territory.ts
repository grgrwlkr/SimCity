import {EPSILON} from './geometry';
import {TOWN_HALL_LEVELS} from './rules';
import type {Point, RegionState, Settlement} from './types';

export function townHallLevel(settlement: Settlement): number {
  return settlement.townHall?.level ?? 1;
}

export function cityRadius(settlement: Settlement): number {
  return TOWN_HALL_LEVELS[townHallLevel(settlement) - 1]!.radius;
}

export function isWithinSettlement(
  settlement: Settlement,
  contour: readonly Point[],
): boolean {
  const radius = cityRadius(settlement) + EPSILON;

  return contour.every(
    point =>
      (point.x - settlement.center.x) ** 2 +
        (point.z - settlement.center.z) ** 2 <=
      radius ** 2,
  );
}

export function townHallUpgrade(
  state: RegionState,
  settlementId: string,
): {
  level: number;
  radius: number;
  cost: number;
  requiredParcels: number;
  preparedParcels: number;
} | null {
  const settlement = state.settlements.find(s => s.id === settlementId);

  if (!settlement?.townHall) {
    return null;
  }

  const next = TOWN_HALL_LEVELS[townHallLevel(settlement)];

  if (!next) {
    return null;
  }

  const lots = new Map(
    [...state.parcels, ...state.warehouses].map(lot => [lot.id, lot]),
  );
  const roads = new Set(
    state.roads
      .filter(road => !state.life.closingRoadIds.includes(road.id))
      .map(road => road.id),
  );

  return {
    ...next,
    preparedParcels: state.life.buildings.filter(building => {
      if (
        building.stage !== 'ready' ||
        building.settlementId !== settlement.id
      ) {
        return false;
      }

      const lot = lots.get(building.lotId);

      return (
        lot?.settlementId === settlement.id &&
        lot.access !== null &&
        lot.access !== undefined &&
        roads.has(lot.access.roadId)
      );
    }).length,
  };
}
