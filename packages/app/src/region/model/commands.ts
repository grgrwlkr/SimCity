import {removeRegionalObject} from './life/lifecycle';
import type {
  CommandResult,
  Point,
  Preview,
  RegionAction,
  RegionState,
  RejectReason,
} from './types';
import {
  containsPoint,
  distance,
  isDryFootprint,
  normalizePoint,
  polygonsOverlap,
  rectangle,
  validPoint,
} from './geometry';
import {
  hasRoadOverlap,
  nearestRoadAccess,
  roadContour,
  roadLength,
} from './roads';
import {
  occupiedContours,
  refreshAccess,
  warehouseDraft,
  zoneCandidates,
} from './parcels';
import {
  WAREHOUSE_DEPTH,
  WAREHOUSE_WIDTH,
  ROAD_SIDEWALK_WIDTH,
  TOWN_HALL_ROAD_LENGTH,
} from './rules';
import {isWithinSettlement, townHallUpgrade} from './territory';
import {townHallReservation, townHallRoadPoints} from './townHall';

function snap(state: RegionState, p: Point): Point {
  let point = normalizePoint(p);
  let best = state.rules.snapDistance;

  for (const road of state.roads) {
    for (const q of road.points) {
      const d = distance(p, q);

      if (d <= best) {
        point = q;
        best = d;
      }
    }
  }

  const access = nearestRoadAccess(
    state.roads,
    point,
    state.rules.snapDistance,
  );

  if (access) {
    const road = state.roads.find(r => r.id === access.roadId)!;
    const a = road.points[access.segment]!;
    const b = road.points[access.segment + 1]!;

    point = normalizePoint({
      x: a.x + (b.x - a.x) * access.offset,
      z: a.z + (b.z - a.z) * access.offset,
    });
  }

  return point;
}

