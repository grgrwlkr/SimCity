import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {
  goodsBalance,
  moneyBalance,
} from '../packages/app/src/region/model/life/economy';
import {advanceRegion} from '../packages/app/src/region/model/life/simulation';
import {
  parseRegion,
  serializeRegion,
} from '../packages/app/src/region/model/save';
import type {RegionState} from '../packages/app/src/region/model/types';
import {
  applyRegionalAction,
  createRegionalPerformanceLayout,
  createRegionalPlaythrough,
  type RegionalLayout,
} from './region-playthrough';

const WEEK_SECONDS = 7 * 86_400;
const options = process.argv.slice(2);
const secondsOption = options.find(value => value.startsWith('--seconds='));
const seconds = secondsOption
  ? Number(secondsOption.slice('--seconds='.length))
  : WEEK_SECONDS;
const performance = options.includes('--performance');
const layoutOption = options
  .find(value => value.startsWith('--layout='))
  ?.slice('--layout='.length);
const output = options
  .find(value => value.startsWith('--output='))
  ?.slice('--output='.length);

assert.ok(
  Number.isSafeInteger(seconds) && seconds > 0 && seconds <= WEEK_SECONDS,
  'Duration must be 1..604800 game seconds',
);
assert.ok(
  layoutOption === undefined ||
    layoutOption === 'river-west' ||
    layoutOption === 'staggered',
  'Unknown layout',
);
assert.ok(
  !output || performance,
  '--output is only for a proved performance population',
);
const layouts: RegionalLayout[] = layoutOption
  ? [layoutOption]
  : ['river-west', 'staggered'];
const scenarios = performance
  ? [createRegionalPerformanceLayout()]
  : layouts.map(layout => createRegionalPlaythrough(layout));

function inspect(state: RegionState): void {
  assert.equal(
    moneyBalance(state),
    state.life.economy.initialMoney,
    'Money conservation',
  );
  assert.equal(
    goodsBalance(state),
    state.life.economy.initialGoods,
    'Goods conservation',
  );
  const stranded = state.life.trips.filter(
    trip => state.life.elapsedSeconds - trip.startedAt > 7200,
  );

  if (stranded.length) {
    mkdirSync('.scratch/region-playthrough', {recursive: true});
    writeFileSync(
      `.scratch/region-playthrough/stranded-${state.id}.json`,
      serializeRegion(state),
    );
  }

  assert.deepEqual(
    stranded.map(trip => ({
      id: trip.id,
      actor: trip.actorId,
      purpose: trip.purpose,
      from: trip.fromId,
      to: trip.toId,
      distance: trip.distance,
      wait: trip.waitingSeconds,
    })),
    [],
    `Trips exceeding two game hours at ${state.life.elapsedSeconds}s`,
  );
}

function population(state: RegionState): number {
  return state.life.families
    .filter(family => family.status === 'settled')
    .reduce((sum, family) => sum + family.memberIds.length, 0);
}

function summary(state: RegionState): object {
  return {
    id: state.id,
    seconds: state.life.elapsedSeconds,
    population: population(state),
    readyBuildings: state.life.buildings.filter(
      building => building.stage === 'ready',
    ).length,
    completedTrips: state.life.completedTrips,
    completedDeliveries: state.life.completedDeliveries,
    produced: state.life.economy.produced,
    cash: state.cash,
  };
}

