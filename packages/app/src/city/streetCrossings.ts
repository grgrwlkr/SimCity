import {CITY_ROAD_CENTERS} from './trafficRoutes';
import type {Batch} from './primitives';

export const CROSSWALK_OFFSET = 4.45;
export interface StreetCrossing {
  x: number;
  z: number;
  axis: 'x' | 'z';
}

export function streetCrossings(
  arrival = false,
  roads = CITY_ROAD_CENTERS,
): StreetCrossing[] {
  return roads.flatMap((z, row) =>
    roads.flatMap((x, col): StreetCrossing[] => [
      ...(row > 0 ? [{x, z: z - CROSSWALK_OFFSET, axis: 'x' as const}] : []),
      ...(row < roads.length - 1
        ? [{x, z: z + CROSSWALK_OFFSET, axis: 'x' as const}]
        : []),
      ...(col > 0 || (arrival && z === -85)
        ? [{x: x - CROSSWALK_OFFSET, z, axis: 'z' as const}]
        : []),
      ...(col < roads.length - 1
        ? [{x: x + CROSSWALK_OFFSET, z, axis: 'z' as const}]
        : []),
    ]),
  );
}

export function addStreetCrossings(
  batch: Pick<Batch, 'add'>,
  arrival = false,
  roads = CITY_ROAD_CENTERS,
): void {
  for (const crossing of streetCrossings(arrival, roads)) {
    for (let stripe = 0; stripe < 10; stripe++) {
      const along = -3.6 + stripe * 0.8;
      const acrossX = crossing.axis === 'x';

      batch.add(
        'box',
        'white',
        crossing.x + (acrossX ? along : 0),
        0.874,
        crossing.z + (acrossX ? 0 : along),
        acrossX ? 0.5 : 2.1,
        0.02,
        acrossX ? 2.1 : 0.5,
      );
    }
  }
}
