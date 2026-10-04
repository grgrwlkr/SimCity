import {CITY_GRID} from './cityGrid';

export const RAILWAY_Z = -136;
export const RAILWAY_TRACKS = [-138.4, -133.6] as const;
export const RAILWAY_STATION_X = -34;
export const RAILWAY_STATION_EXIT = {x: -24, z: -126.5} as const;
export const RAILWAY_CAR_LENGTH = 5.2;
export const RAILWAY_CAR_GAP = 0.4;
export const RAILWAY_CAR_WIDTH = 2.1;
export const RAILWAY_CAR_COUNT = 4;
export const RAILWAY_TRAIN_LENGTH =
  RAILWAY_CAR_LENGTH * RAILWAY_CAR_COUNT +
  RAILWAY_CAR_GAP * (RAILWAY_CAR_COUNT - 1);
export const RAILWAY_SPEED = 7;
export const RAILWAY_DWELL_SECONDS = 18;
export const RAILWAY_INTERVAL_SECONDS = 220;
export const RAILWAY_ROAD_CENTERS = CITY_GRID.roads;
export const RAILWAY_PLATFORM_LENGTH = 26;
export const RAILWAY_CROSSING_HALF_WIDTH = 5.5;
export const RAILWAY_CROSSING_HALF_DEPTH = 9;

export interface RailwayCrossingLayout {
  id: number;
  x: number;
  z: number;
  yaw?: number;
  halfWidth?: number;
  halfDepth?: number;
}

export function railwayCrossings(
  roads: readonly number[] = RAILWAY_ROAD_CENTERS,
): RailwayCrossingLayout[] {
  return roads.map((x, id) => ({id, x, z: RAILWAY_Z}));
}

/** Original south platform or north footbridge path, in the station's native frame. */
export function railwayArrivalChain(
  direction: 1 | -1,
): Array<{x: number; z: number; y?: number}> {
  const y = 1.4;

  return direction === 1
    ? [
        {x: -34, z: -130, y},
        {x: -24, z: -130, y},
        {x: -24, z: -126.5},
        {x: -24, z: -123.45},
      ]
    : [
        {x: -34, z: -142, y},
        {x: -33.7, z: -142, y},
        {x: -44.5, z: -142, y: 7.35},
        {x: -44.5, z: -130, y: 7.35},
        {x: -33.7, z: -130, y},
        {x: -24, z: -130, y},
        {x: -24, z: -126.5},
        {x: -24, z: -123.45},
      ];
}
