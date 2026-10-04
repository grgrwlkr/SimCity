import {Harbor, freightPlans} from '../harbor';
import type {HarborSupplyProvider, HarborNavigation} from '../harbor';
import {
  ORIGINAL_HARBOR_LAYOUT,
  FREIGHT_JUNCTIONS,
  WAREHOUSES,
  harborVehicleKits,
} from '../harborLayout';
import type {HarborLayout} from '../harborLayout';
import {Railway} from '../railway';
import type {RailwaySave} from '../railway';
import {
  railwayArrivalChain,
  RAILWAY_STATION_EXIT,
  RAILWAY_Z,
} from '../railwayLayout';
import type {RailwayCrossingLayout} from '../railwayLayout';
import {nativePlacementTransform} from '../nativeInfrastructurePlacement';
import type {
  NativePlacementTransform,
  NativeInfrastructurePlacement,
} from '../nativeInfrastructurePlacement';
import {generateCity} from '../generator';
import type {CityBuilding} from '../generator';
import type {LaneRoute} from '../trafficRoutes';
import type {JunctionBounds, TrafficPlan} from '../trafficFlow';
import type {LifeProfile, Point} from './types';
import type {RegionRouting} from './regionRouting';
import type {
  AuthoredPlacement,
  NativePortPlacement,
  NativeRailwayPlacement,
} from './definition';
import type {Road} from '../../region/model/types';

export type AllocateNativeVehicle = (
  size: {length: number; width: number},
  plan: TrafficPlan,
) => number;
export type PortTruckIds = readonly [number, number, number, number];

export interface NativePortConfiguration {
  readonly harbor: Harbor;
  readonly layout: HarborLayout;
  readonly truckIds: PortTruckIds;
  readonly plans: Map<number, TrafficPlan>;
  readonly junctions: Array<JunctionBounds & {key: string}>;
  readonly placement: NativePortPlacement;
  readonly transform: NativePlacementTransform;
}

/** Preserve native line/arc geometry and metre-based speed in a rigid placement. */
export function nativeInfrastructureRoute(
  route: LaneRoute,
  placement: NativeInfrastructurePlacement,
  source: Point,
): LaneRoute {
  const transform = nativePlacementTransform(placement, source);

  return {
    ...route,
    segments: route.segments.map(segment =>
      segment.kind === 'line'
        ? transform.toWorld(transform.vector(segment))
        : {...transform.toWorld(segment), angle: segment.angle - placement.yaw},
    ),
  };
}

const inactiveSupply: HarborSupplyProvider = {
  nextVisit: () => null,
  idle: () => true,
  imports: () => null,
  takeExport: () => null,
  receive: () => false,
  exported: () => false,
};

