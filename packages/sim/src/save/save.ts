// Save format v1: the whole world as JSON, checked by zod before anything is built from it. A load builds a new
// world and never touches the one running: a file that fails anywhere leaves the game as it was. Rust `.ron` saves
// (SaveGameV3, crates/simcity_data/src/game/persistence_contract.rs in rust-final) are not read.
import { z } from 'zod';
import { createWorld, type World } from '../world';
import { SaveError, TYPED_ARRAY_NAMES, decodeNode, encodeNode, type SaveNode } from './codec';

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
export function parseSave(text: string): SaveFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new SaveError(`save rejected: not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const parsed = saveFile.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const { path, message } = deepest(issue, []);
    throw new SaveError(`save rejected: ${path.map(String).join('.') || 'file'}: ${message}`);
  }
  return parsed.data;
}

/** A new world from a save file's text. Throws `SaveError` on a file that is not a v1 save of a whole world. */
export function loadWorld(text: string): World {
  return worldFromSave(parseSave(text));
}

/** A new world from a checked save file. */
export function worldFromSave(file: SaveFile): World {
  const template = createWorld(file.options);
  let world: unknown;
  try {
    world = decodeNode(file.world, template, 'world');
  } catch (error) {
    throw error instanceof SaveError ? new SaveError(`save rejected: ${error.message}`) : error;
  }
  if (typeof world !== 'object' || world === null || Array.isArray(world)) throw new SaveError('save rejected: world: not an object');
  return world as World;
}
