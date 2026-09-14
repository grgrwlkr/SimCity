// Port of `visual_tests` in crates/simcity_sim/src/game/services/systems.rs, and the look of the city's buses beside it.
import { AMBULANCE_KIND, BUS_KIND, FIRE_KIND, POLICE_KIND } from '@simcity/bridge';
import { BUS_LENGTH_METERS, CAR_LENGTH_METERS, VEHICLE_LENGTH_TILES, VEHICLE_WIDTH_TILES } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { VEHICLE_COLORS } from '../src/palette';
import { RenderPrimitives } from '../src/renderPrimitives';
import { SERVICE_VEHICLE_COLORS, serviceVehicleBody } from '../src/serviceVehicles';
import { vehicleScale } from '../src/vehicleLook';

describe('service vehicles', () => {
  it('serviceVehicleRendersAsColoredCarNotDot', () => {
    const prims = new RenderPrimitives();
    const tileSize = 16;
    const body = serviceVehicleBody(prims, tileSize, 'Fire');
    expect(body.mesh, 'service body must be the shared volumetric car mesh').toBe(prims.carMesh(tileSize * VEHICLE_LENGTH_TILES, tileSize * VEHICLE_WIDTH_TILES));
    expect(body.scale, 'car body uses a sized mesh, scale must stay 1 for the glyph children').toEqual([1, 1, 1]);
    // The cache quantizes to 8-bit RGBA: within one quantum of the kind's colour.
    const want = SERVICE_VEHICLE_COLORS.Fire;
    body.material.color.slice(0, 3).forEach((channel, i) => expect(Math.abs(channel / 255 - want[i]!), `channel ${i}`).toBeLessThan(1.5 / 255));
  });

  // Not a Rust test: the debug renderer draws them as the cubes of their kinds.
  it('busesAndServiceVehiclesAreDrawnInTheirOwnColoursAndSizes', () => {
    expect(vehicleScale(BUS_KIND)[0]).toBeCloseTo(BUS_LENGTH_METERS / CAR_LENGTH_METERS, 5);
    for (const kind of [FIRE_KIND, POLICE_KIND, AMBULANCE_KIND]) expect(vehicleScale(kind), 'a service vehicle is a car').toEqual([1, 1, 1]);
    const colours = [0, BUS_KIND, FIRE_KIND, POLICE_KIND, AMBULANCE_KIND].map((kind) => String(VEHICLE_COLORS[kind]));
    expect(new Set(colours).size, 'each in a colour of its own').toBe(5);
    const u8 = (c: readonly [number, number, number]) => c.map((v) => Math.round(v * 255)).join(',');
    expect(String(VEHICLE_COLORS[FIRE_KIND])).toBe(u8(SERVICE_VEHICLE_COLORS.Fire));
    expect(String(VEHICLE_COLORS[POLICE_KIND])).toBe(u8(SERVICE_VEHICLE_COLORS.Police));
    expect(String(VEHICLE_COLORS[AMBULANCE_KIND])).toBe(u8(SERVICE_VEHICLE_COLORS.Medical));
  });
});
