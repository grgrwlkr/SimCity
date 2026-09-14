// Stage 3½: the size a vehicle cube is drawn at by its kind. The cube is a car; a truck is as long as a truck, a little
// wider and taller, and a pedestrian is a dot of a person's size.
import { BUS_KIND, PARKED_TRUCK_KIND, PEDESTRIAN_KIND, TRUCK_KIND } from '@simcity/bridge';
import { BUS_LENGTH_METERS, CAR_LENGTH_METERS, TRUCK_LENGTH_METERS, VEHICLE_LENGTH_TILES, VEHICLE_WIDTH_TILES } from '@simcity/sim';

type Scale = readonly [length: number, width: number, height: number];

const CAR: Scale = [1, 1, 1];
const TRUCK: Scale = [TRUCK_LENGTH_METERS / CAR_LENGTH_METERS, 1.1, 1.6];
const BUS: Scale = [BUS_LENGTH_METERS / CAR_LENGTH_METERS, 1.15, 1.5];
/** A person seen from above: about a metre and a half across, tiles of ten metres. */
const PERSON_TILES = 0.12;
const PEDESTRIAN: Scale = [PERSON_TILES / VEHICLE_LENGTH_TILES, PERSON_TILES / VEHICLE_WIDTH_TILES, 0.8];

/** A pedestrian is never drawn narrower than this many pixels. */
const MIN_PEDESTRIAN_PIXELS = 3;

/** Length, width and height against the car cube. */
export function vehicleScale(kind: number): Scale {
  if (kind === TRUCK_KIND || kind === PARKED_TRUCK_KIND) return TRUCK;
  if (kind === BUS_KIND) return BUS;
  return kind === PEDESTRIAN_KIND ? PEDESTRIAN : CAR;
}

/** The scale drawn at a zoom of `worldPerPixel`: a pedestrian grows to stay a few pixels wide, everything else keeps its size. */
export function drawnScale(kind: number, tileSize: number, worldPerPixel: number): Scale {
  const scale = vehicleScale(kind);
  if (kind !== PEDESTRIAN_KIND) return scale;
  const grow = Math.max((MIN_PEDESTRIAN_PIXELS * worldPerPixel) / (scale[1] * VEHICLE_WIDTH_TILES * tileSize), 1);
  return [scale[0] * grow, scale[1] * grow, scale[2]];
}
