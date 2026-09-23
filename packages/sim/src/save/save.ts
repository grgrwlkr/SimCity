// Save format v1: the whole world as JSON, checked by zod before anything is built from it. A load builds a new
// world and never touches the one running: a file that fails anywhere leaves the game as it was. Rust `.ron` saves
// (SaveGameV3, crates/simcity_data/src/game/persistence_contract.rs in rust-final) are not read.
import { z } from 'zod';
import { AGENDA_STOPS, LAYER_NAMES as CITIZEN_LAYER_NAMES, STOP_LAYER_NAMES } from '../citizens';
import { createWorld, type World } from '../world';
import { SaveError, TYPED_ARRAY_NAMES, classInstances, decodeNode, encodeNode, type SaveNode } from './codec';
import { ELEMENT_TEMPLATES, NULLABLE_FIELDS } from './rules';

export { SaveError } from './codec';

export const SAVE_FORMAT = 'simcity-save';
export const SAVE_VERSION = 1;

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
 * TS game and Rust `.ron` saves are not read: nothing to migrate yet. The Rust saves' way with an added field (a
 * `#[serde(default)]` value) is a step here, never a silent default in the loader.
 */
export const SAVE_MIGRATIONS: Readonly<Record<number, SaveMigration>> = {};

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

/** A new world from a checked save file. */
export function worldFromSave(file: SaveFile): World {
  const template = createWorld(file.options);
  let world: unknown;
  try {
    world = decodeNode(file.world, template, 'world', { nullable: NULLABLE_FIELDS, elements: ELEMENT_TEMPLATES, classes: classInstances(template) });
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
  return w;
}
