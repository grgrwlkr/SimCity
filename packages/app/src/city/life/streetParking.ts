import {CITY_ROAD_WIDTH} from '../trafficRoutes';
import type {CityLayout} from '../generator';
import type {Point} from './types';
import {CROSSWALK_OFFSET} from '../streetCrossings';
import {gridForLayout} from '../cityGrid';

export const CURB_PARKING = {
  width: 2.1,
  placeLength: 5.8,
  pavedLength: 14.8,
  sidewalkWidth: 1.4,
  centerOffset: CITY_ROAD_WIDTH / 2 + 2.1 / 2,
  sidewalkOffset: CITY_ROAD_WIDTH / 2 + 2.1 + 1.4 / 2,
  laneOffset: CITY_ROAD_WIDTH / 4,
} as const;
export interface StreetParkingSegment {
  id: string;
  center: Point;
  direction: number;
  blockId: string | null;
  sidewalk: Point[];
}

/** Parking is a side of a street segment. Empty land and park edges have room for
 * its pavement; occupied plots, crossings and the waterfront are kept clear. */
export function streetParkingSegments(
  layout: CityLayout,
): StreetParkingSegment[] {
  const roads = gridForLayout(layout).roads;
  const result: StreetParkingSegment[] = [];
  const add = (
    x: number,
    z: number,
    direction: number,
    dx: number,
    dz: number,
    half: number,
    blockId: string | null,
  ) => {
    const rx = -dz;
    const rz = dx;
    const at = (along: number, across: number): Point => ({
      x: x + dx * along + rx * across,
      z: z + dz * along + rz * across,
      y: 1.07,
    });

    result.push({
      id: `street/${x}/${z}/${direction}`,
      center: {x, z, y: 0.91},
      direction,
      blockId,
      sidewalk: [
        at(-half + CROSSWALK_OFFSET, CROSSWALK_OFFSET),
        at(-9, CURB_PARKING.sidewalkOffset),
        at(9, CURB_PARKING.sidewalkOffset),
        at(half - CROSSWALK_OFFSET, CROSSWALK_OFFSET),
      ],
    });
  };

  for (const z of roads) {
    for (let i = 1; i < roads.length; i++) {
      const x = (roads[i - 1]! + roads[i]!) / 2;
      const half = (roads[i]! - roads[i - 1]!) / 2;

      for (const side of [-1, 1]) {
        const neighbour = layout.blocks.find(
          b => b.x === x && b.z === z + side * half,
        );

        if (
          neighbour &&
          neighbour.district !== 'park' &&
          !(z === -119 && side < 0 && neighbour.district === 'railway')
        ) {
          continue;
        }
        if (!neighbour && side > 0) {
          continue;
        } // The south edge is a quay, not buildable land.

        add(x, z, side > 0 ? 0 : 2, side, 0, half, neighbour?.id ?? null);
      }
    }
  }

  for (const x of roads) {
    for (let i = 1; i < roads.length; i++) {
      const z = (roads[i - 1]! + roads[i]!) / 2;
      const half = (roads[i]! - roads[i - 1]!) / 2;

      for (const side of [-1, 1]) {
        const neighbour = layout.blocks.find(
          b => b.x === x + side * half && b.z === z,
        );

        if (
          neighbour &&
          !(x === -119 && side < 0 && neighbour.district === 'park')
        ) {
          continue;
        }

        add(x, z, side > 0 ? 3 : 1, 0, -side, half, neighbour?.id ?? null);
      }
    }
  }

  return result.sort(
    (a, b) =>
      Number(a.blockId !== null) - Number(b.blockId !== null) ||
      a.direction - b.direction ||
      a.center.x - b.center.x ||
      a.center.z - b.center.z,
  );
}
