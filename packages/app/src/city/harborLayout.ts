import { vehicleKit, type VehicleKit } from './assetKits';
import { createLaneRoute } from './trafficRoutes';
import type { JunctionBounds } from './trafficFlow';

export const AMBIENT_VEHICLES = 112;
export const BERTHS = [72, 104] as const;
export const WAREHOUSES = [
  { x: 68, z: 68, blockId: 'block-5-5', buildingId: 'building-5-5-0-0', forecourtId: 'building-5-5-0-1', name: 'Склад «Северный»' },
  { x: 102, z: 102, blockId: 'block-6-6', buildingId: 'building-6-6-0-0', forecourtId: 'building-6-6-0-1', name: 'Склад «Причальный»' },
] as const;
export const CARGO_CAPACITY = 64;
export const CARGO_HEIGHT = 1.9;
export const CARGO_SCALE = { x: 1.75 / 4.2, y: CARGO_HEIGHT / 2.4, z: 4.8 / 5.5 };
// Reserve the driveway mouth together with its downstream junction, before a trailer starts turning.
export const FREIGHT_JUNCTIONS: readonly JunctionBounds[] = [...WAREHOUSES.flatMap((yard) => [yard.x - 17, yard.x + 17].map((x) => ({
  id: ((yard.z + 17 + 119) / 34) * 8 + (x + 119) / 34,
  minX: x - 6, maxX: x + 6, minZ: yard.z, maxZ: yard.z + 23,
}))), ...[51, 85, 119].map((x) => ({
  // The quay turn is too close to the city junction for a separate waiting pocket.
  // One reservation spans both, keeping opposing trucks outside the trailer's sweep.
  id: 7 * 8 + (x + 119) / 34, minX: x - 6, maxX: x + 6, minZ: x === 51 ? 113 : 102, maxZ: 147,
}))];

export const FREIGHT_ROUTES = WAREHOUSES.map((yard, index) => {
  const west = index === 0 ? 51 : 85, east = west + 34;
  const north = yard.z + 4, south = 140;
  const route = createLaneRoute({ west, east, north, south }, 1);
  const warehouseStop = yard.x + 1.2 - (west + 6);
  const portStop = 22 + Math.PI * 4 + (south - north - 12) + (east - 6 - (BERTHS[index]! - 1.2));
  return { route, stops: [warehouseStop, portStop] as const };
});

export function cityVehicleKits(seed: string): VehicleKit[] {
  return [
    ...Array.from({ length: AMBIENT_VEHICLES }, (_, id) => vehicleKit(seed, id)),
    ...Array.from({ length: 4 }, (_, id): VehicleKit => ({ ...vehicleKit(seed, 1000 + id), body: 'truck', roof: 'bare', width: 1.9, length: 8.6 })),
  ];
}
