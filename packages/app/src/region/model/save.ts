import type {RegionalLifeState} from './life/types';
import {createRegionalLife} from './life/state';
import {regionalLifeSchema, validateRegionalLife} from './life/save';
import type {RegionState} from './types';
import {z} from 'zod';
import {
  containsPoint,
  convexInteriorsOverlap,
  distance,
  isDryFootprint,
  rectangle,
  projectSegment,
  polygonsOverlap,
} from './geometry';
import {hasRoadOverlap, roadContour} from './roads';
import {WAREHOUSE_DEPTH, WAREHOUSE_WIDTH, ROAD_SIDEWALK_WIDTH} from './rules';
import {frontagePoint} from './parcels';
import {townHallReservation, townHallRoadPoints} from './townHall';

const point = z
  .object({x: z.number().finite(), z: z.number().finite()})
  .strict();
const id = z.string().min(1).max(128);
const access = z
  .object({
    roadId: id,
    segment: z.number().int().nonnegative(),
    offset: z.number().min(0).max(1),
  })
  .strict()
  .nullable();
const rules = z
  .object({
    startingCash: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    roadCostPerMeter: z.number().positive().finite(),
    warehouseCost: z.number().int().nonnegative(),
    roadWidth: z.number().positive().finite(),
    snapDistance: z.number().nonnegative().finite(),
  })
  .strict();
const bounds = z
  .object({
    minX: z.number().finite(),
    maxX: z.number().finite(),
    minZ: z.number().finite(),
    maxZ: z.number().finite(),
  })
  .strict();