export function applyAction(
  state: RegionState,
  action: RegionAction,
  expectedRevision: number,
): CommandResult {
  const reject = (reason: RejectReason): CommandResult => ({
    ok: false,
    state,
    reason,
  });
  const commit = (
    next: RegionState,
    created: readonly string[] = [],
    cost = 0,
  ): CommandResult => ({
    ok: true,
    state: {
      ...next,
      revision: state.revision + 1,
      cash: next.cash - cost,
      life:
        cost === 0
          ? next.life
          : {
              ...next.life,
              economy: {
                ...next.life.economy,
                externalMoney: next.life.economy.externalMoney + cost,
                constructionPaid: next.life.economy.constructionPaid + cost,
              },
            },
    },
    created,
    cost,
  });
  const id = (prefix: string) => prefix + '-' + state.nextId;

  if (expectedRevision !== state.revision) {
    return reject('stale-revision');
  }

  switch (action.type) {
    case 'found': {
      if (
        !validPoint(action.center) ||
        !action.name.trim() ||
        action.name.trim().length > 64
      ) {
        return reject('invalid-input');
      }

      const center = normalizePoint(action.center);

      const key = id('settlement');
      const roadId = 'road-' + (state.nextId + 1);
      const settlement = {
        id: key,
        name: action.name.trim(),
        center,
        townHall: {roadId, heading: 0, level: 1},
      };
      const points = townHallRoadPoints(center);
      const reservation = townHallReservation(settlement);
      const frontage = roadContour(
        points,
        state.rules.roadWidth + 2 * ROAD_SIDEWALK_WIDTH,
      );
      const contours = [reservation, frontage];

      if (
        contours.some(contour =>
          contour.some(p => !containsPoint(state.terrain.bounds, p)),
        )
      ) {
        return reject('outside');
      }
      if (contours.some(contour => !isDryFootprint(state.terrain, contour))) {
        return reject('water');
      }
      if (
        occupiedContours(state).some(occupied =>
          contours.some(contour => polygonsOverlap(contour, occupied)),
        ) ||
        state.roads.some(road =>
          polygonsOverlap(
            reservation,
            roadContour(
              road.points,
              state.rules.roadWidth + 2 * ROAD_SIDEWALK_WIDTH,
            ),
          ),
        )
      ) {
        return reject('occupied');
      }
      if (hasRoadOverlap(state.roads, points)) {
        return reject('overlap');
      }

      const cost = Math.ceil(
        TOWN_HALL_ROAD_LENGTH * state.rules.roadCostPerMeter,
      );

      if (cost > state.cash) {
        return reject('insufficient-funds');
      }

      return commit(
        refreshAccess({
          ...state,
          nextId: state.nextId + 2,
          roadRevision: state.roadRevision + 1,
          settlements: [...state.settlements, settlement],
          roads: [...state.roads, {id: roadId, points}],
        }),
        [key, roadId],
        cost,
      );
    }

    case 'upgrade-town-hall': {
      const settlement = state.settlements.find(
        s => s.id === action.settlementId,
      );

      if (!settlement?.townHall) {
        return reject('no-settlement');
      }

      const upgrade = townHallUpgrade(state, settlement.id);

      if (!upgrade) {
        return reject('max-level');
      }
      if (upgrade.preparedParcels < upgrade.requiredParcels) {
        return reject('upgrade-requirements');
      }
      if (state.cash < upgrade.cost) {
        return reject('insufficient-funds');
      }

      return commit(
        {
          ...state,
          settlements: state.settlements.map(s =>
            s.id === settlement.id
              ? {
                  ...settlement,
                  townHall: {...settlement.townHall!, level: upgrade.level},
                }
              : s,
          ),
        },
        [],
        upgrade.cost,
      );
    }

    case 'road': {
      const settlement = state.settlements.find(
        s => s.id === action.settlementId,
      );

      if (action.settlementId !== undefined && !settlement) {
        return reject('no-settlement');
      }

      if (action.points.length < 2 || action.points.some(p => !validPoint(p))) {
        return reject('invalid-input');
      }

      const points = action.points.map(p => snap(state, p));

      if (points.some((p, i) => i > 0 && distance(p, points[i - 1]!) < 0.01)) {
        return reject('invalid-input');
      }
      if (points.some(p => !containsPoint(state.terrain.bounds, p))) {
        return reject('outside');
      }
      if (hasRoadOverlap(state.roads, points)) {
        return reject('overlap');
      }

      const contour = roadContour(
        points,
        state.rules.roadWidth + 2 * ROAD_SIDEWALK_WIDTH,
      );

      if (settlement && !isWithinSettlement(settlement, contour)) {
        return reject('outside-city');
      }
      if (contour.some(p => !containsPoint(state.terrain.bounds, p))) {
        return reject('outside');
      }
      if (!isDryFootprint(state.terrain, contour)) {
        return reject('water');
      }
      if (occupiedContours(state).some(p => polygonsOverlap(contour, p))) {
        return reject('occupied');
      }

      const cost = Math.ceil(roadLength(points) * state.rules.roadCostPerMeter);

      if (cost > state.cash) {
        return reject('insufficient-funds');
      }

      const key = id('road');

      return commit(
        refreshAccess({
          ...state,
          nextId: state.nextId + 1,
          roadRevision: state.roadRevision + 1,
          roads: [...state.roads, {id: key, points}],
        }),
        [key],
        cost,
      );
    }

    case 'zone': {
      const settlement = state.settlements.find(
        s => s.id === action.settlementId,
      );

      if (!settlement) {
        return reject('no-settlement');
      }

      const b = action.selection;

      if (
        ![b.minX, b.maxX, b.minZ, b.maxZ].every(Number.isFinite) ||
        b.maxX < b.minX ||
        b.maxZ < b.minZ
      ) {
        return reject('invalid-input');
      }

      const candidates = zoneCandidates(state, b, settlement).filter(
        candidate =>
          candidate.access !== null &&
          !state.life.closingRoadIds.includes(candidate.access.roadId),
      );

      if (!candidates.length) {
        return reject(
          zoneCandidates(state, b).length ? 'outside-city' : 'no-road',
        );
      }

      let nextId = state.nextId;
      const parcels = [...state.parcels];
      const created: string[] = [];

      for (const draft of candidates) {
        const index = parcels.findIndex(
          p => distance(p.center, draft.center) < 0.01,
        );

        if (index >= 0) {
          const previous = parcels[index]!;
          const occupied = state.life.buildings.some(
            building => building.lotId === previous.id,
          );

          parcels[index] = {
            ...previous,
            zone: action.kind,
            settlementId: occupied
              ? previous.settlementId
              : action.settlementId,
          };
        } else {
          const key = 'parcel-' + nextId++;

          created.push(key);
          parcels.push({
            ...draft,
            id: key,
            settlementId: action.settlementId,
            zone: action.kind,
          });
        }
      }

      return commit({...state, nextId, parcels}, created);
    }

    case 'warehouse': {
      const settlement = state.settlements.find(
        s => s.id === action.settlementId,
      );

      if (!settlement) {
        return reject('no-settlement');
      }
      if (!validPoint(action.center)) {
        return reject('invalid-input');
      }

      const draft = warehouseDraft(state, action.center);

      if (
        !draft ||
        (draft.access !== null &&
          state.life.closingRoadIds.includes(draft.access.roadId))
      ) {
        return reject('no-road');
      }

      const contour = rectangle(
        draft.center,
        WAREHOUSE_WIDTH,
        WAREHOUSE_DEPTH,
        draft.heading,
      );

      if (!isWithinSettlement(settlement, contour)) {
        return reject('outside-city');
      }
      if (contour.some(p => !containsPoint(state.terrain.bounds, p))) {
        return reject('outside');
      }
      if (!isDryFootprint(state.terrain, contour)) {
        return reject('water');
      }
      if (
        occupiedContours(state).some(p => polygonsOverlap(contour, p)) ||
        state.roads.some(r =>
          polygonsOverlap(
            contour,
            roadContour(r.points, state.rules.roadWidth),
          ),
        )
      ) {
        return reject('occupied');
      }
      if (state.cash < state.rules.warehouseCost) {
        return reject('insufficient-funds');
      }

      const key = id('warehouse');

      return commit(
        {
          ...state,
          nextId: state.nextId + 1,
          warehouses: [
            ...state.warehouses,
            {...draft, id: key, settlementId: action.settlementId},
          ],
        },
        [key],
        state.rules.warehouseCost,
      );
    }

    case 'external-entry': {
      const road = state.roads.find(r => r.id === action.roadId);

      if (!road) {
        return reject('not-found');
      }
      if (state.life.closingRoadIds.includes(road.id)) {
        return reject('no-road');
      }
      if (
        state.externalEntries.some(
          e => e.roadId === road.id && e.endpoint === action.endpoint,
        )
      ) {
        return reject('overlap');
      }

      const p =
        road.points[action.endpoint === 'start' ? 0 : road.points.length - 1]!;
      const b = state.terrain.bounds;

      if (
        Math.min(
          Math.abs(p.x - b.minX),
          Math.abs(p.x - b.maxX),
          Math.abs(p.z - b.minZ),
          Math.abs(p.z - b.maxZ),
        ) > 0.011
      ) {
        return reject('not-boundary');
      }

      const key = id('entry');

      return commit(
        {
          ...state,
          nextId: state.nextId + 1,
          roadRevision: state.roadRevision + 1,
          externalEntries: [
            ...state.externalEntries,
            {id: key, roadId: road.id, endpoint: action.endpoint},
          ],
        },
        [key],
      );
    }

    case 'remove': {
      const result = removeRegionalObject(state, action.id);

      return 'reason' in result ? reject(result.reason) : commit(result.state);
    }
  }
}

