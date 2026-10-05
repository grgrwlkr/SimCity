import {generateCity} from '../city/generator';
import type {CityBuilding, CityLayout} from '../city/generator';
import {createAuthoredDefinition} from '../city/life/definition';
import type {
  AuthoredPlacement,
  AuthoredWorldDefinition,
} from '../city/life/definition';
import {RegionRouting} from '../city/life/regionRouting';
import type {NativePortPlacement} from '../city/life/definition';
import {
  createNativePortWarehousePlacements,
  nativePortFootprint,
  nativePortRoads,
} from '../city/life/nativeInfrastructure';
import {nativePortNavigation} from '../city/nativePortNavigation';
import {nativePlacementTransform} from '../city/nativeInfrastructurePlacement';
import {parseRegion} from '../region/model/save';
import {
  convexInteriorsOverlap,
  isDryFootprint,
  rectangle,
} from '../region/model/geometry';
import type {Point, Road} from '../region/model/types';
import type {Terrain} from '../region/model/types';

export const AUTHORIZED_LEGACY_REPLAN_ID =
  'a9e39ac9-250e-4e50-84f8-1b45c2502c4d';

interface ShorePort {
  placement: NativePortPlacement;
}

/** Walk the shoreline and return the first fully legal port site: dry land lot,
 *  quay inside bounds and a real whole-ship navigation route to the region edge. */
