import {recordFamilyFinance} from './economy';
import {buildRoadGraph} from '../../../../../packages/app/src/region/model/roads';
import {seededRandom} from '../../../../../packages/app/src/region/model/random';
import type {
  Parcel,
  Road,
  RoadAccess,
  Warehouse,
  ZoneKind,
} from '../../../../../packages/app/src/region/model/types';
import {
  BUILDING_RULES,
  LIFE_RULES,
} from '../../../../../packages/app/src/region/model/life/rules';
import type {
  BuildingKind,
  LifeRegion,
  MutableRegion,
  RegionalBuilding,
  RegionalFamily,
} from '../../../../../packages/app/src/region/model/life/types';

type Lot = Parcel | Warehouse;

function isParcel(lot: Lot): lot is Parcel {
  return 'zone' in lot;
}

interface Connectivity {
  revision: number;
  components: Map<string, string>;
}
const connectivityCache = new WeakMap<readonly Road[], Connectivity>();
const MALE_NAMES = [
  'Алексей',
  'Михаил',
  'Дмитрий',
  'Андрей',
  'Иван',
  'Николай',
  'Павел',
  'Роман',
];
const FEMALE_NAMES = [
  'Анна',
  'Мария',
  'Елена',
  'Ольга',
  'Ирина',
  'Вера',
  'Дарья',
  'Софья',
];
const SURNAMES = [
  'Орлов',
  'Соколов',
  'Морозов',
  'Волков',
  'Белов',
  'Кузнецов',
  'Романов',
  'Лебедев',
];

function roadComponents(state: LifeRegion): Map<string, string> {
  const cached = connectivityCache.get(state.roads);

  if (cached?.revision === state.roadRevision) {
    return cached.components;
  }

  const closed = new Set(state.life.closingRoadIds);
  const graph = buildRoadGraph(
    state.roads.filter(road => !closed.has(road.id)),
  );
  const parents = new Map(graph.nodes.map(node => [node.id, node.id]));
  const root = (id: string): string => {
    let current = id;

    while (parents.get(current) !== current) {
      current = parents.get(current)!;
    }

    return current;
  };

  for (const edge of graph.edges) {
    parents.set(root(edge.to), root(edge.from));
  }

  const components = new Map<string, string>();

  for (const edge of graph.edges) {
    components.set(edge.roadId, root(edge.from));
  }

  connectivityCache.set(state.roads, {
    revision: state.roadRevision,
    components,
  });

  return components;
}

function externalComponents(state: LifeRegion): Set<string> {
  const components = roadComponents(state);

  return new Set(
    state.externalEntries.flatMap(entry => {
      const component = components.get(entry.roadId);

      return component === undefined ? [] : [component];
    }),
  );
}

function accessReason(
  state: LifeRegion,
  access: RoadAccess | null,
): string | null {
  const component = access && roadComponents(state).get(access.roadId);

  if (!component) {
    return 'no-road';
  }

  const external = externalComponents(state);

  if (external.size === 0) {
    return 'no-external-entry';
  }

  return external.has(component) ? null : 'disconnected';
}

