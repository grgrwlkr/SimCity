import {normalizePoint, rectangle} from './geometry';
import {
  TOWN_HALL_DEPTH,
  TOWN_HALL_ROAD_LENGTH,
  TOWN_HALL_ROAD_OFFSET,
  TOWN_HALL_WIDTH,
} from './rules';
import type {Point, Settlement} from './types';

export function townHallRoadPoints(
  center: Point,
  heading = 0,
): readonly Point[] {
  return [-1, 1].map(side => {
    const x = (side * TOWN_HALL_ROAD_LENGTH) / 2;
    const z = TOWN_HALL_ROAD_OFFSET;

    return normalizePoint({
      x: center.x + Math.cos(heading) * x + Math.sin(heading) * z,
      z: center.z - Math.sin(heading) * x + Math.cos(heading) * z,
    });
  });
}

export function townHallReservation(
  settlement: Pick<Settlement, 'center' | 'townHall'>,
): readonly Point[] {
  return settlement.townHall
    ? rectangle(
        settlement.center,
        TOWN_HALL_WIDTH,
        TOWN_HALL_DEPTH,
        settlement.townHall.heading,
      )
    : [];
}
