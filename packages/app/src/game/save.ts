import {z} from 'zod';
import type {CityLife} from '../city/life/world';
import {parseWorldDefinition} from '../city/life/definition';

type NativeWorldSave = ReturnType<CityLife['save']>;

export interface NativeGameSave {
  readonly kind: 'simcity-game';
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly seed: string;
  readonly world: NativeWorldSave;
}

const counter = z.number().int().nonnegative();
const finite = z.number().finite();
const record = z.record(z.string(), z.unknown());
const nativeWorldStructure = z.object({
  version: z.union([z.literal(2), z.literal(3)]),
  expanded: z.boolean(),
  seed: z.string().min(1).max(32),
  tick: counter,
  requested: finite.nonnegative(),
  dayDone: counter,
  carsAdded: counter,
  nextImmigration: finite,
  nextAssets: finite,
  bus: z.object({
    phase: z.enum(['idle', 'approach', 'parking', 'unloading', 'leaving']),
    family: counter.nullable(),
    slot: counter.nullable(),
    until: finite,
    terminal: counter.nullable(),
  }),
  portals: z.array(z.tuple([counter, counter])),
  population: z.object({
    people: z.array(record).max(10000),
    families: z.array(record),
    units: z.array(record),
    cars: z.array(record),
    businesses: z.array(record),
    random: finite,
    treasury: finite,
    born: counter,
    arrivals: counter,
  }),
  parking: z.array(record),
  traffic: z.object({
    tick: counter,
    lastTime: finite,
    owners: z.array(z.number().int()),
    held: z.array(z.number().int()),
    vehicles: z.array(record),
  }),
  harbor: z.object({
    cargo: z.array(record),
    jobs: z.array(record.nullable()),
    homes: z.array(record),
    visit: finite,
    phase: z.string(),
    phaseStarted: finite,
    nextId: counter,
    created: counter,
    delivered: counter,
    exported: counter,
    departedEmpty: counter,
    departedLoaded: counter,
    production: z.array(finite),
    waitingSince: z.array(finite.nullable()),
  }),
  railway: z.object({
    enabled: z.boolean(),
    seconds: finite,
    origin: finite,
    tick: counter,
    nextVisit: finite,
    dwellUntil: finite,
    arrivals: counter,
    departures: counter,
    passengers: counter,
    train: record,
    crossings: z.array(record),
  }),
  railArrival: z
    .object({
      serial: counter,
      family: counter,
      released: counter,
      nextAt: finite.nullable(),
    })
    .nullable(),
});

function isNativeWorld(value: unknown): boolean {
  // Check the catalogue boundary without constructing another simulation.
  // Entity relationships and resumable state are validated by the native worker.
  if (!nativeWorldStructure.safeParse(value).success) {
    return false;
  }

  const header = value as {
    version: number;
    seed: string;
    definition?: unknown;
    vehicleIds?: unknown;
    junctionKeys?: unknown;
  };

  if (header.version === 2) {
    return true;
  }

  try {
    const definition = parseWorldDefinition(header.definition);

    return (
      definition.kind === 'authored' &&
      definition.seed === header.seed &&
      z
        .object({cars: z.array(counter), bus: counter.nullable()})
        .safeParse(header.vehicleIds).success &&
      z.array(z.string()).safeParse(header.junctionKeys).success
    );
  } catch {
    return false;
  }
}

const gameSchema = z
  .object({
    kind: z.literal('simcity-game'),
    version: z.literal(1),
    id: z
      .string()
      .min(1)
      .max(128)
      .refine(value => value.trim().length > 0),
    name: z
      .string()
      .min(1)
      .max(64)
      .refine(value => value.trim().length > 0),
    seed: z.string().min(1).max(32),
    world: z.custom<NativeWorldSave>(isNativeWorld),
  })
  .strict();

export function parseGameSave(value: unknown): NativeGameSave {
  const raw: unknown =
    typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  const parsed = gameSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error('Несовместимое или повреждённое сохранение игры');
  }
  if (parsed.data.seed !== parsed.data.world.seed) {
    throw new Error('Ключ сохранения не совпадает с миром');
  }

  return parsed.data;
}

export function createGameSave(
  id: string,
  name: string,
  world: NativeWorldSave,
): NativeGameSave {
  return parseGameSave({
    kind: 'simcity-game',
    version: 1,
    id,
    name,
    seed: world.seed,
    world,
  });
}
