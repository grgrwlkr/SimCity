// The world as a JSON tree and back. Generic by design: every field of every object reachable from the world is
// written, so state added later is saved without touching this file, and whatever cannot come back (a function, a
// class missing from `SAVED_CLASSES`, two typed arrays on one buffer) fails the save instead of being dropped.
//
// A node is a JSON value; a typed array, a bigint, a number JSON cannot spell, a Map, a Set, a class instance, an
// object reached twice and a reference to one are tagged objects `{ $: kind, … }`. Objects reached more than once
// carry an `id` the first time and are `{ $: 'ref', id }` after, so shared objects stay shared.
import { SAVED_CLASSES } from './classes';

export type SaveNode = number | string | boolean | null | SaveNode[] | TaggedNode | { readonly [key: string]: SaveNode };

export type TaggedNode =
  | { readonly $: 'num'; readonly v: 'NaN' | 'Infinity' | '-Infinity' | '-0' }
  | { readonly $: 'undef' }
  | { readonly $: 'big'; readonly v: string }
  | { readonly $: 'ta'; readonly t: TypedArrayName; readonly v: string; readonly id?: number | undefined }
  | { readonly $: 'arr'; readonly v: SaveNode[]; readonly id?: number | undefined }
  | { readonly $: 'obj'; readonly v: { readonly [key: string]: SaveNode }; readonly id?: number | undefined }
  | { readonly $: 'map'; readonly v: Array<[SaveNode, SaveNode]>; readonly id?: number | undefined }
  | { readonly $: 'set'; readonly v: SaveNode[]; readonly id?: number | undefined }
  | { readonly $: 'cls'; readonly c: string; readonly v: { readonly [key: string]: SaveNode }; readonly id?: number | undefined }
  | { readonly $: 'ref'; readonly id: number };

type TypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

/** By name, not `constructor.name`: a minified build renames constructors. */
const TYPED_ARRAYS = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
} as const;
export type TypedArrayName = keyof typeof TYPED_ARRAYS;
export const TYPED_ARRAY_NAMES = Object.keys(TYPED_ARRAYS) as TypedArrayName[];

/** A save that cannot be written or read; the message names the place in the world. */
export class SaveError extends Error {
  override readonly name = 'SaveError';
}

const CLASS_NAMES = new Map<object, string>(Object.entries(SAVED_CLASSES).map(([name, cls]) => [cls.prototype, name]));

function typedArrayName(view: ArrayBufferView): TypedArrayName | null {
  for (const name of TYPED_ARRAY_NAMES) if (view instanceof TYPED_ARRAYS[name]) return name;
  return null;
}

const isObject = (v: unknown): v is object => (typeof v === 'object' && v !== null) || typeof v === 'function';

/** How often each object is reached, so only shared ones spend an id. */
function countReferences(root: unknown): Map<object, number> {
  const counts = new Map<object, number>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (!isObject(v)) continue;
    const n = counts.get(v);
    counts.set(v, (n ?? 0) + 1);
    if (n !== undefined || ArrayBuffer.isView(v) || typeof v === 'function') continue;
    if (v instanceof Map) {
      for (const [key, value] of v) stack.push(key, value);
    } else if (v instanceof Set) {
      for (const value of v) stack.push(value);
    } else if (Array.isArray(v)) {
      for (const value of v as unknown[]) if (isObject(value)) stack.push(value);
    } else {
      for (const key of Object.keys(v)) stack.push((v as Record<string, unknown>)[key]);
    }
  }
  return counts;
}

class Encoder {
  private readonly ids = new Map<object, number>();
  private readonly buffers = new Map<ArrayBufferLike, string>();

  constructor(private readonly counts: Map<object, number>) {}

  node(v: unknown, path: string): SaveNode {
    switch (typeof v) {
      case 'number':
        if (Number.isFinite(v) && !Object.is(v, -0)) return v;
        return { $: 'num', v: Object.is(v, -0) ? '-0' : (String(v) as 'NaN' | 'Infinity' | '-Infinity') };
      case 'string':
      case 'boolean':
        return v;
      case 'bigint':
        return { $: 'big', v: v.toString() };
      case 'undefined':
        return { $: 'undef' };
      case 'function':
      case 'symbol':
        throw new SaveError(`${path}: a ${typeof v} cannot be saved`);
      case 'object':
        return v === null ? null : this.object(v, path);
    }
  }