export function createNativePortConfiguration(
  placement: NativePortPlacement,
  profile: LifeProfile,
  routing: RegionRouting,
  allocateVehicle: AllocateNativeVehicle,
  options: {
    provider?: HarborSupplyProvider;
    navigation?: HarborNavigation;
    restoredTruckIds?: PortTruckIds;
    restoredHarborSave?: ReturnType<Harbor['save']>;
    allocateJunction?: (key: string) => number;
  } = {},
): NativePortConfiguration {
  if (
    placement.warehouseBuildingIds.length !== 2 ||
    placement.warehouseBuildingIds.some(
      id => !profile.places.some(place => place.id === id),
    )
  ) {
    throw new Error('Порту нужны два зарегистрированных нативных склада');
  }

  const source = placement.source ?? {x: 85, z: 135};
  const transform = nativePlacementTransform(placement, {x: 85, z: 135});
  const localPlans = [...freightPlans(ORIGINAL_HARBOR_LAYOUT).values()];
  const worldPlans = localPlans.map(plan => ({
    ...plan,
    route: nativeInfrastructureRoute(plan.route, placement, {x: 85, z: 135}),
  }));
  const sizes = harborVehicleKits(profile.seed);
  const ids = options.restoredTruckIds ?? [
    allocateVehicle(sizes[0]!, worldPlans[0]!),
    allocateVehicle(sizes[1]!, worldPlans[1]!),
    allocateVehicle(sizes[2]!, worldPlans[2]!),
    allocateVehicle(sizes[3]!, worldPlans[3]!),
  ];
  const truckIds: PortTruckIds = [ids[0], ids[1], ids[2], ids[3]];
  const layout: HarborLayout = {...ORIGINAL_HARBOR_LAYOUT, truckIds};
  const plans = new Map(truckIds.map((id, index) => [id, worldPlans[index]!]));
  const junctions = FREIGHT_JUNCTIONS.map(box => {
    const sourceIndex = FREIGHT_JUNCTIONS.findIndex(
      candidate => candidate.id === box.id,
    );
    const key = `${placement.id}/junction/${sourceIndex}`;
    const corners = [
      transform.toWorld({x: box.minX, z: box.minZ}),
      transform.toWorld({x: box.maxX, z: box.minZ}),
      transform.toWorld({x: box.maxX, z: box.maxZ}),
      transform.toWorld({x: box.minX, z: box.maxZ}),
    ];

    return {
      id: options.allocateJunction?.(key) ?? routing.allocateJunction(key),
      key,
      minX: Math.min(...corners.map(point => point.x)),
      maxX: Math.max(...corners.map(point => point.x)),
      minZ: Math.min(...corners.map(point => point.z)),
      maxZ: Math.max(...corners.map(point => point.z)),
      oriented: {
        center: placement.center,
        yaw: placement.yaw,
        minX: box.minX - source.x,
        maxX: box.maxX - source.x,
        minZ: box.minZ - source.z,
        maxZ: box.maxZ - source.z,
      },
    };
  });
  const harbor = new Harbor({
    layout,
    placement,
    provider: options.provider ?? inactiveSupply,
    ...((options.navigation ?? placement.navigation)
      ? {navigation: options.navigation ?? placement.navigation}
      : {}),
  });

  if (options.restoredHarborSave) {
    harbor.restore(options.restoredHarborSave);
  }

  return {harbor, layout, truckIds, plans, junctions, placement, transform};
}

export function createNativePortWarehousePlacements(
  seed: string,
  placement: NativePortPlacement,
): AuthoredPlacement[] {
  const layout = generateCity(seed);
  const transform = nativePlacementTransform(placement, {x: 85, z: 135});

  return WAREHOUSES.map((warehouse, index) => {
    const template = layout.buildings.find(
      building => building.id === warehouse.buildingId,
    );
    const id = placement.warehouseBuildingIds[index];

    if (!template || !id) {
      throw new Error('Нет исходного здания склада порта');
    }

    return {
      id,
      municipalityId: placement.id,
      template,
      sourceBlock: layout.blocks.find(block => block.id === template.blockId)!,
      center: transform.toWorld({x: template.x, z: template.z}),
      yaw: placement.yaw,
      kind: 'factory',
      name: template.name,
    };
  });
}

export function nativePortRoads(placement: NativePortPlacement): Road[] {
  const transform = nativePlacementTransform(placement, {x: 85, z: 135});
  const paths: Point[][] = [
    [
      {x: 51, z: 55},
      {x: 51, z: 140},
    ],
    [
      {x: 85, z: 55},
      {x: 85, z: 140},
    ],
    [
      {x: 119, z: 89},
      {x: 119, z: 140},
    ],
    [
      {x: 51, z: 72},
      {x: 85, z: 72},
    ],
    [
      {x: 85, z: 106},
      {x: 119, z: 106},
    ],
    [
      {x: 51, z: 140},
      {x: 119, z: 140},
    ],
  ];

  return paths.map((points, index) => ({
    id: `${placement.id}/road/${index}`,
    points: points.map(point => transform.toWorld(point)),
  }));
}

export interface NativeRailwayConfiguration {
  readonly railway: Railway;
  readonly station: Point;
  readonly exit: Point;
  readonly crossings: RailwayCrossingLayout[];
  readonly placement: NativeRailwayPlacement;
  readonly transform: NativePlacementTransform;
  arrivalChain(direction: 1 | -1): Point[];
}

