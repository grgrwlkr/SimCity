import type {NativeGameSave} from './save';
import {z} from 'zod';
import {CityLife} from '../city/life/world';
import {compileNativeRegion} from './compileRegion';
import {documentFromDefinition} from './documentFromDefinition';
import {AUTHORIZED_LEGACY_REPLAN_ID} from './legacyLayout';
import {readNativeRegionDocument} from './regionDocument';
import {
  convexInteriorsOverlap,
  isDryFootprint,
  rectangle,
} from '../region/model/geometry';
import {
  townHallReservation,
  townHallRoadPoints,
} from '../region/model/townHall';
import {
  ROAD_SIDEWALK_WIDTH,
  TOWN_HALL_ROAD_OFFSET,
  REGION_RULES,
} from '../region/model/rules';
import type {Road} from '../region/model/types';
import {
  nativePortFootprint,
  nativeRailwayFootprint,
} from '../city/life/nativeInfrastructure';

const eligibleMetadata = z.object({
  legacyReplan: z.object({
    authorizedId: z.literal(AUTHORIZED_LEGACY_REPLAN_ID),
    originalRoads: z.unknown().optional(),
  }),
  legacyMigration: z.object({
    document: z.object({id: z.literal(AUTHORIZED_LEGACY_REPLAN_ID)}),
  }),
});
const originalRoadsSchema = z.array(
  z.object({
    id: z.string(),
    points: z
      .array(z.object({x: z.number().finite(), z: z.number().finite()}))
      .min(2),
  }),
);

function unsupported(): never {
  throw new Error(
    'Невозможно безопасно восстановить улицы ратуш: неподдерживаемая геометрия импортированного мира. Оригинал сохранён.',
  );
}

function roadContour(road: Road) {
  const [a, b] = road.points;

  if (!a || !b || road.points.length !== 2) {
    return unsupported();
  }

  const dx = b.x - a.x;
  const dz = b.z - a.z;

  return rectangle(
    {x: (a.x + b.x) / 2, z: (a.z + b.z) / 2},
    REGION_RULES.roadWidth + 2 * ROAD_SIDEWALK_WIDTH,
    Math.hypot(dx, dz),
    Math.atan2(dx, dz),
  );
}

/** Repair only the explicitly authorized imported civic streets, without ticking its native world. */
export function repairLegacyHallRoads(save: NativeGameSave): NativeGameSave {
  const source = save.world;

  if (source.version !== 3) {
    return save;
  }

  const eligible = eligibleMetadata.safeParse(source.definition.metadata);

  if (!eligible.success) {
    return save;
  }

  const definition = source.definition;
  const savedDocument = definition.metadata?.['regionDocument'];
  const reconstructed =
    savedDocument === undefined
      ? documentFromDefinition(definition, save.id)
      : undefined;
  const ports = new Set(
    (definition.infrastructure?.ports ?? []).map(port => port.id),
  );
  const document =
    readNativeRegionDocument(savedDocument) ??
    (reconstructed
      ? {
          ...reconstructed,
          // Port warehouses are compiled by the infrastructure descriptor, not again as town blocks.
          blocks: reconstructed.blocks.filter(
            block => !ports.has(block.municipalityId),
          ),
          ...(definition.infrastructure
            ? {infrastructure: definition.infrastructure}
            : {}),
          ...(definition.spaces ? {spaces: definition.spaces} : {}),
        }
      : unsupported());
  const missing = document.settlements.filter(
    town => !definition.roads.some(road => road.id === town.townHall?.roadId),
  );

  if (JSON.stringify(document.roads) !== JSON.stringify(definition.roads)) {
    return unsupported();
  }
  if (!missing.length) {
    return save;
  }

  const original = originalRoadsSchema.safeParse(
    eligible.data.legacyReplan.originalRoads,
  );

  if (!original.success) {
    return unsupported();
  }

  const additions: Road[] = [];

  for (const town of missing) {
    const hall = town.townHall;

    if (
      !hall ||
      !['road-2', 'road-4'].includes(hall.roadId) ||
      hall.heading !== 0
    ) {
      return unsupported();
    }

    const starter = {
      id: hall.roadId,
      points: townHallRoadPoints(town.center, hall.heading),
    };
    const paidRoad = original.data.find(road => road.id === hall.roadId);

    if (
      !paidRoad ||
      JSON.stringify(paidRoad.points) !== JSON.stringify(starter.points)
    ) {
      return unsupported();
    }

    const front = {x: town.center.x, z: town.center.z + TOWN_HALL_ROAD_OFFSET};
    const junction = {x: town.center.x, z: front.z + 20};

    if (
      !definition.roads.some(road =>
        road.points.some(
          point => point.x === junction.x && point.z === junction.z,
        ),
      )
    ) {
      return unsupported();
    }

    const link = {id: `native-hall-link-${town.id}`, points: [front, junction]};

    if (definition.roads.some(road => road.id === link.id)) {
      return unsupported();
    }

    additions.push(starter, link);
  }

  const reserved = [
    ...document.settlements.map(townHallReservation),
    ...document.blocks.map(block => rectangle(block.center, 34, 34, block.yaw)),
    ...(document.spaces ?? []).map(space =>
      rectangle(space.center, 34, 34, space.yaw),
    ),
    ...(document.infrastructure?.ports ?? []).flatMap(port => {
      const footprint = nativePortFootprint(port);

      return [footprint.land, footprint.quay];
    }),
    ...(document.infrastructure?.railways ?? []).map(nativeRailwayFootprint),
  ];

  for (const road of additions) {
    const contour = roadContour(road);

    if (
      !isDryFootprint(document.terrain, contour) ||
      reserved.some(shape => convexInteriorsOverlap(contour, shape))
    ) {
      return unsupported();
    }

    const [a, b] = road.points;

    for (const existing of [
      ...definition.roads,
      ...additions.filter(other => other !== road),
    ]) {
      for (let index = 1; index < existing.points.length; index++) {
        const c = existing.points[index - 1]!;
        const d = existing.points[index]!;
        const parallel =
          Math.abs((b!.x - a!.x) * (d.z - c.z) - (b!.z - a!.z) * (d.x - c.x)) <
          1e-6;

        if (
          parallel &&
          convexInteriorsOverlap(
            contour,
            roadContour({id: existing.id, points: [c, d]}),
          )
        ) {
          return unsupported();
        }
      }
    }
  }

  const normalized = {...document, roads: [...definition.roads, ...additions]};
  const world = CityLife.fromSave(structuredClone(source));
  const next = compileNativeRegion(normalized, world.seconds);

  world.applyDefinitionUpdate(
    {
      ...definition,
      roads: next.roads,
      metadata: {...definition.metadata, regionDocument: normalized},
    },
    0,
  );
  const updated = world.save();

  if (updated.version !== 3) {
    return unsupported();
  }

  // A road-only import must not persist edit-time hiring refreshes or create new terminal parking.
  return {
    ...save,
    world: {
      ...source,
      definition: updated.definition,
      junctionKeys: updated.junctionKeys,
      traffic: updated.traffic,
    },
  };
}