function initializeApplicants(state: MutableRegion): void {
  if (state.life.initialized || externalComponents(state).size === 0) {
    return;
  }

  const life = state.life;

  life.initialized = true;

  for (let index = 0; index < LIFE_RULES.familyCount; index++) {
    const familyId = `family-${index + 1}`;
    const random = seededRandom(`${state.seed}:family:${index}`);
    const surname = SURNAMES[Math.floor(random() * SURNAMES.length)]!;
    const memberIds: string[] = [];

    for (let member = 0; member < 4; member++) {
      const id = `resident-${index * 4 + member + 1}`;
      const female = member % 2 === 1;
      const names = female ? FEMALE_NAMES : MALE_NAMES;

      memberIds.push(id);
      life.people.push({
        id,
        familyId,
        name: `${names[Math.floor(random() * names.length)]!} ${surname}${female ? 'а' : ''}`,
        age:
          member < 2
            ? 25 + Math.floor(random() * 25)
            : 4 + Math.floor(random() * 13),
        qualification: member < 2 ? Math.floor(random() * 3) : 0,
        jobId: null,
        placeId: null,
        tripId: null,
        activity: 'outside',
        reason: 'waiting-home',
        workedSeconds: 0,
        wageSeconds: 0,
      });
    }

    life.families.push({
      id: familyId,
      memberIds,
      cash: LIFE_RULES.familyCapital,
      finance: {
        sinceSeconds: 0,
        construction: 0,
        goods: 0,
        travel: 0,
        wages: 0,
      },
      homeId: null,
      status: 'waiting',
      availableAt: index * LIFE_RULES.familyIntervalSeconds,
      carId: null,
      goods: 0,
      lastShopDay: -1,
      reason: 'waiting-home',
    });
  }

  for (let index = 0; index < LIFE_RULES.investorCount; index++) {
    life.investors.push({
      id: `investor-${index + 1}`,
      cash: LIFE_RULES.investorCapital,
    });
  }

  life.economy.initialMoney +=
    LIFE_RULES.familyCount * LIFE_RULES.familyCapital +
    LIFE_RULES.investorCount * LIFE_RULES.investorCapital;
  life.economy.externalGoods += LIFE_RULES.externalGoods;
  life.economy.initialGoods += LIFE_RULES.externalGoods;
}

export function buildingAt(
  state: LifeRegion,
  lotId: string,
): RegionalBuilding | undefined {
  return state.life.buildings.find(building => building.lotId === lotId);
}

function releasedFamilies(state: LifeRegion): RegionalFamily[] {
  return state.life.families.filter(
    family => family.availableAt <= state.life.elapsedSeconds,
  );
}

function waitingFamily(state: LifeRegion): RegionalFamily | undefined {
  return releasedFamilies(state).find(family => family.homeId === null);
}

function enterpriseDemand(state: LifeRegion, kind: ZoneKind): boolean {
  const families = releasedFamilies(state);
  const released = new Set(families.map(family => family.id));
  const adults = state.life.people.filter(
    person =>
      released.has(person.familyId) &&
      person.age >= LIFE_RULES.workerAge &&
      person.age < LIFE_RULES.retirementAge,
  ).length;
  const buildings = state.life.buildings.filter(
    building => building.kind === kind,
  ).length;
  // Reserve the starter enterprise and store together; subsequent firms follow released demand.
  const desired =
    kind === 'industrial'
      ? Math.ceil(
          (adults * LIFE_RULES.industrialEmploymentShare) /
            BUILDING_RULES.industrial.jobs,
        )
      : Math.ceil(families.length / LIFE_RULES.familiesPerStore);

  return buildings < desired;
}

function vacantHome(
  state: LifeRegion,
  family: RegionalFamily,
): RegionalBuilding | undefined {
  const occupants = new Map<string, number>();

  for (const candidate of state.life.families) {
    if (candidate.homeId) {
      occupants.set(
        candidate.homeId,
        (occupants.get(candidate.homeId) ?? 0) + candidate.memberIds.length,
      );
    }
  }

  return state.life.buildings.find(building => {
    if (
      building.kind !== 'residential' ||
      (occupants.get(building.id) ?? 0) + family.memberIds.length >
        BUILDING_RULES.residential.capacity
    ) {
      return false;
    }

    const lot = state.parcels.find(
      candidate => candidate.id === building.lotId,
    );

    return lot !== undefined && accessReason(state, lot.access) === null;
  });
}

