import {generateCity} from '../city/generator';
import {createAuthoredDefinition} from '../city/life/definition';
import type {
  AuthoredPlacement,
  AuthoredWorldDefinition,
} from '../city/life/definition';
import {RegionRouting} from '../city/life/regionRouting';
import {parseRegion} from '../region/model/save';
import {
  convexInteriorsOverlap,
  isDryFootprint,
  rectangle,
} from '../region/model/geometry';
import type {Point, Road} from '../region/model/types';

export const AUTHORIZED_LEGACY_REPLAN_ID =
  'a9e39ac9-250e-4e50-84f8-1b45c2502c4d';

/** The user authorized rebuilding this one acceptance save, never arbitrary manual worlds. */
export function replanAuthorizedLegacyLayout(
  value: unknown,
): AuthoredWorldDefinition {
  const state = parseRegion(value);

  if (state.id !== AUTHORIZED_LEGACY_REPLAN_ID) {
    throw new Error(
      'Перестройка разрешена только для конкретного тестового сохранения.',
    );
  }

  const source = generateCity(state.seed);
  const homes = source.buildings.filter(
    b =>
      b.district === 'residential' &&
      !b.plot &&
      b.floors >= 6 &&
      b.z > source.blocks.find(block => block.id === b.blockId)!.z,
  );
  const shops = source.buildings.filter(
    b =>
      b.district === 'commercial' &&
      b.floors >= 6 &&
      b.z > source.blocks.find(block => block.id === b.blockId)!.z,
  );
  const factories = source.buildings.filter(
    b => b.district === 'industrial' && b.variant !== 'warehouse',
  );
  const warehouses = source.buildings.filter(
    b => b.district === 'industrial' && b.variant === 'warehouse',
  );

  if (
    !homes.length ||
    !shops.length ||
    !factories.length ||
    !warehouses.length
  ) {
    throw new Error(
      'Нет полного исходного набора моделей для переноса тестового мира.',
    );
  }

  // Keep native underground parking eligibility while varying full source assemblies by stable address ID.
  const chooseTemplate = (pool: typeof source.buildings, id: string) => {
    let hash = 2166136261;

    for (const char of `${state.seed}/${id}`) {
      hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    }

    return pool[(hash >>> 0) % pool.length]!;
  };

  const roads: Road[] = [];
  const segments = new Set<string>();
  const footprints: Point[][] = [];
  const placements: AuthoredPlacement[] = [];
  const joins: Point[] = [];
  const addRoad = (a: Point, b: Point): void => {
    const points = [a, b];
    const key = points
      .map(p => `${p.x}/${p.z}`)
      .sort()
      .join('|');

    if (segments.has(key)) {
      return;
    }

    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    const footprint = rectangle(
      {x: (a.x + b.x) / 2, z: (a.z + b.z) / 2},
      8,
      length,
      Math.atan2(dx, dz),
    );

    if (!isDryFootprint(state.terrain, footprint)) {
      throw new Error(
        'Новая дорога тестового мира пересекает воду или границу.',
      );
    }

    segments.add(key);
    roads.push({id: `native-road-${roads.length + 1}`, points});
  };

  for (const town of state.settlements) {
    const buildings = state.life.buildings.filter(
      b => b.settlementId === town.id,
    );
    const side = 2 * Math.ceil(Math.sqrt(buildings.length + 20) / 2);
    const west = town.center.x - side * 17;
    const north = town.center.z - side * 17;
    const reservation = rectangle(town.center, 96, 80);
    let next = 0;

    joins.push({x: west, z: north});

    for (let row = 0; row < side && next < buildings.length; row++) {
      for (let column = 0; column < side && next < buildings.length; column++) {
        const center = {x: west + column * 34 + 17, z: north + row * 34 + 17};
        const footprint = rectangle(center, 26, 26);

        if (
          !isDryFootprint(state.terrain, footprint) ||
          convexInteriorsOverlap(footprint, reservation) ||
          footprints.some(other => convexInteriorsOverlap(footprint, other))
        ) {
          continue;
        }

        const building = buildings[next++]!;
        const pool =
          building.kind === 'residential'
            ? homes
            : building.kind === 'commercial'
              ? shops
              : building.kind === 'industrial'
                ? factories
                : warehouses;
        const template = chooseTemplate(pool, building.id);
        const block = source.blocks.find(
          block => block.id === template.blockId,
        )!;

        placements.push({
          id: building.id,
          municipalityId: town.id,
          template,
          sourceBlock: block,
          center: {
            x: center.x + template.x - block.x,
            z: center.z + template.z - block.z,
          },
          yaw: 0,
          kind:
            building.kind === 'residential'
              ? 'home'
              : building.kind === 'commercial'
                ? 'shop'
                : 'factory',
          capacity:
            building.kind === 'residential'
              ? Math.max(1, Math.floor(building.capacity / 4))
              : building.jobs,
        });
        footprints.push(footprint);
        const corners = rectangle(center, 34, 34);

        for (let index = 0; index < corners.length; index++) {
          addRoad(corners[index]!, corners[(index + 1) % corners.length]!);
        }
      }
    }

    if (next !== buildings.length) {
      throw new Error(
        'Полные нативные кварталы не помещаются на сухой земле этого тестового мира.',
      );
    }
  }

  const connectorZ = Math.min(...joins.map(point => point.z)) - 34;

  for (const point of joins) {
    addRoad(point, {x: point.x, z: connectorZ});
  }

  for (let index = 1; index < joins.length; index++) {
    addRoad(
      {x: joins[index - 1]!.x, z: connectorZ},
      {x: joins[index]!.x, z: connectorZ},
    );
  }

  const first = joins[0];

  if (!first) {
    throw new Error('В тестовом сохранении нет поселений.');
  }

  const boundary = {x: state.terrain.bounds.minX + 4, z: first.z};

  addRoad(boundary, first);
  const definition = createAuthoredDefinition({
    seed: state.seed,
    roads,
    placements,
    bounds: state.terrain.bounds,
    metadata: {
      legacyReplan: {
        authorizedId: state.id,
        blockFootprints: footprints,
        originalRoads: state.roads,
      },
    },
  });
  const routing = new RegionRouting(definition.layout, roads);

  if (!state.externalEntries.length) {
    return definition;
  }

  const terminal = definition.profile.facilities
    .filter(
      f =>
        f.kind === 'street' || (f.kind === 'underground' && !f.residentsOnly),
    )
    .sort(
      (a, b) =>
        Math.hypot(a.entrance.x - boundary.x, a.entrance.z - boundary.z) -
        Math.hypot(b.entrance.x - boundary.x, b.entrance.z - boundary.z),
    )[0];

  if (!terminal) {
    throw new Error(
      'Нет действительной исходной общественной facility для автобусного въезда.',
    );
  }

  const entry = {
    id: state.externalEntries[0]?.id ?? 'native-external-entry',
    access: routing.roadAccess(boundary, 1),
    exit: routing.roadAccess(boundary, -1),
    terminalFacilityId: terminal.id,
  };

  return {
    ...definition,
    profile: {...definition.profile, arrival: entry.access},
    entries: [entry],
  };
}
