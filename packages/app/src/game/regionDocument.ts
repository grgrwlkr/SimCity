import {z} from 'zod';
import {generateCity} from '../city/generator';
import type {CityBlock, CityBuilding} from '../city/generator';
import type {
  NativeCalendar,
  AuthoredPublicSpace,
  AuthoredInfrastructure,
} from '../city/life/definition';
import {
  nativePortFootprint,
  nativePortRoads,
  nativeRailwayFootprint,
  nativeRailwayAccessRoads,
} from '../city/life/nativeInfrastructure';
import {
  nativePortPlacementError,
  nativePortNavigation,
} from '../city/nativePortNavigation';
import type {PlaceKind} from '../city/life/types';
import {generateTerrain} from '../region/model/terrain';
import {
  containsPoint,
  distance,
  isDryFootprint,
  polygonsOverlap,
  rectangle,
  normalizePoint,
} from '../region/model/geometry';
import {
  roadContour,
  roadLength,
  nearestRoadAccess,
} from '../region/model/roads';
import {cityRadius, townHallLevel} from '../region/model/territory';
import {
  townHallReservation,
  townHallRoadPoints,
} from '../region/model/townHall';
import {REGION_RULES, TOWN_HALL_LEVELS} from '../region/model/rules';
import type {Point, Road, Settlement, Terrain} from '../region/model/types';

export interface NativeBlockPlacement {
  readonly id: string;
  readonly municipalityId: string;
  readonly sourceSeed: string;
  readonly sourceBlock: CityBlock;
  readonly templates: readonly CityBuilding[];
  readonly center: Point;
  readonly yaw: number;
  readonly startedAt: number;
  readonly duration: number;
  readonly overrides?:
    | Readonly<
        Record<
          string,
          {
            id: string;
            kind: PlaceKind;
            capacity?: number | undefined;
            name?: string | undefined;
          }
        >
      >
    | undefined;
}

export interface NativeRegionDocument {
  readonly kind: 'native-region-document';
  readonly version: 1;
  readonly id: string;
  readonly seed: string;
  readonly calendar?: NativeCalendar | undefined;
  readonly spaces?: readonly AuthoredPublicSpace[] | undefined;
  readonly infrastructure?: AuthoredInfrastructure | undefined;
  readonly terrain: Terrain;
  readonly settlements: readonly Settlement[];
  readonly roads: readonly Road[];
  readonly blocks: readonly NativeBlockPlacement[];
  readonly entries: ReadonlyArray<{
    id: string;
    roadId: string;
    endpoint: 'start' | 'end';
  }>;
  readonly revision: number;
  readonly nextId: number;
}

export type NativeEdit =
  | {type: 'found'; center: Point; name: string}
  | {type: 'road'; points: readonly Point[]; settlementId?: string}
  | {
      type: 'block';
      center: Point;
      settlementId: string;
      district: 'residential' | 'commercial' | 'industrial' | 'downtown';
      houses?: boolean;
      yaw?: number;
      service?: 'school';
    }
  | {type: 'park'; center: Point; settlementId: string; yaw?: number}
  | {type: 'port'; center: Point; yaw: number}
  | {type: 'railway'; center: Point; yaw: number}
  | {type: 'entry'; roadId: string; endpoint: 'start' | 'end'}
  | {type: 'upgrade'; settlementId: string}
  | {type: 'remove'; id: string};

export interface NativeEditResult {
  readonly document: NativeRegionDocument;
  readonly cost: number;
  readonly createdId: string | null;
}

export function createNativeRegionDocument(
  id: string,
  seed: string,
): NativeRegionDocument {
  return {
    kind: 'native-region-document',
    version: 1,
    id,
    seed,
    terrain: generateTerrain(seed, 4000),
    settlements: [],
    roads: [],
    blocks: [],
    entries: [],
    revision: 0,
    nextId: 1,
  };
}