export function developmentReason(
  state: LifeRegion,
  lotId: string,
): string | null {
  const building = buildingAt(state, lotId);

  if (building) {
    return building.stage;
  }

  const lot =
    state.parcels.find(candidate => candidate.id === lotId) ??
    state.warehouses.find(candidate => candidate.id === lotId);

  if (!lot) {
    return 'missing-lot';
  }

  const blocked = accessReason(state, lot.access);

  if (blocked) {
    return blocked;
  }
  if (!isParcel(lot)) {
    return null;
  }
  if (lot.zone === 'residential') {
    const family = waitingFamily(state);

    if (!family || vacantHome(state, family)) {
      return 'no-demand';
    }

    return releasedFamilies(state).some(
      candidate =>
        candidate.homeId === null &&
        candidate.cash >= BUILDING_RULES.residential.cost,
    )
      ? null
      : 'insufficient-capital';
  }
  if (!enterpriseDemand(state, lot.zone)) {
    return 'no-demand';
  }

  const rules = BUILDING_RULES[lot.zone];

  return state.life.investors.some(
    investor => investor.cash >= rules.cost + rules.workingCapital,
  )
    ? null
    : 'insufficient-capital';
}

function startBuilding(state: MutableRegion, lot: Lot): void {
  const kind: BuildingKind = isParcel(lot) ? lot.zone : 'warehouse';
  const rules = BUILDING_RULES[kind];
  const family =
    kind === 'residential'
      ? releasedFamilies(state).find(
          candidate =>
            candidate.homeId === null && candidate.cash >= rules.cost,
        )
      : undefined;
  const investor =
    kind !== 'residential' && kind !== 'warehouse'
      ? state.life.investors.find(
          candidate => candidate.cash >= rules.cost + rules.workingCapital,
        )
      : undefined;
  const payer = family ?? investor;

  if (kind !== 'warehouse' && !payer) {
    return;
  }
  if (payer) {
    payer.cash -= rules.cost + rules.workingCapital;
  }

  const id = `building-${state.life.nextId++}`;

  state.life.buildings.push({
    id,
    lotId: lot.id,
    settlementId: lot.settlementId,
    kind,
    ownerId: payer?.id ?? 'region',
    stage: 'constructing',
    startedAt: state.life.elapsedSeconds,
    progressSeconds: 0,
    durationSeconds: rules.durationSeconds,
    capacity: 0,
    jobs: 0,
    qualification: rules.qualification,
    parking: 0,
    inventory: 0,
    inventoryCapacity: 0,
    cash: rules.workingCapital,
    productionWork: 0,
  });
  state.life.economy.externalMoney += rules.cost;
  state.life.economy.constructionPaid += rules.cost;

  if (family) {
    recordFamilyFinance(state, family, 'construction', rules.cost);
    family.homeId = id;
    family.reason = 'constructing';
  }
}

/** Called exactly once per elapsed game second; all durable progress lives in the draft. */
export function stepDevelopment(state: MutableRegion): void {
  initializeApplicants(state);
  const lots = new Map<string, Lot>(
    [...state.parcels, ...state.warehouses].map(lot => [lot.id, lot]),
  );

  for (const building of state.life.buildings) {
    if (building.stage !== 'constructing') {
      continue;
    }

    const lot = lots.get(building.lotId);

    if (!lot || accessReason(state, lot.access) !== null) {
      continue;
    }

    building.progressSeconds = Math.min(
      building.durationSeconds,
      building.progressSeconds + 1,
    );

    if (building.progressSeconds === building.durationSeconds) {
      const rules = BUILDING_RULES[building.kind];

      building.stage = 'ready';
      building.capacity = rules.capacity;
      building.jobs = rules.jobs;
      building.parking = rules.parking;
      building.inventoryCapacity = rules.inventoryCapacity;
    }
  }

  if (
    !state.life.initialized ||
    state.life.elapsedSeconds % LIFE_RULES.secondsPerMinute !== 0
  ) {
    return;
  }

  for (const family of releasedFamilies(state)) {
    if (family.homeId !== null) {
      continue;
    }

    const home = vacantHome(state, family);

    if (home) {
      family.homeId = home.id;
      family.reason =
        home.stage === 'constructing' ? 'constructing' : 'waiting-job';
    }
  }

  const ordered = [...lots.values()]
    .map(lot => ({lot, rank: seededRandom(`${state.seed}:lot:${lot.id}`)()}))
    .sort((a, b) => a.rank - b.rank);

  for (const {lot} of ordered) {
    if (developmentReason(state, lot.id) === null) {
      startBuilding(state, lot);
    }
  }
}