const editorSchema = z
  .object({
    schemaVersion: z.literal(2),
    id,
    seed: z.string().min(1).max(32),
    terrain: z
      .object({seed: z.string(), bounds, water: z.array(z.array(point).min(3))})
      .strict(),
    rules,
    revision: z.number().int().nonnegative(),
    roadRevision: z.number().int().nonnegative(),
    nextId: z.number().int().positive(),
    cash: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    settlements: z.array(
      z
        .object({
          id,
          name: z.string().trim().min(1).max(64),
          center: point,
          townHall: z
            .object({
              roadId: id,
              heading: z.number().finite(),
              level: z.number().int().min(1).max(4).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    roads: z.array(z.object({id, points: z.array(point).min(2)}).strict()),
    parcels: z.array(
      z
        .object({
          id,
          settlementId: id,
          center: point,
          heading: z.number().finite(),
          width: z.number().positive().finite(),
          depth: z.number().positive().finite(),
          zone: z.enum(['residential', 'commercial', 'industrial']),
          access,
        })
        .strict(),
    ),
    warehouses: z.array(
      z
        .object({
          id,
          settlementId: id,
          center: point,
          heading: z.number().finite(),
          access,
        })
        .strict(),
    ),
    externalEntries: z.array(
      z.object({id, roadId: id, endpoint: z.enum(['start', 'end'])}).strict(),
    ),
  })
  .strict();

const stateSchema = editorSchema.extend({
  schemaVersion: z.literal(3),
  life: regionalLifeSchema,
});

export function serializeRegion(state: RegionState): string {
  return JSON.stringify({kind: 'simcity-region', version: 3, state});
}

export function parseRegion(value: unknown): RegionState {
  const raw: unknown =
    typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

  if (
    typeof raw === 'object' &&
    raw !== null &&
    'kind' in raw &&
    raw.kind === 'simcity-region' &&
    'version' in raw &&
    raw.version !== 1 &&
    raw.version !== 2 &&
    raw.version !== 3
  ) {
    throw new Error('Неподдерживаемая версия сохранения региона');
  }

  const legacyStateSchema = editorSchema.extend({
    schemaVersion: z.literal(1),
    settlements: z.array(
      z
        .object({
          id,
          name: z.string().trim().min(1).max(64),
          center: point,
        })
        .strict(),
    ),
  });
  const parsed = z
    .discriminatedUnion('version', [
      z
        .object({
          kind: z.literal('simcity-region'),
          version: z.literal(1),
          state: legacyStateSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('simcity-region'),
          version: z.literal(2),
          state: editorSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('simcity-region'),
          version: z.literal(3),
          state: stateSchema,
        })
        .strict(),
    ])
    .safeParse(raw);

  if (!parsed.success) {
    throw new Error('Повреждённое сохранение региона');
  }

  const decoded: Omit<z.infer<typeof stateSchema>, 'life'> & {
    life: RegionalLifeState;
  } = {
    ...parsed.data.state,
    schemaVersion: 3,
    life:
      parsed.data.version === 3
        ? parsed.data.state.life
        : createRegionalLife(parsed.data.state.cash),
  };
  const state: RegionState = {
    ...decoded,
    settlements: decoded.settlements.map(({townHall, ...settlement}) =>
      townHall
        ? {
            ...settlement,
            townHall: {
              roadId: townHall.roadId,
              heading: townHall.heading,
              ...(townHall.level === undefined ? {} : {level: townHall.level}),
            },
          }
        : settlement,
    ),
  };
  const b = state.terrain.bounds;
  const fail = () => {
    throw new Error('Повреждённые связи или геометрия сохранения региона');
  };

  if (
    b.minX !== -2000 ||
    b.maxX !== 2000 ||
    b.minZ !== -2000 ||
    b.maxZ !== 2000
  ) {
    fail();
  }
  if (
    b.maxX <= b.minX ||
    b.maxZ <= b.minZ ||
    state.terrain.seed !== state.seed ||
    state.roadRevision > state.revision
  ) {
    fail();
  }

  const entities = [
    ...state.settlements,
    ...state.roads,
    ...state.parcels,
    ...state.warehouses,
    ...state.externalEntries,
  ];

  if (new Set(entities.map(e => e.id)).size !== entities.length) {
    fail();
  }

  for (const e of entities) {
    const counter = Number(e.id.split('-').at(-1));

    if (
      !Number.isSafeInteger(counter) ||
      counter < 1 ||
      counter >= state.nextId
    ) {
      fail();
    }
  }

  for (const settlement of state.settlements) {
    if (!isDryFootprint(state.terrain, rectangle(settlement.center, 1, 1))) {
      fail();
    }
    if (settlement.townHall) {
      const reservation = townHallReservation(settlement);
      const ownedRoad = state.roads.find(
        road => road.id === settlement.townHall!.roadId,
      );
      const expected = townHallRoadPoints(
        settlement.center,
        settlement.townHall.heading,
      );

      if (
        !isDryFootprint(state.terrain, reservation) ||
        !ownedRoad ||
        ownedRoad.points.length !== 2 ||
        ownedRoad.points.some(
          (p, index) => distance(p, expected[index]!) > 0.011,
        ) ||
        state.settlements.some(
          other =>
            other.id !== settlement.id &&
            (other.townHall?.roadId === settlement.townHall!.roadId ||
              polygonsOverlap(reservation, townHallReservation(other))),
        ) ||
        state.roads.some(
          road =>
            road.id !== ownedRoad.id &&
            polygonsOverlap(
              reservation,
              roadContour(
                road.points,
                state.rules.roadWidth + 2 * ROAD_SIDEWALK_WIDTH,
              ),
            ),
        ) ||
        state.parcels.some(lot =>
          convexInteriorsOverlap(
            reservation,
            rectangle(lot.center, lot.width, lot.depth, lot.heading),
          ),
        ) ||
        state.warehouses.some(lot =>
          polygonsOverlap(
            reservation,
            rectangle(
              lot.center,
              WAREHOUSE_WIDTH,
              WAREHOUSE_DEPTH,
              lot.heading,
            ),
          ),
        )
      ) {
        fail();
      }
    }
  }

  for (const water of state.terrain.water) {
    if (water.some(p => !containsPoint(b, p))) {
      fail();
    }
  }

  for (const [index, road] of state.roads.entries()) {
    if (hasRoadOverlap(state.roads.slice(0, index), road.points)) {
      fail();
    }

    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!;
      const c = road.points[i]!;
      const length = distance(a, c);

      if (length < 0.01 || !containsPoint(b, a) || !containsPoint(b, c)) {
        fail();
      }

      const contour = rectangle(
        {x: (a.x + c.x) / 2, z: (a.z + c.z) / 2},
        state.rules.roadWidth + 2 * ROAD_SIDEWALK_WIDTH,
        length,
        -Math.atan2(c.z - a.z, c.x - a.x) + Math.PI / 2,
      );

      if (!isDryFootprint(state.terrain, contour)) {
        fail();
      }
    }
  }

  const lots = [
    ...state.parcels.map(lot => ({lot, width: lot.width, depth: lot.depth})),
    ...state.warehouses.map(lot => ({
      lot,
      width: WAREHOUSE_WIDTH,
      depth: WAREHOUSE_DEPTH,
    })),
  ];

  for (const {lot, width, depth} of lots) {
    if (!state.settlements.some(s => s.id === lot.settlementId)) {
      fail();
    }
    if (
      !isDryFootprint(
        state.terrain,
        rectangle(lot.center, width, depth, lot.heading),
      )
    ) {
      fail();
    }
    if (lot.access) {
      const road = state.roads.find(r => r.id === lot.access?.roadId);

      if (!road || lot.access.segment >= road.points.length - 1) {
        fail();
      }

      const a = road!.points[lot.access.segment]!;
      const c = road!.points[lot.access.segment + 1]!;
      const projection = projectSegment(
        frontagePoint(lot.center, lot.heading, depth),
        a,
        c,
      );

      if (
        projection.distance > 6 + state.rules.snapDistance + 0.01 ||
        Math.abs(projection.t - lot.access.offset) * distance(a, c) > 0.02
      ) {
        fail();
      }
    }
  }

  for (const entry of state.externalEntries) {
    const road = state.roads.find(r => r.id === entry.roadId);

    if (!road) {
      fail();
    }

    const p =
      road!.points[entry.endpoint === 'start' ? 0 : road!.points.length - 1]!;

    if (
      Math.min(
        Math.abs(p.x - b.minX),
        Math.abs(p.x - b.maxX),
        Math.abs(p.z - b.minZ),
        Math.abs(p.z - b.maxZ),
      ) > 0.011
    ) {
      fail();
    }
  }

  validateRegionalLife(state);

  return state;
}