function assertLand(
  document: NativeRegionDocument,
  contour: readonly Point[],
): void {
  if (!contour.every(point => containsPoint(document.terrain.bounds, point))) {
    throw new Error('За границей региона.');
  }
  if (!isDryFootprint(document.terrain, contour)) {
    throw new Error('Объект должен целиком помещаться на суше.');
  }
  if (
    (document.spaces ?? []).some(space =>
      polygonsOverlap(contour, rectangle(space.center, 34, 34, space.yaw)),
    ) ||
    (document.infrastructure?.ports ?? []).some(
      port =>
        polygonsOverlap(contour, nativePortFootprint(port).land) ||
        polygonsOverlap(contour, nativePortFootprint(port).quay),
    ) ||
    (document.infrastructure?.railways ?? []).some(railway =>
      polygonsOverlap(contour, nativeRailwayFootprint(railway)),
    ) ||
    document.settlements.some(town =>
      polygonsOverlap(contour, townHallReservation(town)),
    ) ||
    document.blocks.some(block =>
      polygonsOverlap(contour, rectangle(block.center, 34, 34, block.yaw)),
    )
  ) {
    throw new Error('Место занято.');
  }
}

export function applyNativeEdit(
  document: NativeRegionDocument,
  edit: NativeEdit,
  cash: number,
  seconds: number,
): NativeEditResult {
  const id = `native-${document.nextId}`;
  let next = document;
  let cost = 0;
  let createdId: string | null = null;
  const town =
    'settlementId' in edit
      ? document.settlements.find(item => item.id === edit.settlementId)
      : undefined;
  const withinTown = (contour: readonly Point[]): void => {
    if (
      !town ||
      !contour.every(point => distance(point, town.center) <= cityRadius(town))
    ) {
      throw new Error('Строительство доступно в радиусе выбранной ратуши.');
    }
  };

  switch (edit.type) {
    case 'found': {
      const roadId = `${id}-road`;
      const settlement: Settlement = {
        id,
        name:
          edit.name.trim().slice(0, 64) ||
          `Поселение ${document.settlements.length + 1}`,
        center: edit.center,
        townHall: {roadId, heading: 0, level: 1},
      };
      const points = townHallRoadPoints(edit.center);

      assertLand(document, townHallReservation(settlement));
      assertLand(document, roadContour(points, REGION_RULES.roadWidth));

      if (
        document.settlements.some(
          other =>
            distance(other.center, edit.center) < cityRadius(other) + 300,
        )
      ) {
        throw new Error('Городские территории должны оставаться раздельными.');
      }

      cost = Math.round(roadLength(points) * REGION_RULES.roadCostPerMeter);
      next = {
        ...document,
        settlements: [...document.settlements, settlement],
        roads: [...document.roads, {id: roadId, points}],
      };
      createdId = id;
      break;
    }

    case 'road': {
      const points = edit.points.map(point => {
        const nearest = nearestRoadAccess(
          document.roads,
          point,
          REGION_RULES.snapDistance,
        );

        if (!nearest) {
          return normalizePoint(point);
        }

        const road = document.roads.find(road => road.id === nearest.roadId)!;
        const a = road.points[nearest.segment]!;
        const b = road.points[nearest.segment + 1]!;

        return normalizePoint({
          x: a.x + (b.x - a.x) * nearest.offset,
          z: a.z + (b.z - a.z) * nearest.offset,
        });
      });

      if (
        points.length < 2 ||
        points.some(
          (point: Point) =>
            !Number.isFinite(point.x) || !Number.isFinite(point.z),
        ) ||
        roadLength(points) < 8
      ) {
        throw new Error('Дорога должна иметь хотя бы два разных конца.');
      }

      const contour = roadContour(points, REGION_RULES.roadWidth);

      assertLand(document, contour);

      if (edit.settlementId) {
        withinTown(contour);
      }

      cost = Math.round(roadLength(points) * REGION_RULES.roadCostPerMeter);
      next = {
        ...document,
        roads: [
          ...document.roads,
          {id, points: points.map(point => ({...point}))},
        ],
      };
      createdId = id;
      break;
    }

    case 'block': {
      const yaw = edit.yaw ?? 0;
      const contour = rectangle(edit.center, 34, 34, yaw);

      withinTown(contour);
      assertLand(document, contour);

      if (
        document.roads.some(road =>
          polygonsOverlap(
            contour,
            roadContour(road.points, REGION_RULES.roadWidth),
          ),
        )
      ) {
        throw new Error('Квартал пересекает дорогу.');
      }

      const source = generateCity(document.seed);
      const candidates = source.blocks.filter(
        block =>
          block.district === edit.district &&
          source.buildings.some(
            building =>
              building.blockId === block.id && (!edit.houses || building.plot),
          ),
      );
      const sourceBlock =
        candidates[document.blocks.length % candidates.length];

      if (!sourceBlock) {
        throw new Error('Для квартала нет исходного шаблона.');
      }

      const templates = source.buildings.filter(
        building => building.blockId === sourceBlock.id,
      );
      const block: NativeBlockPlacement = {
        id,
        municipalityId: town!.id,
        sourceSeed: source.seed,
        sourceBlock,
        templates,
        center: edit.center,
        yaw,
        startedAt: seconds,
        duration: 60,
        ...(edit.service === 'school'
          ? {
              overrides: {
                [templates[0]!.id]: {
                  id: `${id}/${templates[0]!.id}`,
                  kind: 'school' as const,
                  name: 'Городская школа',
                },
              },
            }
          : {}),
      };

      cost =
        edit.district === 'industrial'
          ? 20000
          : edit.district === 'downtown'
            ? 40000
            : 10000;
      next = {...document, blocks: [...document.blocks, block]};
      createdId = id;
      break;
    }

    case 'park': {
      const yaw = edit.yaw ?? 0;
      const contour = rectangle(edit.center, 34, 34, yaw);

      withinTown(contour);
      assertLand(document, contour);
      const sourceBlock = generateCity(document.seed).blocks.find(
        block => block.district === 'park',
      )!;
      const space: AuthoredPublicSpace = {
        id,
        municipalityId: town!.id,
        sourceBlock,
        center: edit.center,
        yaw,
      };

      next = {...document, spaces: [...(document.spaces ?? []), space]};
      cost = 5000;
      createdId = id;
      break;
    }

    case 'port': {
      const port = {
        id,
        center: edit.center,
        yaw: edit.yaw,
        warehouseBuildingIds: [`${id}/warehouse-0`, `${id}/warehouse-1`],
      };
      const error = nativePortPlacementError(port, document.terrain);

      if (error) {
        throw new Error(error);
      }

      const navigation = nativePortNavigation(document.terrain, port);

      if (!navigation) {
        throw new Error('Нет водного пути до границы региона.');
      }

      assertLand(document, nativePortFootprint(port).land);
      const infrastructure = document.infrastructure ?? {
        ports: [],
        railways: [],
      };

      next = {
        ...document,
        roads: [...document.roads, ...nativePortRoads(port)],
        infrastructure: {
          ...infrastructure,
          ports: [...infrastructure.ports, {...port, navigation}],
        },
      };
      cost = 200000;
      createdId = id;
      break;
    }

    case 'railway': {
      const railway = {
        id,
        center: edit.center,
        yaw: edit.yaw,
        stationPlaceId: `${id}/station`,
      };

      assertLand(document, nativeRailwayFootprint(railway));
      const infrastructure = document.infrastructure ?? {
        ports: [],
        railways: [],
      };

      next = {
        ...document,
        roads: [...document.roads, ...nativeRailwayAccessRoads(railway)],
        infrastructure: {
          ...infrastructure,
          railways: [...infrastructure.railways, railway],
        },
      };
      cost = 120000;
      createdId = id;
      break;
    }

    case 'entry': {
      const road = document.roads.find(item => item.id === edit.roadId);

      if (!road) {
        throw new Error('Сначала выберите существующую дорогу.');
      }
      if (
        document.entries.some(
          entry => entry.roadId === road.id && entry.endpoint === edit.endpoint,
        )
      ) {
        throw new Error('Этот въезд уже существует.');
      }

      next = {
        ...document,
        entries: [
          ...document.entries,
          {id, roadId: road.id, endpoint: edit.endpoint},
        ],
      };
      createdId = id;
      break;
    }

    case 'upgrade': {
      if (!town?.townHall) {
        throw new Error('Выберите ратушу.');
      }

      const level = TOWN_HALL_LEVELS[townHallLevel(town)];
      const ready = document.blocks.filter(
        block =>
          block.municipalityId === town.id &&
          seconds >= block.startedAt + block.duration,
      ).length;

      if (!level || ready < level.requiredParcels) {
        throw new Error(
          level
            ? `Нужно ${level.requiredParcels} готовых кварталов; сейчас ${ready}.`
            : 'Ратуша достигла последнего уровня.',
        );
      }

      cost = level.cost;
      next = {
        ...document,
        settlements: document.settlements.map(item =>
          item.id === town.id
            ? {...item, townHall: {...town.townHall!, level: level.level}}
            : item,
        ),
      };
      break;
    }

    case 'remove': {
      const infrastructure = document.infrastructure ?? {
        ports: [],
        railways: [],
      };
      const port = infrastructure.ports.find(port => port.id === edit.id);
      const railway = infrastructure.railways.find(
        railway => railway.id === edit.id,
      );
      const space = document.spaces?.find(space => space.id === edit.id);

      if (port || railway || space) {
        const roadIds = new Set(
          port
            ? nativePortRoads(port).map(road => road.id)
            : railway
              ? nativeRailwayAccessRoads(railway).map(road => road.id)
              : [],
        );

        next = {
          ...document,
          spaces: (document.spaces ?? []).filter(space => space.id !== edit.id),
          infrastructure: {
            ports: infrastructure.ports.filter(port => port.id !== edit.id),
            railways: infrastructure.railways.filter(
              railway => railway.id !== edit.id,
            ),
          },
          roads: document.roads.filter(road => !roadIds.has(road.id)),
        };
        break;
      }

      const settlement = document.settlements.find(
        item => item.id === edit.id || item.townHall?.roadId === edit.id,
      );

      if (
        settlement &&
        document.blocks.some(block => block.municipalityId === settlement.id)
      ) {
        throw new Error('Сначала удалите городскую застройку.');
      }

      const removedRoad = settlement?.townHall?.roadId ?? edit.id;

      next = {
        ...document,
        settlements: document.settlements.filter(
          item => item.id !== settlement?.id,
        ),
        blocks: document.blocks.filter(item => item.id !== edit.id),
        roads: document.roads.filter(item => item.id !== removedRoad),
        entries: document.entries.filter(
          item => item.id !== edit.id && item.roadId !== removedRoad,
        ),
      };

      if (
        next.settlements.length === document.settlements.length &&
        next.blocks.length === document.blocks.length &&
        next.roads.length === document.roads.length &&
        next.entries.length === document.entries.length
      ) {
        throw new Error('Выберите объект для сноса.');
      }

      break;
    }
  }

  if (!Number.isFinite(cash) || cost > cash) {
    throw new Error('Недостаточно средств.');
  }

  return {
    document: {
      ...next,
      revision: document.revision + 1,
      nextId: document.nextId + 1,
    },
    cost,
    createdId,
  };
}

