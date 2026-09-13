// Stage 3½: the size a vehicle cube is drawn at by its kind. The cube is a car; a truck is as long as a truck, a little
// wider and taller, and a pedestrian is a dot of a person's size.
import { PARKED_TRUCK_KIND, PEDESTRIAN_KIND, TRUCK_KIND } from '@simcity/bridge';
import { CAR_LENGTH_METERS, TRUCK_LENGTH_METERS, VEHICLE_LENGTH_TILES, VEHICLE_WIDTH_TILES } from '@simcity/sim';

type Scale = readonly [length: number, width: number, height: number];

const CAR: Scale = [1, 1, 1];
const TRUCK: Scale = [TRUCK_LENGTH_METERS / CAR_LENGTH_METERS, 1.1, 1.6];
/** A person seen from above: about a metre and a half across, tiles of ten metres. */
const PERSON_TILES = 0.12;
const PEDESTRIAN: Scale = [PERSON_TILES / VEHICLE_LENGTH_TILES, PERSON_TILES / VEHICLE_WIDTH_TILES, 0.8];

/** Length, width and height against the car cube. */
export function vehicleScale(kind: number): Scale {
  if (kind === TRUCK_KIND || kind === PARKED_TRUCK_KIND) return TRUCK;
  return kind === PEDESTRIAN_KIND ? PEDESTRIAN : CAR;
}
