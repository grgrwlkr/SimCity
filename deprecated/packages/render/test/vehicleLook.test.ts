// Stage 3½: what a vehicle cube is scaled to by its kind — a truck as long as a truck, a pedestrian a dot.
import { PARKED_TRUCK_KIND, PARKED_VEHICLE_KIND, PEDESTRIAN_KIND, TRUCK_KIND } from '@simcity/bridge';
import { CAR_LENGTH_METERS, TRUCK_LENGTH_METERS, VEHICLE_LENGTH_TILES, VEHICLE_WIDTH_TILES } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { VEHICLE_COLORS } from '../src/palette';
import { drawnScale, vehicleScale } from '../src/vehicleLook';

describe('vehicle look', () => {
  it('aTruckIsDrawnAsLongAsATruckAndAPedestrianAsADot', () => {
    expect(vehicleScale(0), 'a car is the cube').toEqual([1, 1, 1]);
    expect(vehicleScale(PARKED_VEHICLE_KIND)).toEqual([1, 1, 1]);
    expect(vehicleScale(TRUCK_KIND)[0]).toBeCloseTo(TRUCK_LENGTH_METERS / CAR_LENGTH_METERS, 5);
    expect(vehicleScale(PARKED_TRUCK_KIND)).toEqual(vehicleScale(TRUCK_KIND));
    const [length, width] = vehicleScale(PEDESTRIAN_KIND);
    expect(length * VEHICLE_LENGTH_TILES, 'a person takes a fraction of a tile').toBeLessThan(0.2);
    expect(width * VEHICLE_WIDTH_TILES).toBeLessThan(0.2);
    const colour = (kind: number) => VEHICLE_COLORS[kind % VEHICLE_COLORS.length];
    expect(new Set([0, TRUCK_KIND, PARKED_TRUCK_KIND, PEDESTRIAN_KIND].map((kind) => String(colour(kind)))).size, 'each in a colour of its own').toBe(4);
  });

  // A person is a metre and a half: at a zoom of the whole city that is a fraction of a pixel, and nobody saw them.
  it('aPedestrianStaysVisibleAtAnyZoom', () => {
    const tileSize = 16;
    const carWidth = tileSize * VEHICLE_WIDTH_TILES;
    const drawnWidth = (worldPerPixel: number) => drawnScale(PEDESTRIAN_KIND, tileSize, worldPerPixel)[1] * carWidth;
    expect(drawnWidth(3.5) / 3.5, 'at the whole map, a few pixels wide').toBeGreaterThanOrEqual(3);
    expect(drawnWidth(0.1), 'close up, a person of its own size').toBeCloseTo(vehicleScale(PEDESTRIAN_KIND)[1] * carWidth, 5);
    expect(drawnScale(0, tileSize, 3.5), 'cars keep their size').toEqual(vehicleScale(0));
  });
});