const savedPoint = z.object({x: z.number().finite(), z: z.number().finite()});
const district = z.enum([
  'downtown',
  'commercial',
  'residential',
  'industrial',
  'park',
  'railway',
]);
const savedBlock = z.object({
  id: z.string(),
  x: z.number().finite(),
  z: z.number().finite(),
  district,
});
const savedTemplate = z.object({
  id: z.string(),
  blockId: z.string(),
  district,
  name: z.string(),
  color: z.string(),
  x: z.number().finite(),
  z: z.number().finite(),
  width: z.number().positive(),
  depth: z.number().positive(),
  height: z.number().positive(),
  floors: z.number().int().positive(),
  variant: z.string(),
  kit: z.record(z.string(), z.unknown()),
  plot: z.record(z.string(), z.unknown()).optional(),
});
const savedDocument = z.object({
  kind: z.literal('native-region-document'),
  version: z.literal(1),
  id: z.string().min(1),
  seed: z.string().min(1),
  spaces: z
    .array(
      z.object({
        id: z.string(),
        municipalityId: z.string(),
        sourceBlock: savedBlock,
        center: savedPoint,
        yaw: z.number().finite(),
        readyAt: z.number().nonnegative().optional(),
        startedAt: z.number().nonnegative().optional(),
      }),
    )
    .optional(),
  infrastructure: z
    .object({
      ports: z.array(
        z.object({
          id: z.string(),
          center: savedPoint,
          yaw: z.number().finite(),
          source: savedPoint.optional(),
          warehouseBuildingIds: z.array(z.string()),
          navigation: z
            .object({
              speed: z.number().positive(),
              arrivals: z.tuple([
                z.array(savedPoint).min(2),
                z.array(savedPoint).min(2),
              ]),
              departures: z.tuple([
                z.array(savedPoint).min(2),
                z.array(savedPoint).min(2),
              ]),
            })
            .optional(),
        }),
      ),
      railways: z.array(
        z.object({
          id: z.string(),
          center: savedPoint,
          yaw: z.number().finite(),
          source: savedPoint.optional(),
          stationPlaceId: z.string(),
        }),
      ),
    })
    .optional(),
  calendar: z
    .object({
      startingMinute: z.number().finite(),
      secondsPerMinute: z.number().positive(),
    })
    .optional(),
  terrain: z.object({
    seed: z.string(),
    bounds: z.object({
      minX: z.number().finite(),
      maxX: z.number().finite(),
      minZ: z.number().finite(),
      maxZ: z.number().finite(),
    }),
    water: z.array(z.array(savedPoint)),
  }),
  settlements: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      center: savedPoint,
      townHall: z.object({
        roadId: z.string(),
        heading: z.number().finite(),
        level: z.number().int().min(1).max(4),
      }),
    }),
  ),
  roads: z.array(
    z.object({id: z.string(), points: z.array(savedPoint).min(2)}),
  ),
  blocks: z.array(
    z.object({
      id: z.string(),
      municipalityId: z.string(),
      sourceSeed: z.string(),
      sourceBlock: savedBlock,
      templates: z.array(
        z.custom<CityBuilding>(value => savedTemplate.safeParse(value).success),
      ),
      center: savedPoint,
      yaw: z.number().finite(),
      startedAt: z.number().nonnegative(),
      duration: z.number().nonnegative(),
      overrides: z
        .record(
          z.string(),
          z.object({
            id: z.string(),
            kind: z.enum([
              'home',
              'office',
              'factory',
              'shop',
              'cafe',
              'park',
              'school',
              'station',
            ]),
            capacity: z.number().nonnegative().optional(),
            name: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
  entries: z.array(
    z.object({
      id: z.string(),
      roadId: z.string(),
      endpoint: z.enum(['start', 'end']),
    }),
  ),
  revision: z.number().int().nonnegative(),
  nextId: z.number().int().positive(),
});

/** Accept only the editor document shape before mounting its UI from a saved world. */
export function readNativeRegionDocument(
  value: unknown,
): NativeRegionDocument | null {
  const parsed = savedDocument.safeParse(value);

  if (!parsed.success) {
    return null;
  }

  const bounds = parsed.data.terrain.bounds;

  if (bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ) {
    return null;
  }

  const {spaces, infrastructure, calendar, ...document} = parsed.data;

  return {
    ...document,
    ...(calendar ? {calendar} : {}),
    ...(spaces
      ? {
          spaces: spaces.map(({readyAt, startedAt, ...space}) => ({
            ...space,
            ...(readyAt === undefined ? {} : {readyAt}),
            ...(startedAt === undefined ? {} : {startedAt}),
          })),
        }
      : {}),
    ...(infrastructure
      ? {
          infrastructure: {
            ports: infrastructure.ports.map(
              ({source, navigation, ...port}) => ({
                ...port,
                ...(source ? {source} : {}),
                ...(navigation ? {navigation} : {}),
              }),
            ),
            railways: infrastructure.railways.map(({source, ...railway}) => ({
              ...railway,
              ...(source ? {source} : {}),
            })),
          },
        }
      : {}),
  };
}