for (let state of scenarios) {
  const started = Date.now();
  let nextReport = 86_400;
  let savedCargo = false;
  let savedConstruction = false;
  let savedTrip = false;
  let verifiedContinuation = false;
  const connector = performance ? state.roads.at(-1)! : state.roads[3]!;
  let closedAt: number | null = null;
  let reconnected = false;

  assert.deepEqual(parseRegion(serializeRegion(state)), state);
  inspect(state);

  while (state.life.elapsedSeconds < seconds) {
    state = advanceRegion(
      state,
      Math.min(600, seconds - state.life.elapsedSeconds),
    );
    inspect(state);

    if (
      seconds === WEEK_SECONDS &&
      state.life.elapsedSeconds >= 86_400 &&
      state.life.trips.some(trip =>
        trip.route.roadIds.includes(connector.id),
      ) &&
      closedAt === null
    ) {
      closedAt = state.life.elapsedSeconds;
      state = applyRegionalAction(state, {type: 'remove', id: connector.id});
      inspect(state);
    }
    if (closedAt !== null && !reconnected) {
      assert.ok(
        state.life.trips.every(
          trip =>
            !trip.route.roadIds.includes(connector.id) ||
            trip.startedAt <= closedAt!,
        ),
        'A new trip used the closing road',
      );

      if (
        !state.roads.some(road => road.id === connector.id) &&
        state.life.elapsedSeconds >= closedAt + 600
      ) {
        state = applyRegionalAction(state, {
          type: 'road',
          points: connector.points,
        });
        state = parseRegion(serializeRegion(state));
        inspect(state);
        reconnected = true;
      }
    }

    const cargo = state.life.deliveries.some(delivery => delivery.cargo > 0);
    const constructing = state.life.buildings.some(
      building => building.stage === 'constructing',
    );
    const trip = state.life.trips.length > 0;
    const checkpoint =
      (!savedCargo && cargo) ||
      (!savedConstruction && constructing) ||
      (!savedTrip && trip);

    if (checkpoint) {
      const restored = parseRegion(serializeRegion(state));

      assert.deepEqual(restored, state);
      state = restored;
      savedCargo ||= cargo;
      savedConstruction ||= constructing;
      savedTrip ||= trip;
    }
    if (!verifiedContinuation && cargo && trip) {
      const restored = parseRegion(serializeRegion(state));
      const uninterrupted = advanceRegion(state, 60.25);
      const continued = advanceRegion(advanceRegion(restored, 20.125), 40.125);

      assert.deepEqual(
        continued,
        uninterrupted,
        'Saved cargo/trip must continue identically across fractional time requests',
      );
      inspect(continued);
      verifiedContinuation = true;
    }
    if (state.life.elapsedSeconds >= nextReport) {
      console.log(JSON.stringify(summary(state)));
      state = parseRegion(serializeRegion(state));
      nextReport += 86_400;
    }
  }

  assert.deepEqual(parseRegion(serializeRegion(state)), state);

  if (seconds === WEEK_SECONDS) {
    assert.ok(
      closedAt !== null && reconnected,
      'Road closure and reconnection did not complete',
    );
    assert.ok(population(state) > 0, 'No family arrived physically');
    assert.ok(state.life.completedDeliveries > 0, 'No delivery completed');
    assert.ok(state.life.economy.produced > 0, 'No worker production');
    const buildings = new Map(
      state.life.buildings.map(building => [building.id, building]),
    );
    const families = new Map(
      state.life.families.map(family => [family.id, family]),
    );

    assert.ok(
      state.life.people.some(person => {
        const homeId = families.get(person.familyId)?.homeId;
        const home = homeId ? buildings.get(homeId) : undefined;
        const job = person.jobId ? buildings.get(person.jobId) : undefined;

        return (
          person.workedSeconds > 0 &&
          home &&
          job &&
          home.settlementId !== job.settlementId
        );
      }),
      'Nobody physically worked in another settlement',
    );
    assert.ok(
      savedConstruction && savedCargo && savedTrip && verifiedContinuation,
      'Missing construction/cargo/trip persistence evidence',
    );
  }
  if (performance && seconds === WEEK_SECONDS) {
    assert.ok(
      population(state) >= 1000,
      'Performance fixture did not reach 1000 settled residents',
    );
    assert.ok(
      state.life.buildings.filter(building => building.stage === 'ready')
        .length >= 200,
      'Performance fixture did not reach 200 completed buildings',
    );

    if (output) {
      await mkdir(dirname(output), {recursive: true});
      await writeFile(output, serializeRegion(state) + '\n', 'utf8');
    }
  }

  console.log(
    JSON.stringify({
      ...summary(state),
      wallSeconds: (Date.now() - started) / 1000,
      savedConstruction,
      savedCargo,
      savedTrip,
      verifiedContinuation,
      fullWeek: seconds === WEEK_SECONDS,
      reconnected,
    }),
  );
}
