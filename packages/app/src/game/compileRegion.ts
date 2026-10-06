import {createAuthoredDefinition} from '../city/life/definition';
import type {
  AuthoredPlacement,
  AuthoredWorldDefinition,
} from '../city/life/definition';
import {RegionRouting} from '../city/life/regionRouting';
import {createNativePortWarehousePlacements} from '../city/life/nativeInfrastructure';
import {CURB_PARKING} from '../city/life/streetParking';
import type {ParkingFacility} from '../city/life/types';
import {
  convexInteriorsOverlap,
  isDryFootprint,
  rectangle,
} from '../region/model/geometry';
import {zoneStrip} from './regionDocument';
import {packStreetStrip} from './assemblyPool';
import type {NativeRegionDocument} from './regionDocument';

/** Compile editor geometry into the same native places and parking that the worker consumes. */
export function compileNativeRegion(
  document: NativeRegionDocument,
  seconds: number,
): AuthoredWorldDefinition {
  const placements: AuthoredPlacement[] = document.blocks.flatMap(block =>
    block.templates.map(template => {
      const c = Math.cos(block.yaw);
      const s = Math.sin(block.yaw);
      const dx = template.x - block.sourceBlock.x;
      const dz = template.z - block.sourceBlock.z;

      return {
        id: block.overrides?.[template.id]?.id ?? `${block.id}/${template.id}`,
        ...(block.overrides?.[template.id]?.capacity === undefined
          ? {}
          : {capacity: block.overrides[template.id]!.capacity!}),
        ...(block.overrides?.[template.id]?.name
          ? {name: block.overrides[template.id]!.name!}
          : {}),
        municipalityId: block.municipalityId,
        template,
        sourceBlock: block.sourceBlock,
        center: {
          x: block.center.x + c * dx + s * dz,
          z: block.center.z - s * dx + c * dz,
        },
        yaw: block.yaw,
        kind:
          block.overrides?.[template.id]?.kind ??
          (template.district === 'residential'
            ? 'home'
            : template.district === 'industrial'
              ? 'factory'
              : template.district === 'downtown'
                ? 'office'
                : template.name.startsWith('Отель')
                  ? 'cafe'
                  : 'shop'),
        readyAt: block.startedAt + block.duration,
        startedAt: block.startedAt,
      };
    }),
  );

  for (const port of document.infrastructure?.ports ?? []) {
    placements.push(
      ...createNativePortWarehousePlacements(document.seed, port),
    );
  }

  // Zones grow freestanding houses of their own size along the marked strip.
  const packed: Array<{
    center: {x: number; z: number};
    width: number;
    depth: number;
  }> = [];

  for (const placement of placements) {
    packed.push({
      center: placement.center,
      width: placement.template.width,
      depth: placement.template.depth,
    });
  }

  for (const block of document.blocks) {
    packed.push({center: block.center, width: 34, depth: 34});
  }

  for (const zone of document.zones ?? []) {
    const strip = zoneStrip(zone, document.roads);

    if (!strip || strip.length <= 12) {
      continue;
    }

    const zonePlacements = packStreetStrip({
      seed: document.seed,
      district: zone.district,
      origin: strip.origin,
      direction: strip.direction,
      length: strip.length,
      municipalityId: zone.municipalityId,
      idPrefix: zone.id,
      startedAt: zone.startedAt,
      duration: 60,
      dry: (center, width, depth) =>
        isDryFootprint(document.terrain, rectangle(center, width, depth)),
      blocked: (center, width, depth) =>
        packed.some(other =>
          convexInteriorsOverlap(
            rectangle(center, width, depth),
            rectangle(other.center, other.width, other.depth),
          ),
        ),
    });

    placements.push(...zonePlacements);

    for (const placement of zonePlacements) {
      packed.push({
        center: placement.center,
        width: placement.template.width,
        depth: placement.template.depth,
      });
    }
  }

  const base = createAuthoredDefinition({
    seed: document.seed,
    roads: document.roads,
    placements,
    atSeconds: seconds,
    ...(document.spaces ? {spaces: document.spaces} : {}),
    ...(document.infrastructure
      ? {infrastructure: document.infrastructure}
      : {}),
    bounds: document.terrain.bounds,
    metadata: {regionDocument: document},
    ...(document.calendar ? {calendar: document.calendar} : {}),
    ...(document.taxRate === undefined
      ? {}
      : {economy: {rules: {taxRate: document.taxRate}}}),
  });
  const routing = new RegionRouting(base.layout, document.roads);
  const profile = base.profile;
  const entries = document.entries.map(entry => {
    const road = document.roads.find(item => item.id === entry.roadId)!;
    const endpoint =
      entry.endpoint === 'start' ? road.points[0]! : road.points.at(-1)!;
    const direction = entry.endpoint === 'start' ? 1 : -1;
    const access = routing.roadAccess(endpoint, direction);
    const exit = routing.roadAccess(endpoint, direction === 1 ? -1 : 1);
    const segment = routing.segment(access);
    const along = direction * 14;
    const center = {
      x:
        endpoint.x +
        segment.dx * along -
        segment.dz * CURB_PARKING.centerOffset,
      z:
        endpoint.z +
        segment.dz * along +
        segment.dx * CURB_PARKING.centerOffset,
      y: 0.91,
    };
    const facilityRoad = routing.roadAccess(center, 1);
    const id = profile.facilities.length;
    const entrance = {...center};
    const facility: ParkingFacility = {
      id,
      key: `${entry.id}/terminal`,
      kind: 'street',
      name: 'Остановка междугороднего автобуса',
      buildingId: null,
      blockId: entry.id,
      entrance,
      yaw: Math.atan2(segment.dx, segment.dz),
      road: facilityRoad,
      access: routing.access(center, []),
      residentsOnly: false,
      fee: 0,
      slots: [],
    };

    profile.facilities.push(facility);

    for (const offset of [
      -CURB_PARKING.placeLength / 2,
      CURB_PARKING.placeLength / 2,
    ]) {
      const slotId = profile.slots.length;

      facility.slots.push(slotId);
      profile.slots.push({
        id: slotId,
        key: `${entry.id}/terminal/${facility.slots.length}`,
        facility: id,
        position: {
          x: center.x + segment.dx * offset,
          z: center.z + segment.dz * offset,
          y: 0.91,
        },
        yaw: facility.yaw,
        width: CURB_PARKING.width,
        length: CURB_PARKING.placeLength,
        household: null,
        occupant: null,
        reserved: null,
      });
    }

    profile.bays.push({
      x: center.x,
      z: center.z,
      yaw: facility.yaw,
      facility: id,
      blockId: null,
      sidewalk: [
        {x: center.x - segment.dz * 2, z: center.z + segment.dx * 2, y: 1.07},
      ],
    });

    return {
      id: entry.id,
      access,
      exit,
      terminalFacilityId: id,
    };
  });

  profile.arrival = entries[0]?.access ?? null;

  return {...base, entries, profile};
}
