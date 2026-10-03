import {
  containsPoint,
  convexInteriorsOverlap,
  distance,
  isDryFootprint,
  normalizePoint,
  polygonsOverlap,
  rectangle,
} from './geometry';
import {nearestRoadAccess, roadContour} from './roads';
import {
  PARCEL_DEPTH,
  PARCEL_WIDTH,
  WAREHOUSE_DEPTH,
  WAREHOUSE_WIDTH,
  ROAD_SIDEWALK_WIDTH,
} from './rules';
import type {
  Bounds,
  Parcel,
  Point,
  RegionState,
  Settlement,
  Warehouse,
} from './types';
import {isWithinSettlement} from './territory';
import {townHallReservation} from './townHall';

export type ParcelDraft = Omit<Parcel, 'id' | 'settlementId' | 'zone'>;
export type WarehouseDraft = Omit<Warehouse, 'id' | 'settlementId'>;

export function occupiedContours(
  state: RegionState,
): ReadonlyArray<readonly Point[]> {
  return [
    ...state.settlements.filter(s => s.townHall).map(townHallReservation),
    ...state.parcels.map(p => rectangle(p.center, p.width, p.depth, p.heading)),
    ...state.warehouses.map(p =>
      rectangle(p.center, WAREHOUSE_WIDTH, WAREHOUSE_DEPTH, p.heading),
    ),
  ];
}

function intersectsLots(
  state: RegionState,
  center: Point,
  width: number,
  depth: number,
  heading: number,
): boolean {
  const contour = rectangle(center, width, depth, heading);

  return occupiedContours(state).some(p => convexInteriorsOverlap(contour, p));
}

export function zoneCandidates(
  state: RegionState,
  selection: Bounds,
  settlement?: Settlement,
): readonly ParcelDraft[] {
  const result: ParcelDraft[] = [];

  for (const road of state.roads) {
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!;
      const b = road.points[i]!;
      const length = distance(a, b);
      const ux = (b.x - a.x) / length;
      const uz = (b.z - a.z) / length;

      for (const side of [-1, 1]) {
        for (
          let offset = PARCEL_WIDTH / 2;
          offset <= length - PARCEL_WIDTH / 2;
          offset += PARCEL_WIDTH
        ) {
          const center = normalizePoint({
            x: a.x + ux * offset - uz * side * (6 + PARCEL_DEPTH / 2),
            z: a.z + uz * offset + ux * side * (6 + PARCEL_DEPTH / 2),
          });

          if (!containsPoint(selection, center)) {
            continue;
          }

          const heading = -Math.atan2(uz, ux) + (side > 0 ? Math.PI : 0);
          const contour = rectangle(
            center,
            PARCEL_WIDTH,
            PARCEL_DEPTH,
            heading,
          );

          if (settlement && !isWithinSettlement(settlement, contour)) {
            continue;
          }
          if (!isDryFootprint(state.terrain, contour)) {
            continue;
          }

          const existing = state.parcels.find(
            p => distance(p.center, center) < 0.01,
          );

          if (
            !existing &&
            intersectsLots(state, center, PARCEL_WIDTH, PARCEL_DEPTH, heading)
          ) {
            continue;
          }
          if (
            state.roads.some(r =>
              polygonsOverlap(
                contour,
                roadContour(
                  r.points,
                  state.rules.roadWidth + 2 * ROAD_SIDEWALK_WIDTH,
                ),
              ),
            )
          ) {
            continue;
          }
          if (
            result.some(p =>
              convexInteriorsOverlap(
                contour,
                rectangle(p.center, p.width, p.depth, p.heading),
              ),
            )
          ) {
            continue;
          }

          result.push({
            center,
            heading,
            width: PARCEL_WIDTH,
            depth: PARCEL_DEPTH,
            access: {roadId: road.id, segment: i - 1, offset: offset / length},
          });
        }
      }
    }
  }

  return result;
}

export function warehouseDraft(
  state: RegionState,
  point: Point,
): WarehouseDraft | null {
  const access = nearestRoadAccess(state.roads, point, 60);

  if (!access) {
    return null;
  }

  const road = state.roads.find(r => r.id === access.roadId)!;
  const a = road.points[access.segment]!;
  const b = road.points[access.segment + 1]!;
  const length = distance(a, b);
  const ux = (b.x - a.x) / length;
  const uz = (b.z - a.z) / length;
  const anchor = {
    x: a.x + (b.x - a.x) * access.offset,
    z: a.z + (b.z - a.z) * access.offset,
  };
  const side =
    (point.x - anchor.x) * -uz + (point.z - anchor.z) * ux >= 0 ? 1 : -1;
  const center = normalizePoint({
    x: anchor.x - uz * side * (6 + WAREHOUSE_DEPTH / 2),
    z: anchor.z + ux * side * (6 + WAREHOUSE_DEPTH / 2),
  });

  return {
    center,
    heading: -Math.atan2(uz, ux) + (side > 0 ? Math.PI : 0),
    access,
  };
}

export function refreshAccess(state: RegionState): RegionState {
  const roads = state.roads.filter(
    road => !state.life.closingRoadIds.includes(road.id),
  );

  return {
    ...state,
    parcels: state.parcels.map(p => ({
      ...p,
      access: nearestRoadAccess(
        roads,
        frontagePoint(p.center, p.heading, p.depth),
        6 + state.rules.snapDistance,
      ),
    })),
    warehouses: state.warehouses.map(p => ({
      ...p,
      access: nearestRoadAccess(
        roads,
        frontagePoint(p.center, p.heading, WAREHOUSE_DEPTH),
        6 + state.rules.snapDistance,
      ),
    })),
  };
}

export function frontagePoint(
  center: Point,
  heading: number,
  depth: number,
): Point {
  return {
    x: center.x + (Math.sin(heading) * depth) / 2,
    z: center.z + (Math.cos(heading) * depth) / 2,
  };
}