function findShorePort(
  terrain: Terrain,
  towns: ReadonlyArray<{center: Point}>,
  buildingFootprints: readonly Point[][],
): ShorePort | null {
  const distances = towns.map(town =>
    Math.hypot(
      town.center.x - (towns[0]?.center.x ?? 0),
      town.center.z - (towns[0]?.center.z ?? 0),
    ),
  );
  const order = terrain.water
    .flatMap((polygon, waterIndex) => {
      const edges: Array<{
        mid: Point;
        nx: number;
        nz: number;
        waterIndex: number;
      }> = [];

      for (let index = 0; index < polygon.length; index++) {
        const a = polygon[index]!;
        const b = polygon[(index + 1) % polygon.length]!;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);

        if (length < 60) {
          continue;
        }

        edges.push({
          mid: {x: (a.x + b.x) / 2, z: (a.z + b.z) / 2},
          nx: -dz / length,
          nz: dx / length,
          waterIndex,
        });
      }

      return edges;
    })
    .sort(
      (first, second) =>
        Math.hypot(
          first.mid.x - (towns[0]?.center.x ?? 0),
          first.mid.z - (towns[0]?.center.z ?? 0),
        ) -
        Math.hypot(
          second.mid.x - (towns[0]?.center.x ?? 0),
          second.mid.z - (towns[0]?.center.z ?? 0),
        ),
    );

  void distances;

  for (const edge of order) {
    for (const side of [1, -1]) {
      // The port anchor hugs the waterline: its quay reaches ~16 m past the
      // anchor into the water, its warehouses stretch ~80 m behind it.
      for (const push of [16, 20, 12, 24, 8, 28, 4, 32, 0, -8, -16]) {
        const center = {
          x: edge.mid.x + side * edge.nx * push,
          z: edge.mid.z + side * edge.nz * push,
        };

        if (
          towns.some(
            town =>
              Math.hypot(town.center.x - center.x, town.center.z - center.z) <
              260,
          )
        ) {
          continue;
        }

        // Face the open water mass, not the shoreline point itself.
        const waterPoint = {
          x: edge.mid.x + side * edge.nx * 60,
          z: edge.mid.z + side * edge.nz * 60,
        };
        const toWater = {
          x: waterPoint.x - center.x,
          z: waterPoint.z - center.z,
        };
        const yaw = Math.atan2(toWater.x, toWater.z);
        const placement: NativePortPlacement = {
          id: 'native-port-migrated',
          center,
          yaw,
          warehouseBuildingIds: [
            'native-port-migrated/warehouse-0',
            'native-port-migrated/warehouse-1',
          ],
        };
        const land = nativePortFootprint(placement).land;

        if (!isDryFootprint(terrain, land)) {
          continue;
        }
        if (
          buildingFootprints.some(shape => convexInteriorsOverlap(land, shape))
        ) {
          continue;
        }

        const navigation = nativePortNavigation(terrain, placement);

        if (!navigation) {
          continue;
        }

        return {placement: {...placement, navigation}};
      }
    }
  }

  return null;
}

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

  // Several procedural source cities keep one assembly from repeating along a
  // row: every pool below is drawn from the original generator, never invented.
  const sources = [
    generateCity(state.seed),
    generateCity(`${state.seed}/v2`),
    generateCity(`${state.seed}/v3`),
  ];
  const pool = (
    test: (building: CityBuilding, city: CityLayout) => boolean,
  ): Array<{template: CityBuilding; city: CityLayout}> =>
    sources.flatMap(city =>
      city.buildings
        .filter(building => test(building, city))
        .map(template => ({template, city})),
    );
  const homes = pool(
    (b, city) =>
      b.district === 'residential' &&
      !b.plot &&
      b.floors >= 6 &&
      b.z > city.blocks.find(block => block.id === b.blockId)!.z,
  );
  const shops = pool(
    (b, city) =>
      b.district === 'commercial' &&
      b.floors >= 6 &&
      b.z > city.blocks.find(block => block.id === b.blockId)!.z,
  );
  const factories = pool(
    b => b.district === 'industrial' && b.variant !== 'warehouse',
  );
  const warehouses = pool(
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

  // Keep native underground parking eligibility while varying full source
  // assemblies by stable address ID; the recent-ring keeps neighbours distinct.
  const RECENT_RING = 10;
  const recent: string[] = [];
  const chooseTemplate = (
    candidates: typeof homes,
    id: string,
  ): (typeof homes)[number] => {
    let hash = 2166136261;

    for (const char of `${state.seed}/${id}`) {
      hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    }

    const start = (hash >>> 0) % candidates.length;

    for (let offset = 0; offset < candidates.length; offset++) {
      const entry = candidates[(start + offset) % candidates.length]!;

      if (!recent.includes(entry.template.id)) {
        return entry;
      }
    }

    return candidates[start]!;
  };

  const roads: Road[] = [];
  const segments = new Set<string>();
  const footprints: Point[][] = [];
  const placements: AuthoredPlacement[] = [];
  const joins: Point[] = [];
  const townEastEdges: Point[] = [];
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

  // Town rows may cross ponds: split the street into short segments and keep the dry ones.
  const addRoadChunked = (a: Point, b: Point): void => {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    const chunks = Math.max(1, Math.ceil(length / 60));

    for (let index = 0; index < chunks; index++) {
      const p0 = {
        x: a.x + dx * (index / chunks),
        z: a.z + dz * (index / chunks),
      };
      const p1 = {
        x: a.x + dx * ((index + 1) / chunks),
        z: a.z + dz * ((index + 1) / chunks),
      };

      try {
        addRoad(p0, p1);
      } catch {
        // A wet stretch simply gets no street; the dry parts keep their front.
      }
    }
  };

  const rowWidth = 520;
  const gap = 1.5;
  const roadHalf = 4;

  for (const town of state.settlements) {
    const buildings = state.life.buildings.filter(
      b => b.settlementId === town.id,
    );
    const queue = [...buildings];
    const startX = town.center.x - rowWidth / 2;
    const endX = startX + rowWidth;
    // The civic junction the hall street must legally plug into (see repairLegacyHallRoads).
    const junctionZ = town.center.z + 68;

    addRoadChunked(
      {x: startX - roadHalf * 2, z: junctionZ},
      {
        x: town.center.x,
        z: junctionZ,
      },
    );
    addRoadChunked(
      {x: town.center.x, z: junctionZ},
      {
        x: endX + roadHalf * 2,
        z: junctionZ,
      },
    );

    const reservation = rectangle(town.center, 96, 80);
    // The hall link street drops from the starter road through this corridor;
    // document block reservations reach 17 m past a building, so keep them clear.
    const hallLink = rectangle({x: town.center.x, z: junctionZ - 10}, 52, 44);
    let cursorX = startX;
    let cursorZ = junctionZ + 12;
    let rowDepth = 0;

    // SimCity-style growth: every house takes only its own footprint; the next
    // house fills whatever is left beside it until the row closes at a street.
    const closeRow = (): void => {
      if (rowDepth > 0) {
        addRoadChunked(
          {x: startX - roadHalf * 2, z: cursorZ + rowDepth + roadHalf},
          {x: endX + roadHalf * 2, z: cursorZ + rowDepth + roadHalf},
        );
      }

      cursorZ += rowDepth + roadHalf * 2 + 2;
      cursorX = startX;
      rowDepth = 0;
    };

    while (queue.length > 0) {
      const building = queue[0]!;
      const candidates =
        building.kind === 'residential'
          ? homes
          : building.kind === 'commercial'
            ? shops
            : building.kind === 'industrial'
              ? factories
              : warehouses;
      const entry = chooseTemplate(candidates, building.id);
      const template = entry.template;
      const center = {
        x: cursorX + template.width / 2,
        z: cursorZ + template.depth / 2,
      };

      // The row ends at its street: an overflowing house wraps to the next row
      // instead of leaning into the perimeter street.
      if (center.x + template.width / 2 > endX) {
        closeRow();

        if (cursorZ > state.terrain.bounds.maxZ - 60) {
          throw new Error(
            'Полные нативные здания не помещаются на сухой земле этого тестового мира.',
          );
        }

        continue;
      }

      const footprint = rectangle(center, template.width, template.depth);
      const fits =
        isDryFootprint(state.terrain, footprint) &&
        !convexInteriorsOverlap(footprint, reservation) &&
        !convexInteriorsOverlap(rectangle(center, 34, 34), hallLink) &&
        !footprints.some(other => convexInteriorsOverlap(footprint, other));

      if (!fits) {
        // Wet or taken ground: the skipped width stays empty, the queue head
        // tries the next opening; close the row first when it ran out.
        cursorX += template.width + gap;

        if (cursorX - startX >= rowWidth) {
          closeRow();
        }

        if (cursorZ > state.terrain.bounds.maxZ - 60) {
          throw new Error(
            'Полные нативные здания не помещаются на сухой земле этого тестового мира.',
          );
        }

        continue;
      }

      queue.shift();
      recent.push(template.id);

      if (recent.length > RECENT_RING) {
        recent.shift();
      }

      placements.push({
        id: building.id,
        municipalityId: town.id,
        template,
        sourceBlock: entry.city.blocks.find(
          block => block.id === template.blockId,
        )!,
        center,
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
        standalone: true,
      });
      footprints.push(footprint);
      rowDepth = Math.max(rowDepth, template.depth);
      cursorX += template.width + gap;

      if (cursorX - startX >= rowWidth) {
        closeRow();
      }
    }

    closeRow();
    joins.push({x: startX, z: junctionZ});
    townEastEdges.push({
      x: endX + roadHalf * 2,
      z: junctionZ + (cursorZ - junctionZ) / 2,
    });

    const west = {x: startX - roadHalf * 2, z: junctionZ};

    addRoadChunked(west, {x: west.x, z: cursorZ});
    addRoadChunked(
      {x: endX + roadHalf * 2, z: junctionZ},
      {
        x: endX + roadHalf * 2,
        z: cursorZ,
      },
    );
  }

  for (let index = 1; index < joins.length; index++) {
    const previous = joins[index - 1]!;
    const join = joins[index]!;
    const previousEast = previous.x + rowWidth + roadHalf * 2;

    if (previous.z === join.z) {
      addRoadChunked(
        {x: previousEast, z: previous.z},
        {x: join.x - roadHalf * 2, z: join.z},
      );
    } else {
      addRoadChunked(
        {x: previousEast, z: previous.z},
        {
          x: previousEast,
          z: join.z,
        },
      );
      addRoadChunked(
        {x: previousEast, z: join.z},
        {
          x: join.x - roadHalf * 2,
          z: join.z,
        },
      );
    }
  }

  const first = joins[0];

  if (!first) {
    throw new Error('В тестовом сохранении нет поселений.');
  }

  const boundary = {x: state.terrain.bounds.minX + 4, z: first.z};

  addRoadChunked(boundary, {x: first.x - roadHalf * 2, z: first.z});

  // The authorized world is «Город у воды»: scan the shoreline for a legal
  // full-body port with real ship navigation, nearest to the first town.
  // Inland water with no ship route to the edge simply gets no port.
  const portCandidate = findShorePort(
    state.terrain,
    state.settlements,
    footprints,
  );
  const infrastructure = portCandidate
    ? {ports: [portCandidate.placement], railways: []}
    : undefined;
  const port = portCandidate?.placement;

  if (port) {
    const portRoads = nativePortRoads(port);
    const warehouses = createNativePortWarehousePlacements(state.seed, port);

    roads.push(...portRoads);
    placements.push(...warehouses);

    const portGate = nativePlacementTransform(port, {
      x: 85,
      z: 135,
    }).toWorld({x: 85, z: 140});
    const link = townEastEdges.reduce((best, edge) =>
      Math.hypot(edge.x - portGate.x, edge.z - portGate.z) <
      Math.hypot(best.x - portGate.x, best.z - portGate.z)
        ? edge
        : best,
    );
    const blocked = warehouses.map(warehouse =>
      rectangle(
        warehouse.center,
        warehouse.template.width,
        warehouse.template.depth,
      ),
    );
    const clearTo = (target: Point): boolean => {
      const samples = 24;

      for (let index = 0; index <= samples; index++) {
        const t = index / samples;
        const point = {
          x: link.x + (target.x - link.x) * t,
          z: link.z + (target.z - link.z) * t,
        };

        if (
          blocked.some(shape =>
            convexInteriorsOverlap(rectangle(point, 8, 8), shape),
          )
        ) {
          return false;
        }
      }

      return true;
    };
    const gates = [
      portGate,
      ...portRoads.flatMap(road => [road.points[0]!, road.points.at(-1)!]),
    ];
    const gate = gates.find(candidate => clearTo(candidate));

    if (gate) {
      addRoadChunked(link, gate);
    }
  }

  const definition = createAuthoredDefinition({
    seed: state.seed,
    roads,
    placements,
    bounds: state.terrain.bounds,
    ...(infrastructure ? {infrastructure} : {}),
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
