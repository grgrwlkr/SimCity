// Save format v1: the whole world as JSON, checked by zod before anything is built from it. A load builds a new
// world and never touches the one running: a file that fails anywhere leaves the game as it was. Rust `.ron` saves
// (SaveGameV3, crates/simcity_data/src/game/persistence_contract.rs in rust-final) are not read.
import { z } from 'zod';
import { AGENDA_STOPS, LAYER_NAMES as CITIZEN_LAYER_NAMES, STOP_LAYER_NAMES } from '../citizens';
import type { MesoGraph } from '../meso/graph';
import type { MesoTraffic } from '../meso/traffic';
import { createWorld, type World } from '../world';
import { emptyScenarioProgress } from '../objectives';
import { SaveError, TYPED_ARRAY_NAMES, classInstances, decodeNode, encodeNode, kindOf, savedClassName, type SaveNode } from './codec';
import { CLASS_SAMPLES, ELEMENT_TEMPLATES, NULLABLE_FIELDS, SCENARIO_RUNTIMES, runtimeSamples } from './rules';

export { SaveError } from './codec';

export const SAVE_FORMAT = 'simcity-save';
export const SAVE_VERSION = 2;

const id = z.number().int().nonnegative();
const fields = (): z.ZodType<Record<string, SaveNode>> => z.record(z.string(), node);

const tagged = z.discriminatedUnion('$', [
  z.strictObject({ $: z.literal('num'), v: z.enum(['NaN', 'Infinity', '-Infinity', '-0']) }),
  z.strictObject({ $: z.literal('undef') }),
  z.strictObject({ $: z.literal('big'), v: z.string().regex(/^-?\d+$/) }),
  z.strictObject({ $: z.literal('ta'), t: z.enum(TYPED_ARRAY_NAMES), v: z.string(), id: id.optional() }),
  z.strictObject({ $: z.literal('arr'), v: z.array(z.lazy(() => node)), id: id.optional() }),
  z.strictObject({ $: z.literal('obj'), v: z.lazy(fields), id: id.optional() }),
  z.strictObject({ $: z.literal('map'), v: z.array(z.tuple([z.lazy(() => node), z.lazy(() => node)])), id: id.optional() }),
  z.strictObject({ $: z.literal('set'), v: z.array(z.lazy(() => node)), id: id.optional() }),
  z.strictObject({ $: z.literal('cls'), c: z.string(), v: z.lazy(fields), id: id.optional() }),
  z.strictObject({ $: z.literal('ref'), id }),
]);

/** `$` refused by type, not by a refinement: a union would report a failed refinement over the tagged branch's issue. */
const plain = z.object({ $: z.never().optional() }).catchall(z.lazy(() => node)) as unknown as z.ZodType<{ readonly [key: string]: SaveNode }>;

const node: z.ZodType<SaveNode> = z.lazy(() => z.union([z.number(), z.string(), z.boolean(), z.null(), z.array(node), tagged, plain]));

const saveFile = z.strictObject({
  format: z.literal(SAVE_FORMAT),
  version: z.literal(SAVE_VERSION),
  /** What `createWorld` needs for the world the save fills. */
  options: z.strictObject({
    mapWidth: z.number().int().positive(),
    mapHeight: z.number().int().positive(),
    gameHourNs: z.number().int().positive(),
    microTraffic: z.boolean(),
  }),
  world: node,
});

export type SaveFile = z.infer<typeof saveFile>;

/** The world as the text of a save file. */
export function saveWorld(w: World): string {
  const file: SaveFile = {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    options: { mapWidth: w.mapConfig.width, mapHeight: w.mapConfig.height, gameHourNs: w.gameHourNs, microTraffic: w.microTraffic },
    world: encodeNode(w, 'world'),
  };
  return JSON.stringify(file);
}

/** A step from one save version to the next: it takes a file of its version and returns one of a later version. */
export type SaveMigration = (file: Record<string, unknown>) => Record<string, unknown>;

/**
 * The steps that bring an older save up to `SAVE_VERSION`, by the version each starts from. v1 is the first save of the
 * TS game and Rust `.ron` saves are not read. The Rust saves' way with an added field (a `#[serde(default)]` value) is
 * a step here, never a silent default in the loader.
 */
export const SAVE_MIGRATIONS: Readonly<Record<number, SaveMigration>> = {
  // v2 (P3): the world keeps the running scenario and its objectives. A v1 world ran none.
  1: (file) => {
    const world = file.world;
    if (typeof world !== 'object' || world === null || Array.isArray(world)) return { ...file, version: 2 };
    const node = world as Record<string, unknown>;
    const added = { scenario: encodeNode(emptyScenarioProgress(), 'world.scenario'), scenarioRuntime: null };
    // The world is a tagged object only when something in it refers back to it.
    const migrated = node.$ === 'obj' ? { ...node, v: { ...(node.v as object), ...added } } : { ...node, ...added };
    return { ...file, version: 2, world: migrated };
  },
};