export function previewAction(
  state: RegionState,
  action: RegionAction,
): Preview {
  const result = applyAction(state, action, state.revision);
  let contours: ReadonlyArray<readonly Point[]> = [];
  let cost = result.ok ? result.cost : 0;

  if (action.type === 'found' && validPoint(action.center)) {
    const center = normalizePoint(action.center);
    const points = townHallRoadPoints(center);

    contours = [
      townHallReservation({center, townHall: {roadId: '', heading: 0}}),
      roadContour(points, state.rules.roadWidth + 2 * ROAD_SIDEWALK_WIDTH),
    ];
    cost = Math.ceil(TOWN_HALL_ROAD_LENGTH * state.rules.roadCostPerMeter);
  }
  if (action.type === 'road' && action.points.every(validPoint)) {
    const points = action.points.map(p => snap(state, p));

    contours = [
      roadContour(points, state.rules.roadWidth + 2 * ROAD_SIDEWALK_WIDTH),
    ];
    cost = Math.ceil(roadLength(points) * state.rules.roadCostPerMeter);
  }
  if (action.type === 'zone') {
    const settlement = state.settlements.find(
      s => s.id === action.settlementId,
    );

    contours = (
      settlement ? zoneCandidates(state, action.selection, settlement) : []
    ).map(p => rectangle(p.center, p.width, p.depth, p.heading));
  }
  if (action.type === 'upgrade-town-hall') {
    cost = townHallUpgrade(state, action.settlementId)?.cost ?? 0;
  }
  if (action.type === 'warehouse' && validPoint(action.center)) {
    const draft = warehouseDraft(state, action.center);

    if (draft) {
      contours = [
        rectangle(
          draft.center,
          WAREHOUSE_WIDTH,
          WAREHOUSE_DEPTH,
          draft.heading,
        ),
      ];
    }

    cost = state.rules.warehouseCost;
  }

  return {
    valid: result.ok,
    cost,
    reason: result.ok ? null : result.reason,
    contours,
  };
}