  private object(v: object, path: string): SaveNode {
    const seen = this.ids.get(v);
    if (seen !== undefined) return { $: 'ref', id: seen };
    let id: number | undefined;
    if ((this.counts.get(v) ?? 0) > 1) {
      id = this.ids.size;
      this.ids.set(v, id);
    }
    const withId = id === undefined ? {} : { id };
    if (ArrayBuffer.isView(v)) {
      const t = typedArrayName(v);
      if (t === null) throw new SaveError(`${path}: a DataView cannot be saved`);
      const other = this.buffers.get(v.buffer);
      if (other !== undefined) throw new SaveError(`${path}: shares its buffer with ${other}, which a save cannot keep`);
      this.buffers.set(v.buffer, path);
      return { $: 'ta', t, v: bytesToBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), ...withId };
    }
    if (v instanceof Map) {
      let i = 0;
      const entries: Array<[SaveNode, SaveNode]> = [];
      for (const [key, value] of v) {
        entries.push([this.node(key, `${path}{key ${i}}`), this.node(value, `${path}{${i}}`)]);
        i += 1;
      }
      return { $: 'map', v: entries, ...withId };
    }
    if (v instanceof Set) {
      let i = 0;
      const values: SaveNode[] = [];
      for (const value of v) values.push(this.node(value, `${path}{${i++}}`));
      return { $: 'set', v: values, ...withId };
    }
    if (Array.isArray(v)) {
      const items = (v as unknown[]).map((value, i) => this.node(value, `${path}[${i}]`));
      return id === undefined ? items : { $: 'arr', v: items, id };
    }
    if (v instanceof WeakMap || v instanceof WeakSet || v instanceof Promise) throw new SaveError(`${path}: a weak collection or promise cannot be saved`);
    const proto: unknown = Object.getPrototypeOf(v);
    const fields: Record<string, SaveNode> = {};
    for (const key of Object.keys(v)) fields[key] = this.node((v as Record<string, unknown>)[key], `${path}.${key}`);
    if (proto === Object.prototype) {
      return id === undefined && !Object.hasOwn(fields, '$') ? fields : { $: 'obj', v: fields, ...withId };
    }
    const c = CLASS_NAMES.get(proto as object);
    if (c === undefined) throw new SaveError(`${path}: an instance of a class missing from SAVED_CLASSES cannot be saved`);
    return { $: 'cls', c, v: fields, ...withId };
  }
}

/** `root` as a save tree. */
export function encodeNode(root: unknown, path: string): SaveNode {
  return new Encoder(countReferences(root)).node(root, path);
}

const isTagged = (node: object): node is TaggedNode => Object.hasOwn(node, '$');

const isPlainTemplate = (t: unknown): t is Record<string, unknown> =>
  typeof t === 'object' && t !== null && !Array.isArray(t) && !ArrayBuffer.isView(t) && !(t instanceof Map) && !(t instanceof Set);

class Decoder {
  private readonly byId = new Map<number, unknown>();

  /**
   * `template` is the value at the same place in a fresh world: an object field the save lacks keeps the template's,
   * as a field added after the save was written would.
   */
  node(node: SaveNode, template: unknown, path: string): unknown {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return this.array([], node, path);
    if (!isTagged(node)) return this.fields({}, node, template, path);
    switch (node.$) {
      case 'num':
        return Number(node.v);
      case 'undef':
        return undefined;
      case 'big':
        return BigInt(node.v);
      case 'ta': {
        const bytes = base64ToBytes(node.v, path);
        const Ctor = TYPED_ARRAYS[node.t];
        if (bytes.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) {
          throw new SaveError(`${path}: ${bytes.byteLength} bytes are not a whole number of ${node.t} elements`);
        }
        return this.keep(node.id, new Ctor(bytes.buffer as ArrayBuffer) as TypedArray, path);
      }
      case 'arr':
        return this.array(this.keep(node.id, [], path), node.v, path);
      case 'obj':
        return this.fields(this.keep(node.id, {}, path), node.v, template, path);
      case 'map': {
        const map = this.keep(node.id, new Map<unknown, unknown>(), path);
        node.v.forEach(([key, value], i) => map.set(this.node(key, undefined, `${path}{key ${i}}`), this.node(value, undefined, `${path}{${i}}`)));
        return map;
      }
      case 'set': {
        const set = this.keep(node.id, new Set<unknown>(), path);
        node.v.forEach((value, i) => set.add(this.node(value, undefined, `${path}{${i}}`)));
        return set;
      }
      case 'cls': {
        const cls = Object.hasOwn(SAVED_CLASSES, node.c) ? SAVED_CLASSES[node.c] : undefined;
        if (cls === undefined) throw new SaveError(`${path}: unknown class ${JSON.stringify(node.c)}`);
        const instance = this.keep(node.id, Object.create(cls.prototype) as Record<string, unknown>, path);
        return this.fields(instance, node.v, template, path);
      }
      case 'ref': {
        if (!this.byId.has(node.id)) throw new SaveError(`${path}: refers to object #${node.id}, which comes nowhere before it`);
        return this.byId.get(node.id);
      }
    }
  }