function migrate(json: unknown, migrations: Readonly<Record<number, SaveMigration>>): unknown {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return json;
  let file = json as Record<string, unknown>;
  while (typeof file.version === 'number' && file.version < SAVE_VERSION) {
    const from = file.version;
    const step = Object.hasOwn(migrations, from) ? migrations[from] : undefined;
    if (step === undefined) throw new SaveError(`save rejected: version: ${from} is older than ${SAVE_VERSION} and no migration takes it further`);
    file = step(file);
    if (!(typeof file.version === 'number' && file.version > from)) throw new SaveError(`save rejected: version: the migration from ${from} did not raise it`);
  }
  return file;
}

/** A zod path as the decoder spells places: the `v` of a tagged node left out, array and entry indices in brackets. */
function readablePath(json: unknown, path: readonly PropertyKey[]): string {
  let out = '';
  let at: unknown = json;
  for (const key of path) {
    const node = typeof at === 'object' && at !== null ? (at as Record<PropertyKey, unknown>) : undefined;
    if (key === 'v' && node !== undefined && !Array.isArray(node) && Object.hasOwn(node, '$')) {
      at = node.v;
      continue;
    }
    out += typeof key === 'number' ? `[${key}]` : out === '' ? String(key) : `.${String(key)}`;
    at = node?.[key];
  }
  return out === '' ? 'file' : out;
}

/** The deepest issue zod found: of a union, the branch that got furthest, which is where the file went wrong. */
function deepest(issue: z.core.$ZodIssue, prefix: readonly PropertyKey[]): { path: PropertyKey[]; message: string } {
  const path = [...prefix, ...issue.path];
  let best = { path, message: issue.message };
  if (issue.code === 'invalid_union') {
    for (const branch of issue.errors) {
      for (const inner of branch) {
        const found = deepest(inner, path);
        if (found.path.length > best.path.length) best = found;
      }
    }
  }
  return best;
}

