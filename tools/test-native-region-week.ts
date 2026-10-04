import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {z} from 'zod';
import {CityLife} from '../packages/app/src/city/life/world';
import {createGameSave, parseGameSave} from '../packages/app/src/game/save';
import {trafficCollisions} from './native-region-observations';

interface Progress {
  key: string;
  x: number;
  z: number;
  distance: number;
  since: number;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const priorReportSchema = z.object({
  finalSeconds: z.number().finite(),
  assetHash: z.string(),
  checkpointHash: z.string(),
  progress: z.array(
    z.tuple([
      z.number().int().nonnegative(),
      z.object({
        key: z.string(),
        x: z.number().finite(),
        z: z.number().finite(),
        distance: z.number().finite(),
        since: z.number().finite(),
      }),
    ]),
  ),
});

function geometry(world: CityLife): string {
  assert.equal(world.definition.kind, 'authored');
  const definition = world.definition;

  if (definition.kind !== 'authored') {
    throw new Error('A native authored world is required');
  }

  return hash({
    layout: definition.layout,
    placements: definition.placements,
    roads: definition.roads,
    bounds: definition.bounds,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const input = args[0];
  const option = (name: string): string | undefined =>
    args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

  if (!input || input.startsWith('--')) {
    throw new Error(
      'Usage: bun tools/test-native-region-week.ts GAME_SAVE [--seconds=N|--days=N|--until-minute=N] [--wall-budget-ms=N] [--report=PATH] [--checkpoint=PATH]',
    );
  }

  const reportPath = option('report');
  const checkpointPath = option('checkpoint');

  for (const output of [reportPath, checkpointPath]) {
    assert.ok(
      !output || resolve(output) !== resolve(input),
      'Input save must remain unchanged',
    );
  }

  const raw = await readFile(input, 'utf8');
  const inputHash = createHash('sha256').update(raw).digest('hex');
  const game = parseGameSave(raw);
  const world = CityLife.fromSave(game.world);

  assert.equal(world.definition.kind, 'authored');
  assert.ok(
    world.population.people.length >= 1000,
    'Fixture must contain at least 1000 real native residents',
  );
  assert.ok(
    world.profile.layout.buildings.length >= 200,
    'Fixture must contain at least 200 complete native assemblies',
  );
  assert.ok(
    world.economy,
    'Native authored economy is required for conservation checks',
  );

  const calendar =
    world.definition.kind === 'authored'
      ? world.definition.calendar
      : undefined;
  const secondsPerMinute = calendar?.secondsPerMinute ?? 3;
  const startingMinute = calendar?.startingMinute ?? 450;
  const suppliedSeconds = option('seconds');
  const untilMinute = option('until-minute');
  const days = Number(option('days') ?? 7);
  const duration =
    suppliedSeconds !== undefined
      ? Number(suppliedSeconds)
      : untilMinute !== undefined
        ? (world.day * 1440 + Number(untilMinute) - startingMinute) *
            secondsPerMinute -
          world.seconds
        : days * 1440 * secondsPerMinute;
  const wallBudgetMs = Number(option('wall-budget-ms') ?? 60_000);
  const chunkSeconds = Number(option('chunk-seconds') ?? 30);

  assert.ok(
    Number.isFinite(duration) && duration > 0,
    'Requested physical duration must be positive',
  );
  assert.ok(
    Number.isFinite(wallBudgetMs) && wallBudgetMs > 0,
    'Wall budget must be positive',
  );
  assert.ok(
    Number.isFinite(chunkSeconds) && chunkSeconds > 0 && chunkSeconds <= 60,
    'Observation chunks must be at most60physical seconds',
  );
  const initialSeconds = world.seconds;
  const targetSeconds = initialSeconds + duration;
  const assetHash = geometry(world);
  const permanent = world.population.people.map(person => ({
    id: person.id,
    name: person.name,
    family: person.family,
    birthDay: person.birthDay,
  }));
  const initialMoney = world.economy.moneyBalance();
  const initialGoods = world.economy.goodsBalance();
  const initialCompletedDeliveries = world.economy.save().completedDeliveries;
  const progress = new Map<number, Progress>();
  const previousPath = option('previous-report');

  if (previousPath) {
    const previous = priorReportSchema.parse(
      JSON.parse(await readFile(previousPath, 'utf8')) as unknown,
    );

    assert.equal(
      previous.finalSeconds,
      initialSeconds,
      'Resume observer clock must match checkpoint',
    );
    assert.equal(
      previous.assetHash,
      assetHash,
      'Resume geometry must match checkpoint',
    );
    assert.equal(
      previous.checkpointHash,
      inputHash,
      'Observer must belong to the exact input checkpoint',
    );

    for (const [id, observation] of previous.progress) {
      progress.set(id, observation);
    }
  }

  const samples: Array<Record<string, unknown>> = [];
  const started = performance.now();
  let lastNotice = started;
  let lastFrame = world.frame();
  const initialPorts = lastFrame.ports?.map(port => ({
    id: port.id,
    status: port.snapshot.status,
  }));
  const initialRailways = lastFrame.railways?.map(railway => ({
    id: railway.id,
    status: railway.status,
  }));
  const placeKinds = new Map(
    world.profile.places.map(place => [place.id, place.kind]),
  );
  const movedPeople = new Set<number>();
  let trafficObservations = 0;
  let cargoObservations = 0;
  let maxSchoolVisitors = 0;
  let maxParkVisitors = 0;
  let status: 'complete' | 'budget' | 'failed';
  let failure: string | null = null;

  try {
    while (world.seconds < targetSeconds) {
      if (performance.now() - started >= wallBudgetMs) {
        break;
      }

      world.advance(Math.min(chunkSeconds, targetSeconds - world.seconds));
      const frame = world.frame();
      const poses = new Map(frame.people.map(person => [person.id, person]));
      const oldPoses = new Map(
        lastFrame.people.map(person => [person.id, person]),
      );

      for (const person of frame.people) {
        const prior = oldPoses.get(person.id);

        if (
          prior !== undefined &&
          Math.hypot(person.x - prior.x, person.z - prior.z) > 0.01
        ) {
          movedPeople.add(person.id);
        }
      }

      lastFrame = frame;
      const moving = world.traffic.movingPoses();

      assert.ok(
        [...frame.people, ...frame.cars].every(pose =>
          [pose.x, pose.y, pose.z, pose.yaw].every(Number.isFinite),
        ),
        'Rendered native resident/car poses must remain finite',
      );
      assert.ok(
        moving.every(pose =>
          [pose.x, pose.z, pose.dx, pose.dz, pose.length, pose.width].every(
            Number.isFinite,
          ),
        ),
        'Active native traffic bodies must remain finite',
      );
      assert.deepEqual(
        trafficCollisions(moving),
        [],
        `Complete active vehicle bodies overlap at ${world.seconds} seconds`,
      );
      trafficObservations++;

      for (const delivery of world.economy.deliveries) {
        assert.ok(
          Number.isFinite(delivery.escrow) && delivery.escrow >= 0,
          'Native delivery escrow must remain a real nonnegative account',
        );
        assert.equal(
          delivery.cargo,
          delivery.state === 'in-transit' || delivery.state === 'unloading'
            ? delivery.quantity
            : 0,
          'Goods must remain in their native truck until actual unloading',
        );

        if (delivery.cargo > 0) {
          cargoObservations++;
        }
      }

      for (const collection of [
        world.population.people,
        world.population.families,
        world.population.cars,
        world.parking.slots,
      ]) {
        assert.equal(
          new Set(collection.map(item => item.id)).size,
          collection.length,
          'Native resident/family/car/parking IDs must remain unique',
        );
      }

      const stranded: Array<{
        id: number;
        activity: string;
        leg: string;
        stationarySeconds: number;
      }> = [];

      for (const person of world.population.people) {
        const trip = person.trip;

        if (!trip) {
          progress.delete(person.id);

          continue;
        }

        const pose = poses.get(person.id)!;
        const key = `${trip.started}/${trip.destination}/${trip.purpose}/${trip.leg}/${person.activity}`;
        const prior = progress.get(person.id);
        const moved =
          !prior ||
          prior.key !== key ||
          Math.hypot(pose.x - prior.x, pose.z - prior.z) > 0.01 ||
          Math.abs(trip.distance - prior.distance) > 0.01;
        const since = moved ? world.seconds : prior.since;

        progress.set(person.id, {
          key,
          x: pose.x,
          z: pose.z,
          distance: trip.distance,
          since,
        });

        if (
          world.seconds - since > 1800 &&
          !(person.activity === 'garage' && person.nextAt > world.seconds)
        ) {
          stranded.push({
            id: person.id,
            activity: person.activity,
            leg: trip.leg,
            stationarySeconds: world.seconds - since,
          });
        }
      }

      assert.deepEqual(
        stranded,
        [],
        'Native trips must not remain stationary for over 30 physical minutes',
      );

      for (const baseline of permanent) {
        const person = world.population.people[baseline.id];

        assert.ok(
          person &&
            person.id === baseline.id &&
            person.name === baseline.name &&
            person.family === baseline.family &&
            person.birthDay === baseline.birthDay,
          'Baseline resident identity must survive progression',
        );
      }

      assert.ok(
        Math.abs(world.economy.moneyBalance() - initialMoney) < 0.000001,
        'Money conservation changed',
      );
      assert.equal(
        world.economy.goodsBalance(),
        initialGoods,
        'Goods conservation changed',
      );
      assert.ok(
        world.population.cars.every(
          car =>
            car.slot === null ||
            world.parking.slots[car.slot]?.occupant === car.id,
        ),
        'A car must own its actual occupied parking slot',
      );
      // The original native bus reserves and occupies its terminal with -2.
      const busState = world.parking.slots.some(
        slot => slot.occupant === -2 || slot.reserved === -2,
      )
        ? world.save()
        : null;

      assert.ok(
        world.parking.slots.every(slot => {
          const busTerminal =
            busState?.version === 3 &&
            busState.vehicleIds.bus !== null &&
            busState.traffic.vehicles[busState.vehicleIds.bus]?.id ===
              busState.vehicleIds.bus &&
            busState.bus.terminal === slot.facility &&
            world.profile.facilities[slot.facility]?.slots.includes(slot.id);
          const occupied =
            slot.occupant === null ||
            world.population.cars[slot.occupant]?.slot === slot.id ||
            (slot.occupant === -2 &&
              busTerminal &&
              busState.bus.phase === 'unloading' &&
              busState.bus.slot === slot.id);
          const reserved =
            slot.reserved === null ||
            world.population.cars[slot.reserved]?.id === slot.reserved ||
            (slot.reserved === -2 &&
              busTerminal &&
              (busState.bus.phase === 'approach' ||
                (busState.bus.phase === 'parking' &&
                  busState.bus.slot === slot.id)));

          return occupied && reserved;
        }),
        'Every occupied or reserved native slot must refer to its real car or terminal bus',
      );
      assert.deepEqual(world.errors, []);
      assert.equal(
        geometry(world),
        assetHash,
        'Approved assets and topology must not change during progression',
      );
      let schoolVisitors = 0;
      let parkVisitors = 0;

      for (const person of world.population.people) {
        const kind = placeKinds.get(person.location);

        if (person.activity === 'school' && kind === 'school') {
          schoolVisitors++;
        }
        if (person.activity === 'leisure' && kind === 'park') {
          parkVisitors++;
        }
      }

      maxSchoolVisitors = Math.max(maxSchoolVisitors, schoolVisitors);
      maxParkVisitors = Math.max(maxParkVisitors, parkVisitors);
      samples.push({
        seconds: world.seconds,
        day: world.day,
        minute: world.minute,
        population: frame.population,
        walking: frame.walking,
        driving: frame.driving,
        schoolVisitors,
        parkVisitors,
        trips: world.population.people.filter(person => person.trip !== null)
          .length,
        delivered: world.economy.save().completedDeliveries,
        money: world.economy.moneyBalance(),
        goods: world.economy.goodsBalance(),
        wallMs: performance.now() - started,
      });

      if (performance.now() - lastNotice >= 20_000) {
        console.log(JSON.stringify(samples.at(-1)));
        lastNotice = performance.now();
      }
    }

    status = world.seconds >= targetSeconds ? 'complete' : 'budget';
  } catch (error) {
    status = 'failed';
    failure =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  }

  const wallMs = performance.now() - started;
  const saved = world.save();
  const checkpoint = JSON.stringify(createGameSave(game.id, game.name, saved));
  const checkpointHash = createHash('sha256').update(checkpoint).digest('hex');
  const sourceUnchanged =
    createHash('sha256')
      .update(await readFile(input, 'utf8'))
      .digest('hex') === inputHash;
  const report = {
    status,
    failure,
    inputHash,
    sourceUnchanged,
    assetHash,
    seed: game.seed,
    calendar: {startingMinute, secondsPerMinute},
    initialSeconds,
    targetSeconds,
    finalSeconds: world.seconds,
    advancedSeconds: world.seconds - initialSeconds,
    wallMs,
    simulatedSecondsPerWallSecond:
      (world.seconds - initialSeconds) / (wallMs / 1000),
    people: world.population.people.length,
    families: world.population.families.length,
    cars: world.population.cars.length,
    buildings: world.profile.layout.buildings.length,
    movedPeople: movedPeople.size,
    trafficObservations,
    collisionObservationSeconds: chunkSeconds,
    cargoObservations,
    maxSchoolVisitors,
    maxParkVisitors,
    initialPorts,
    finalPorts: lastFrame.ports?.map(port => ({
      id: port.id,
      status: port.snapshot.status,
    })),
    initialRailways,
    finalRailways: lastFrame.railways?.map(railway => ({
      id: railway.id,
      status: railway.status,
    })),
    initialMoney,
    finalMoney: world.economy.moneyBalance(),
    initialGoods,
    finalGoods: world.economy.goodsBalance(),
    initialCompletedDeliveries,
    finalCompletedDeliveries: world.economy.save().completedDeliveries,
    checkpointHash,
    progress: [...progress],
    samples,
  };

  if (reportPath) {
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  if (checkpointPath) {
    await writeFile(checkpointPath, checkpoint);
  }

  console.log(
    JSON.stringify({...report, samples: undefined, progress: undefined}),
  );
  assert.ok(sourceUnchanged, 'The original input file changed during the run');
  process.exitCode = status === 'complete' ? 0 : status === 'budget' ? 2 : 1;
}

await main();