  private keep<T>(id: number | undefined, value: T, path: string): T {
    if (id === undefined) return value;
    if (this.byId.has(id)) throw new SaveError(`${path}: object #${id} is defined twice`);
    this.byId.set(id, value);
    return value;
  }

  private array(out: unknown[], items: readonly SaveNode[], path: string): unknown[] {
    items.forEach((item, i) => out.push(this.node(item, undefined, `${path}[${i}]`)));
    return out;
  }

  private fields(out: Record<string, unknown>, fields: { readonly [key: string]: SaveNode }, template: unknown, path: string): Record<string, unknown> {
    const plain = isPlainTemplate(template);
    for (const key of Object.keys(fields)) out[key] = this.node(fields[key]!, plain ? template[key] : undefined, `${path}.${key}`);
    if (plain) for (const key of Object.keys(template)) if (!Object.hasOwn(fields, key)) out[key] = template[key];
    return out;
  }
}

/** The value a save tree describes, with `template` filling what the save lacks. */
export function decodeNode(node: SaveNode, template: unknown, path: string): unknown {
  return new Decoder().node(node, template, path);
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ENCODE = Uint8Array.from(ALPHABET, (ch) => ch.charCodeAt(0));
const DECODE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;
const PAD = 61; // '='
/** Characters per `String.fromCharCode` call: well under any engine's argument limit. */
const CHUNK = 0x6000;

export function bytesToBase64(bytes: Uint8Array): string {
  const out = new Uint8Array(((bytes.length + 2) / 3 | 0) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out[o++] = ENCODE[n >>> 18]!;
    out[o++] = ENCODE[(n >>> 12) & 63]!;
    out[o++] = ENCODE[(n >>> 6) & 63]!;
    out[o++] = ENCODE[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest > 0) {
    const n = (bytes[i]! << 16) | (rest === 2 ? bytes[i + 1]! << 8 : 0);
    out[o++] = ENCODE[n >>> 18]!;
    out[o++] = ENCODE[(n >>> 12) & 63]!;
    out[o++] = rest === 2 ? ENCODE[(n >>> 6) & 63]! : PAD;
    out[o] = PAD;
  }
  const parts: string[] = [];
  for (let at = 0; at < out.length; at += CHUNK) parts.push(String.fromCharCode(...out.subarray(at, at + CHUNK)));
  return parts.join('');
}

export function base64ToBytes(text: string, path: string): Uint8Array {
  if (text.length % 4 !== 0) throw new SaveError(`${path}: base64 of ${text.length} characters, not a multiple of 4`);
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = sextet(text, i, path);
    const b = sextet(text, i + 1, path);
    const last = i + 4 === text.length;
    const c = last && pad === 2 ? 0 : sextet(text, i + 2, path);
    const d = last && pad >= 1 ? 0 : sextet(text, i + 3, path);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = n >>> 16;
    if (o < out.length) out[o++] = (n >>> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

function sextet(text: string, i: number, path: string): number {
  const code = text.charCodeAt(i);
  const value = code < 128 ? DECODE[code]! : -1;
  if (value < 0) throw new SaveError(`${path}: ${JSON.stringify(text[i])} at ${i} is not base64`);
  return value;
}