/** A save file's text, checked; a `SaveError` naming the first place it is wrong otherwise. */
export function parseSave(text: string, migrations: Readonly<Record<number, SaveMigration>> = SAVE_MIGRATIONS): SaveFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new SaveError(`save rejected: not JSON (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  json = migrate(json, migrations);
  const parsed = saveFile.safeParse(json);
  if (!parsed.success) {
    const { path, message } = deepest(parsed.error.issues[0]!, []);
    throw new SaveError(`save rejected: ${readablePath(json, path)}: ${message}`);
  }
  return parsed.data;
}

/** A new world from a save file's text. Throws `SaveError` on a file that is not a v1 save of a whole world. */
export function loadWorld(text: string): World {
  return worldFromSave(parseSave(text));
}

const isCount = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/** The layers of the meso graph by what they run over, and those of its traffic by link and by car (`growCars`). */
const MESO_LINK_LAYERS = ['dir', 'lanes', 'length', 'speedKmh', 'startX', 'startY', 'endX', 'endY'] as const satisfies ReadonlyArray<keyof MesoGraph>;
const MESO_SUCCESSOR_LAYERS = ['succLink', 'succBoxTiles', 'succCluster'] as const satisfies ReadonlyArray<keyof MesoGraph>;
const MESO_TILE_LAYERS = ['tileLink', 'tileOffset'] as const satisfies ReadonlyArray<keyof MesoGraph>;
const TRAFFIC_LINK_LAYERS = ['head', 'tail', 'onLink', 'usedMeters', 'tokens', 'tokensAt', 'exits', 'linkSeconds', 'measuredSum', 'measuredCount'] as const satisfies ReadonlyArray<keyof MesoTraffic>;
const TRAFFIC_CAR_LAYERS = [
  'citizen',
  'vehicle',
  'purpose',
  'link',
  'enterSec',
  'readySec',
  'goalLink',
  'goalOffset',
  'next',
  'heldSince',
  'atRed',
  'yieldSince',
  'fromOffset',
  'prevLink',
  'generation',
  'routeCursor',
] as const satisfies ReadonlyArray<keyof MesoTraffic>;

/** The meso graph and its traffic sized alike: a layer cut short would be read past its end. */
function checkMesoLengths(w: World): void {
  const g = w.meso;
  const links = g.linkCount;
  for (const name of MESO_LINK_LAYERS) {
    if (g[name].length !== links) throw new SaveError(`save rejected: world.meso.${name}: ${g[name].length} links, the graph has ${links}`);
  }
  if (g.succStart.length !== links + 1) throw new SaveError(`save rejected: world.meso.succStart: ${g.succStart.length} entries for ${links} links`);
  const successors = g.succStart[links]!;
  for (const name of MESO_SUCCESSOR_LAYERS) {
    if (g[name].length !== successors) throw new SaveError(`save rejected: world.meso.${name}: ${g[name].length} successors, succStart ends at ${successors}`);
  }
  const tiles = g.width * g.height;
  for (const name of MESO_TILE_LAYERS) {
    if (g[name].length !== tiles) throw new SaveError(`save rejected: world.meso.${name}: ${g[name].length} tiles on a graph of ${tiles}`);
  }
  const m = w.mesoTraffic;
  // The link layers are sized for the graph they were built for; for another one the next tick sizes them anew.
  if (m.linksFor === g.builtFor) {
    for (const name of TRAFFIC_LINK_LAYERS) {
      if (m[name].length !== links) throw new SaveError(`save rejected: world.mesoTraffic.${name}: ${m[name].length} links, the graph has ${links}`);
    }
  }
  if (m.due.keys.length !== m.due.links.length) throw new SaveError(`save rejected: world.mesoTraffic.due: ${m.due.keys.length} keys for ${m.due.links.length} links`);
  // The longest car layer sets the cars, so the message names the layer cut short.
  const cars = TRAFFIC_CAR_LAYERS.reduce((most, name) => (m[name].length > most ? m[name].length : most), 0);
  for (const name of TRAFFIC_CAR_LAYERS) {
    if (m[name].length !== cars) throw new SaveError(`save rejected: world.mesoTraffic.${name}: ${m[name].length} cars, the other car layers ${cars}`);
  }
  if (m.routes.length > cars) throw new SaveError(`save rejected: world.mesoTraffic.routes: ${m.routes.length} routes for ${cars} cars`);
  if (!isCount(m.highWater) || m.highWater > cars) throw new SaveError(`save rejected: world.mesoTraffic.highWater: ${m.highWater} in ${cars} cars`);
  if (!isCount(m.count) || m.count > m.highWater) throw new SaveError(`save rejected: world.mesoTraffic.count: ${m.count} above the high-water mark ${m.highWater}`);
}

/** A new world from a checked save file. `unchecked` hears of every place the load had no template to hold to. */
export function worldFromSave(file: SaveFile, unchecked?: (path: string) => void): World {
  const template = createWorld(file.options);
  let world: unknown;
  try {
    const classes = new Map([...CLASS_SAMPLES, ...classInstances(template), ...runtimeSamples(template.simRng)]);
    world = decodeNode(file.world, template, 'world', { nullable: NULLABLE_FIELDS, elements: ELEMENT_TEMPLATES, classes, unchecked });
  } catch (error) {
    throw error instanceof SaveError ? new SaveError(`save rejected: ${error.message}`) : error;
  }
  const w = world as World;
  const { options } = file;
  const differs = (name: string, saved: unknown, world: unknown) => {
    throw new SaveError(`save rejected: options.${name}: ${String(saved)}, but the world saved has ${String(world)}`);
  };
  if (w.mapConfig.width !== options.mapWidth) differs('mapWidth', options.mapWidth, w.mapConfig.width);
  if (w.mapConfig.height !== options.mapHeight) differs('mapHeight', options.mapHeight, w.mapConfig.height);
  if (w.gameHourNs !== options.gameHourNs) differs('gameHourNs', options.gameHourNs, w.gameHourNs);
  if (w.microTraffic !== options.microTraffic) differs('microTraffic', options.microTraffic, w.microTraffic);
  if (w.grid.width !== w.mapConfig.width || w.grid.height !== w.mapConfig.height) {
    throw new SaveError(`save rejected: world.grid: ${w.grid.width}×${w.grid.height} on a map of ${w.mapConfig.width}×${w.mapConfig.height}`);
  }
  if (!isCount(w.tick)) throw new SaveError(`save rejected: world.tick: ${w.tick} is not a count`);
  const runtime: unknown = w.scenarioRuntime;
  if (runtime !== null && !(typeof runtime === 'object' && SCENARIO_RUNTIMES.includes(savedClassName(runtime) ?? ''))) {
    throw new SaveError(`save rejected: world.scenarioRuntime: expected a scenario runtime, found ${kindOf(runtime)}`);
  }
  // The citizens' layers grow together: one length per slot, `AGENDA_STOPS` a slot for the stops.
  const c = w.citizens;
  // The longest layer sets the slots, so the message names the layer cut short.
  const slots = CITIZEN_LAYER_NAMES.reduce((most, name) => (c[name].length > most ? c[name].length : most), 0);
  for (const name of CITIZEN_LAYER_NAMES) {
    if (c[name].length !== slots) throw new SaveError(`save rejected: world.citizens.${name}: ${c[name].length} slots, the other layers ${slots}`);
  }
  for (const name of STOP_LAYER_NAMES) {
    if (c[name].length !== slots * AGENDA_STOPS) throw new SaveError(`save rejected: world.citizens.${name}: ${c[name].length} stops for ${slots} slots`);
  }
  if (!isCount(c.highWater) || c.highWater > slots) throw new SaveError(`save rejected: world.citizens.highWater: ${c.highWater} in ${slots} slots`);
  if (!isCount(c.count) || c.count > c.highWater) throw new SaveError(`save rejected: world.citizens.count: ${c.count} above the high-water mark ${c.highWater}`);
  const tiles = w.grid.width * w.grid.height;
  for (const layer of w.grid.layers()) {
    if (layer.length !== tiles) throw new SaveError(`save rejected: world.grid: a layer of ${layer.length} tiles on a map of ${tiles}`);
  }
  checkMesoLengths(w);
  return w;
}
