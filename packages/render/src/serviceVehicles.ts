// The body of a service vehicle and a bus, after `spawn_service_vehicle` and `car_body_quad` of
// crates/simcity_sim/src/game/services/systems.rs and public_transport.rs: the shared car mesh of a car's footprint, tinted by
// the kind's colour, at scale 1 so the glyph on its roof keeps its shape.
import { VEHICLE_LENGTH_TILES, VEHICLE_WIDTH_TILES, type ServiceKind } from '@simcity/sim';
import type { CompositeMesh, MaterialSpec, RenderPrimitives } from './renderPrimitives';

type Rgb = readonly [number, number, number];

/** `ServiceKind::vehicle_color`, sRGB 0..1. */
export const SERVICE_VEHICLE_COLORS: Readonly<Record<ServiceKind, Rgb>> = {
  Fire: [0.9, 0.2, 0.1],
  Police: [0.1, 0.3, 0.9],
  Medical: [0.1, 0.8, 0.2],
};

/** `BUS_COLOR` of public_transport.rs. */
export const BUS_COLOR: Rgb = [0.9, 0.7, 0.2];

export interface VehicleBody {
  readonly mesh: CompositeMesh;
  readonly material: MaterialSpec;
  readonly scale: readonly [number, number, number];
}

/** The body of a `kind` vehicle on tiles of `tileSize`. */
export function serviceVehicleBody(prims: RenderPrimitives, tileSize: number, kind: ServiceKind): VehicleBody {
  return { mesh: prims.carMesh(tileSize * VEHICLE_LENGTH_TILES, tileSize * VEHICLE_WIDTH_TILES), material: prims.material(SERVICE_VEHICLE_COLORS[kind]), scale: [1, 1, 1] };
}
