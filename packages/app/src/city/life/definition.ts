import {generateCity} from '../generator';
import type {CityLayout} from '../generator';
import type {LifeNetwork} from './network';
import {createLifeProfile} from './network';
import {NoNativeRoute, RegionRouting} from './regionRouting';
import {CITY_GRID} from '../cityGrid';
import type {CityBlock, CityBuilding} from '../generator';
import type {Road, Bounds} from '../../region/model/types';
import type {GraphRoadAccess, LifeProfile, PlaceKind, Point} from './types';
import {z} from 'zod';

/** Serializable input for the existing prototype topology compiler. */
export interface PrototypeWorldDefinition {
  readonly version: 1;
  readonly kind: 'prototype-grid';
  readonly seed: string;
  readonly expanded: boolean;
  readonly layout: CityLayout;
}
export interface NativeCalendar {
  readonly startingMinute: number;
  readonly secondsPerMinute: number;
}
export interface AuthoredPlacement {
  readonly id: string;
  readonly municipalityId: string;
  readonly template: CityBuilding;
  readonly sourceBlock?: CityBlock;
  readonly center: Point;
  readonly yaw: number;
  readonly kind: PlaceKind;
  readonly name?: string;
  readonly capacity?: number;
  readonly jobs?: number;
  readonly readyAt?: number;
  readonly startedAt?: number;
}
export interface AuthoredEntry {
  readonly id: string;
  readonly access: GraphRoadAccess;
  readonly exit: GraphRoadAccess;
  readonly terminalFacilityId: number;
}
export interface AuthoredWorldDefinition {
  readonly version: 1;
  readonly kind: 'authored';
  readonly seed: string;
  readonly expanded: false;
  readonly layout: CityLayout;
  readonly roads: readonly Road[];
  readonly entries: readonly AuthoredEntry[];
  readonly profile: LifeProfile;
  readonly placements: readonly AuthoredPlacement[];
  readonly bounds: Bounds;
  readonly startingCash?: number;
  readonly calendar?: NativeCalendar;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export type CityWorldDefinition =
  PrototypeWorldDefinition | AuthoredWorldDefinition;

export interface AuthoredDefinitionOptions {
  readonly atSeconds?: number;
  readonly seed: string;
  readonly roads?: readonly Road[];
  readonly placements?: readonly AuthoredPlacement[];
  readonly entries?: readonly AuthoredEntry[];
  readonly profile?: LifeProfile | undefined;
  readonly bounds?: Bounds;
  readonly startingCash?: number;
  readonly calendar?: NativeCalendar;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CityLifeDefinitionOptions {
  readonly initialFamilies?: number;
  readonly network?: LifeNetwork;
}

export function createLayoutDefinition(
  layout: CityLayout,
  expanded = true,
): PrototypeWorldDefinition {
  return {
    version: 1,
    kind: 'prototype-grid',
    seed: layout.seed,
    expanded,
    layout,
  };
}

export function createPrototypeDefinition(
  seed: string,
  expanded = true,
): PrototypeWorldDefinition {
  return createLayoutDefinition(generateCity(seed, expanded), expanded);
}

export function transformPlacement(
  point: Point,
  placement: AuthoredPlacement,
): Point {
  const dx = point.x - placement.template.x;
  const dz = point.z - placement.template.z;
  const c = Math.cos(placement.yaw);
  const s = Math.sin(placement.yaw);

  return {
    x: placement.center.x + c * dx + s * dz,
    z: placement.center.z - s * dx + c * dz,
    ...(point.y === undefined ? {} : {y: point.y}),
  };
}

export function createAuthoredDefinition(
  options: AuthoredDefinitionOptions,
): AuthoredWorldDefinition {
  const {seed} = options;
  const roads = options.roads ?? [];
  const placements = options.placements ?? [];
  const source = generateCity(seed);
  const layout: CityLayout = {seed, blocks: [], buildings: []};
  const routing = new RegionRouting(layout, roads);
  const profile: LifeProfile = options.profile
    ? structuredClone(options.profile)
    : {
        seed,
        layout,
        places: [],
        facilities: [],
        slots: [],
        bays: [],
        garageBuildings: {},
        arrival: null,
      };
  const groups = new Map<string, AuthoredPlacement[]>();

  for (const placement of placements) {
    const c = Math.cos(placement.yaw);
    const s = Math.sin(placement.yaw);
    const tx =
      placement.center.x - c * placement.template.x - s * placement.template.z;
    const tz =
      placement.center.z + s * placement.template.x - c * placement.template.z;
    const key = `${placement.municipalityId}/${placement.template.blockId}/${tx.toFixed(4)}/${tz.toFixed(4)}/${placement.yaw.toFixed(6)}`;
    const group = groups.get(key) ?? [];

    group.push(placement);
    groups.set(key, group);
  }

  for (const [blockId, group] of groups) {
    const first = group[0]!;
    const sourceBlock =
      first.sourceBlock ??
      source.blocks.find(block => block.id === first.template.blockId);

    if (!sourceBlock) {
      throw new Error('Нет исходного блока для нативной сборки');
    }

    const block = {
      ...sourceBlock,
      ...transformPlacement(sourceBlock, first),
      id: blockId,
    };

    layout.blocks.push(block);
    const nativeLayout: CityLayout = {
      seed,
      grid: CITY_GRID,
      blocks: [sourceBlock],
      buildings: group.map(placement => placement.template),
    };
    const native = createLifeProfile(nativeLayout);
    const placeIds = new Map(
      group.map(placement => [placement.template.id, placement.id]),
    );
    const facilityIds = new Map<number, number>();

    for (const placement of group) {
      const template = placement.template;
      const building = {
        ...template,
        ...transformPlacement(template, placement),
        id: placement.id,
        blockId,
        ...(template.plot
          ? {
              plot: {
                ...template.plot,
                ...transformPlacement(template.plot, placement),
              },
            }
          : {}),
      };

      layout.buildings.push(building);

      if (
        options.profile ||
        (placement.readyAt ?? 0) > (options.atSeconds ?? 0)
      ) {
        continue;
      }

      const original = native.places.find(place => place.id === template.id)!;
      const door = transformPlacement(original.door, placement);
      const access = routing.access(
        door,
        original.access.chain
          .slice(1)
          .map(point => transformPlacement(point, placement)),
      );
      const place = {
        ...original,
        id: placement.id,
        name: placement.name ?? original.name,
        municipalityId: placement.municipalityId,
        kind: placement.kind,
        blockId,
        building,
        door,
        access,
        parking: null,
        capacity: placement.capacity ?? original.capacity,
      };

      profile.places.push(place);
    }

    if (options.profile) {
      continue;
    }

    for (const original of native.facilities) {
      const bay = native.bays.find(bay => bay.facility === original.id);

      if (
        original.buildingId === null
          ? bay?.blockId !== sourceBlock.id
          : !placeIds.has(original.buildingId)
      ) {
        continue;
      }

      const id = profile.facilities.length;
      const host =
        original.buildingId === null
          ? first
          : group.find(
              placement => placement.template.id === original.buildingId,
            )!;

      if (
        original.buildingId !== null &&
        !profile.places.some(place => place.id === host.id)
      ) {
        continue;
      }

      const entrance = transformPlacement(original.entrance, host);
      const forward = {
        x: Math.sin(original.yaw + host.yaw),
        z: Math.cos(original.yaw + host.yaw),
      };
      let near;

      try {
        near = routing.roadAccess(
          transformPlacement(original.road.point, host),
          1,
          original.buildingId === null ? 8 : 30,
        );
      } catch (error) {
        if (error instanceof NoNativeRoute && original.buildingId === null) {
          continue;
        }

        throw error;
      }

      const segment = routing.segment(near);
      const side =
        (entrance.x - segment.center.x) * -segment.dz +
          (entrance.z - segment.center.z) * segment.dx >=
        0
          ? 1
          : -1;
      const road = routing.roadAccess(
        transformPlacement(original.road.point, host),
        side,
        30,
      );
      const key =
        original.buildingId === null
          ? `${blockId}/street/${original.id}`
          : `${host.id}/${original.kind}`;
      const facility = {
        ...original,
        id,
        key,
        buildingId:
          original.buildingId === null
            ? null
            : placeIds.get(original.buildingId)!,
        blockId,
        entrance,
        yaw: Math.atan2(forward.x, forward.z),
        road,
        access: routing.access(
          transformPlacement(original.access.point, host),
          [],
        ),
        slots: [] as number[],
      };

      facilityIds.set(original.id, id);
      profile.facilities.push(facility);

      for (const originalId of original.slots) {
        const slot = native.slots[originalId]!;
        const nextId = profile.slots.length;

        facility.slots.push(nextId);
        profile.slots.push({
          ...slot,
          id: nextId,
          key: `${key}/${facility.slots.length - 1}`,
          facility: id,
          position: transformPlacement(slot.position, host),
          yaw: slot.yaw + host.yaw,
        });
      }

      if (facility.kind === 'underground' && facility.buildingId !== null) {
        profile.garageBuildings[facility.buildingId] = id;
      }
      if (bay) {
        profile.bays.push({
          ...bay,
          ...transformPlacement(bay, host),
          yaw: bay.yaw + host.yaw,
          facility: id,
          blockId,
          sidewalk: bay.sidewalk.map(point => transformPlacement(point, host)),
        });
      }
    }

    for (const original of native.places) {
      const place = profile.places.find(
        place => place.id === placeIds.get(original.id),
      );

      if (place && original.parking !== null) {
        place.parking = facilityIds.get(original.parking) ?? null;
      }
    }
  }

  if (options.profile) {
    layout.blocks.push(
      ...profile.layout.blocks.filter(
        block => !layout.blocks.some(current => current.id === block.id),
      ),
    );
    layout.buildings.push(
      ...profile.layout.buildings.filter(
        building =>
          !layout.buildings.some(current => current.id === building.id),
      ),
    );
  }

  profile.layout = layout;
  profile.seed = seed;
  const entries = options.entries ?? [];

  profile.arrival = entries[0]?.access ?? null;

  return {
    version: 1,
    kind: 'authored',
    seed,
    expanded: false,
    layout,
    roads,
    entries,
    profile,
    placements,
    bounds: options.bounds ?? {
      minX: -2000,
      maxX: 2000,
      minZ: -2000,
      maxZ: 2000,
    },
    ...(options.startingCash === undefined
      ? {}
      : {startingCash: options.startingCash}),
    ...(options.calendar ? {calendar: options.calendar} : {}),
    ...(options.metadata ? {metadata: options.metadata} : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function completeAuthoredConstruction(
  definition: AuthoredWorldDefinition,
  seconds: number,
): AuthoredWorldDefinition {
  const next = createAuthoredDefinition({
    ...definition,
    profile: undefined,
    atSeconds: seconds,
  });
  const placementIds = new Set(
    definition.placements.map(placement => placement.id),
  );
  const facilityMap = new Map<number, number>();

  for (const place of definition.profile.places.filter(
    place => !placementIds.has(place.id),
  )) {
    next.profile.places.push(structuredClone(place));
  }

  for (const original of definition.profile.facilities) {
    const generated = next.profile.facilities.find(
      facility => facility.key === original.key,
    );

    if (generated) {
      facilityMap.set(original.id, generated.id);
      continue;
    }
    if (original.buildingId !== null && placementIds.has(original.buildingId)) {
      continue;
    }

    // Explicit infrastructure, including entry terminals, is not a building compiler output.
    const id = next.profile.facilities.length;
    const facility = {...structuredClone(original), id, slots: [] as number[]};

    next.profile.facilities.push(facility);
    facilityMap.set(original.id, id);

    for (const originalId of original.slots) {
      const slot = definition.profile.slots[originalId]!;
      const id = next.profile.slots.length;

      facility.slots.push(id);
      next.profile.slots.push({
        ...structuredClone(slot),
        id,
        facility: facility.id,
      });
    }
  }

  for (const place of next.profile.places.filter(
    place => !placementIds.has(place.id),
  )) {
    if (place.parking !== null) {
      place.parking = facilityMap.get(place.parking) ?? null;
    }
  }

  return {
    ...next,
    entries: next.entries.map(entry => ({
      ...entry,
      terminalFacilityId:
        facilityMap.get(entry.terminalFacilityId) ?? entry.terminalFacilityId,
    })),
  };
}

const pointSchema = z.object({
  x: z.number().finite(),
  z: z.number().finite(),
  y: z.number().finite().optional(),
});
const layoutSchema = z.object({
  seed: z.string(),
  blocks: z.array(
    z.object({
      id: z.string().min(1),
      x: z.number().finite(),
      z: z.number().finite(),
      district: z.string(),
    }),
  ),
  buildings: z.array(
    z.object({
      id: z.string().min(1),
      blockId: z.string(),
      x: z.number().finite(),
      z: z.number().finite(),
      floors: z.number().int().positive(),
      width: z.number().positive(),
      depth: z.number().positive(),
      kit: z.record(z.string(), z.unknown()),
    }),
  ),
});
const baseSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['prototype-grid', 'authored']),
  seed: z.string().min(1),
  expanded: z.boolean(),
  layout: layoutSchema,
});

export function parseWorldDefinition(value: unknown): CityWorldDefinition {
  const schema = z.custom<CityWorldDefinition>((candidate: unknown) => {
    if (
      !baseSchema.safeParse(candidate).success ||
      !isRecord(candidate) ||
      !isRecord(candidate['layout']) ||
      candidate['seed'] !== candidate['layout']['seed']
    ) {
      return false;
    }
    if (candidate['kind'] === 'prototype-grid') {
      return true;
    }

    const authored = z.object({
      expanded: z.literal(false),
      roads: z.array(
        z.object({id: z.string().min(1), points: z.array(pointSchema).min(2)}),
      ),
      entries: z.array(
        z.object({
          id: z.string(),
          access: z.record(z.string(), z.unknown()),
          exit: z.record(z.string(), z.unknown()),
          terminalFacilityId: z.number().int().nonnegative(),
        }),
      ),
      placements: z.array(z.record(z.string(), z.unknown())),
      bounds: z.object({
        minX: z.number().finite(),
        maxX: z.number().finite(),
        minZ: z.number().finite(),
        maxZ: z.number().finite(),
      }),
      profile: z.object({
        seed: z.string(),
        layout: layoutSchema,
        places: z.array(z.record(z.string(), z.unknown())),
        facilities: z.array(z.record(z.string(), z.unknown())),
        slots: z.array(z.record(z.string(), z.unknown())),
        bays: z.array(z.record(z.string(), z.unknown())),
        garageBuildings: z.record(z.string(), z.number().int().nonnegative()),
        arrival: z.record(z.string(), z.unknown()).nullable(),
      }),
      calendar: z
        .object({
          startingMinute: z.number().finite(),
          secondsPerMinute: z.number().positive().finite(),
        })
        .optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    });

    return authored.safeParse(candidate).success;
  });
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new Error('Некорректное описание нативного мира');
  }

  return parsed.data;
}