export function nativeRailwayCrossings(
  placement: NativeRailwayPlacement,
  roads: readonly Road[],
): RailwayCrossingLayout[] {
  const transform = nativePlacementTransform(placement, {x: -34, z: -136});
  const found: RailwayCrossingLayout[] = [];

  for (const road of roads) {
    for (let index = 1; index < road.points.length; index++) {
      const a = transform.toLocal(road.points[index - 1]!);
      const b = transform.toLocal(road.points[index]!);
      const dz = b.z - a.z;

      if (Math.abs(dz) < 1e-8) {
        continue;
      }

      const along = (RAILWAY_Z - a.z) / dz;
      const x = a.x + (b.x - a.x) * along;

      if (
        along < 0 ||
        along > 1 ||
        x < -209 ||
        x > 141 ||
        found.some(crossing => Math.abs(crossing.x - x) < 0.01)
      ) {
        continue;
      }

      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      const c = Math.abs(Math.cos(yaw));
      const s = Math.abs(Math.sin(yaw));

      found.push({
        id: found.length,
        x,
        z: RAILWAY_Z,
        yaw,
        halfWidth: 5.5 * c + 9 * s,
        halfDepth: 5.5 * s + 9 * c,
      });
    }
  }

  return found;
}

export function createNativeRailwayConfiguration(
  placement: NativeRailwayPlacement,
  profile: LifeProfile,
  routing: RegionRouting,
  options: {
    startSeconds?: number;
    restoredSave?: RailwaySave;
    roads?: readonly Road[];
  } = {},
): NativeRailwayConfiguration {
  const transform = nativePlacementTransform(placement, {x: -34, z: -136});
  const station = transform.toWorld({x: -34, z: -136});
  const exit = transform.toWorld(RAILWAY_STATION_EXIT);
  const place = profile.places.find(
    item => item.id === placement.stationPlaceId,
  );

  if (!place || place.kind !== 'station') {
    throw new Error('Вокзал должен быть зарегистрирован в нативном мире');
  }

  routing.access(exit, [transform.toWorld({x: -24, z: -123.45})]);
  const crossings = nativeRailwayCrossings(placement, options.roads ?? []);
  const railway = new Railway(options.startSeconds ?? 0, true, [], {
    placement,
    crossings,
    west: -232,
    east: 164,
  });

  if (options.restoredSave) {
    railway.restore(options.restoredSave);
  }

  return {
    railway,
    station,
    exit,
    crossings,
    placement,
    transform,
    arrivalChain: direction =>
      railwayArrivalChain(direction).map(point => transform.toWorld(point)),
  };
}

/** Exact original warehouse body descriptors for the renderer and core asset compiler. */
export function nativePortWarehouseTemplates(seed: string): CityBuilding[] {
  const layout = generateCity(seed);

  return WAREHOUSES.map(warehouse => {
    const template = layout.buildings.find(
      building => building.id === warehouse.buildingId,
    );

    if (!template) {
      throw new Error('Нет исходного склада порта');
    }

    return template;
  });
}

function infrastructureRectangle(
  transform: NativePlacementTransform,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): Point[] {
  return [
    {x: minX, z: minZ},
    {x: maxX, z: minZ},
    {x: maxX, z: maxZ},
    {x: minX, z: maxZ},
  ].map(point => transform.toWorld(point));
}

/** Full native loading pads, access streets, quays and straight hull clearance. */
export function nativePortFootprint(placement: NativeInfrastructurePlacement): {
  land: Point[];
  quay: Point[];
  water: Point[];
  sockets: Point[];
} {
  const transform = nativePlacementTransform(placement, {x: 85, z: 135});

  return {
    land: infrastructureRectangle(transform, 47, 55, 123, 123),
    quay: infrastructureRectangle(transform, 47, 123, 123, 147),
    water: infrastructureRectangle(transform, -173, 147.9, 175, 154.1),
    sockets: [
      {x: 51, z: 72},
      {x: 85, z: 106},
      {x: 119, z: 106},
    ].map(point => transform.toWorld(point)),
  };
}

/** Conservative 396×46 m source footprint, including bridge, gates and exit spur. */
export function nativeRailwayFootprint(
  placement: NativeInfrastructurePlacement,
): Point[] {
  const transform = nativePlacementTransform(placement, {x: -34, z: -136});

  return infrastructureRectangle(transform, -232, -159, 164, -113);
}

export function nativeRailwayAccessRoads(
  placement: NativeInfrastructurePlacement,
): Road[] {
  const transform = nativePlacementTransform(placement, {x: -34, z: -136});

  return [
    {
      id: `${placement.id}/access`,
      points: [
        transform.toWorld({x: -24, z: -123.45}),
        transform.toWorld({x: -24, z: -119}),
      ],
    },
  ];
}
