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

/** The name `SAVED_CLASSES` gives the class of `v`; `undefined` for anything else. */
export function savedClassName(v: object): string | undefined {
  return CLASS_NAMES.get(Object.getPrototypeOf(v) as object);
}

/** What a value is, as far as a save can tell: a primitive type, a typed array, a collection or a saved class. */
export function kindOf(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v !== 'object') return typeof v;
  if (ArrayBuffer.isView(v)) return typedArrayName(v) ?? 'DataView';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Map) return 'Map';
  if (v instanceof Set) return 'Set';
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype ? 'object' : `class ${CLASS_NAMES.get(proto as object) ?? '(unsaved)'}`;
}

/**
 * In a template, a field that is `null` or else shaped like `sample`: what a `null` of a fresh world may become. A
 * `sample` of `undefined` takes any value (a union the save does not spell out).
 */
export class NullOr {
  constructor(readonly sample: unknown) {}
}

/** In a template, an array whose every item is shaped like `item`. */
export class ListOf {
  constructor(readonly item: unknown) {}
}

/** In a template, an array of exactly these items, each shaped like its own. */
export class TupleOf {
  constructor(readonly items: readonly unknown[]) {}
}

/** In a template, a Map of keys shaped like `key` to values shaped like `value`. */
export class MapOf {
  constructor(
    readonly key: unknown,
    readonly value: unknown,
  ) {}
}

/** In a template, a Set of items shaped like `item`. */
export class SetOf {
  constructor(readonly item: unknown) {}
}

/** In a template, a plain object whose `tag` field names one of `variants`, and which has exactly that variant's fields. */
export class OneOf {
  constructor(
    readonly tag: string,
    readonly variants: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  ) {}
}

/** In a template, a string that is one of `values`: a union of string literals. */
export class Literal {
  constructor(readonly values: readonly string[]) {}
}

/** In a template, a field an object may leave out (`field?: T`), shaped like `sample` when present. */
export class Optional {
  constructor(readonly sample: unknown) {}
}

/** What a load holds the save against besides the fresh world itself. */
export interface DecodeRules {
  /**
   * Samples for fields a fresh world holds as `null`, keyed `Class.field` for a field of a saved class and by path
   * (`world.nextState`) otherwise. Without a sample, such a field must stay `null`.
   */
  readonly nullable: Readonly<Record<string, unknown>>;
  /**
   * The shape of a collection (`ListOf`, `TupleOf`, `MapOf`, `SetOf`) the fresh world holds, by its path
   * (`world.commands`) or as `Class.field` for a field of a saved class. A collection nested in a template carries its
   * shape in the template itself.
   */
  readonly elements: Readonly<Record<string, unknown>>;
  /** An instance of each saved class, for one met where the fresh world has nothing, as an element of a collection. */
  readonly classes: ReadonlyMap<string, object>;
  /** Told the path of every collection, object and class instance the load took without a template to hold it to. */
  readonly unchecked?: ((path: string) => void) | undefined;
}

/** Every instance of a saved class in `root`, one per class. */
export function classInstances(root: unknown): Map<string, object> {
  const found = new Map<string, object>();
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v !== 'object' || v === null || seen.has(v) || ArrayBuffer.isView(v)) continue;
    seen.add(v);
    const name = CLASS_NAMES.get(Object.getPrototypeOf(v) as object);
    if (name !== undefined && !found.has(name)) found.set(name, v);
    if (v instanceof Map) for (const value of v.values()) stack.push(value);
    else if (v instanceof Set) for (const value of v) stack.push(value);
    else if (Array.isArray(v)) stack.push(...(v as unknown[]));
    else for (const key of Object.keys(v)) stack.push((v as Record<string, unknown>)[key]);
  }
  return found;
}

/** The kind of value a template holds. */
function templateKind(template: unknown): string {
  if (template instanceof ListOf || template instanceof TupleOf) return 'array';
  if (template instanceof MapOf) return 'Map';
  if (template instanceof SetOf) return 'Set';
  if (template instanceof OneOf) return 'object';
  if (template instanceof Literal) return 'string';
  return kindOf(template);
}

/** A template that fixes an object's shape: a value reached again by reference must have been read against it. */
const isShape = (t: unknown): boolean =>
  t instanceof ListOf ||
  t instanceof TupleOf ||
  t instanceof MapOf ||
  t instanceof SetOf ||
  t instanceof OneOf ||
  (typeof t === 'object' && t !== null && Object.getPrototypeOf(t) === Object.prototype);

const plainKeys = (t: object): string => Object.keys(t).sort().join(',');

/**
 * Whether two templates describe one shape: a shared object read against one of them may stand where the other is.
 * `proven` holds pairs already taken as equal, which also ends the walk on a template that refers back to itself.
 */
function sameShape(a: unknown, b: unknown, proven: Map<unknown, Set<unknown>>): boolean {
  if (a === b || proven.get(a)?.has(b) === true) return true;
  const pairs = proven.get(a) ?? new Set<unknown>();
  proven.set(a, pairs.add(b));
  const same = (x: unknown, y: unknown) => sameShape(x, y, proven);
  let equal: boolean;
  if (a instanceof NullOr || a instanceof Optional) equal = b instanceof a.constructor && same(a.sample, (b as NullOr).sample);
  else if (a instanceof ListOf || a instanceof SetOf) equal = b instanceof a.constructor && same(a.item, (b as ListOf).item);
  else if (a instanceof MapOf) equal = b instanceof MapOf && same(a.key, b.key) && same(a.value, b.value);
  else if (a instanceof TupleOf) equal = b instanceof TupleOf && a.items.length === b.items.length && a.items.every((t, i) => same(t, b.items[i]));
  else if (a instanceof Literal) equal = b instanceof Literal && a.values.join('|') === b.values.join('|');
  else if (a instanceof OneOf) {
    equal = b instanceof OneOf && a.tag === b.tag && plainKeys(a.variants) === plainKeys(b.variants) && Object.keys(a.variants).every((k) => same(a.variants[k], b.variants[k]));
  } else if (isShape(a) || isShape(b)) {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    equal = isShape(a) && isShape(b) && !(b instanceof ListOf || b instanceof SetOf || b instanceof MapOf || b instanceof TupleOf || b instanceof OneOf);
    equal = equal && plainKeys(x) === plainKeys(y) && Object.keys(x).every((k) => same(x[k], y[k]));
  } else equal = a !== undefined && b !== undefined && templateKind(a) === templateKind(b);
  if (!equal) pairs.delete(b);
  return equal;
}

/** A value must be of the kind its template holds; no template, no check. */
function checkKind(value: unknown, template: unknown, path: string): void {
  if (template instanceof NullOr) {
    if (value !== null) checkKind(value, template.sample, path);
    return;
  }
  if (template === undefined) return;
  const want = templateKind(template);
  const got = kindOf(value);
  if (want !== got) throw new SaveError(`${path}: expected ${want}, found ${got}`);
  if (template instanceof Literal && !template.values.includes(value as string)) {
    throw new SaveError(`${path}: expected one of ${template.values.join(' | ')}, found ${JSON.stringify(value)}`);
  }
}

/**
 * Strict against a fresh world: an object with a counterpart there (the world, its resources and their fields), an
 * instance of a saved class and an element with a template must have exactly its template's fields, each of its kind.
 */
class Decoder {
  private readonly byId = new Map<number, unknown>();
  /** The template each object with an id was read against, for the references to it. */
  private readonly readAs = new Map<number, unknown>();
  private readonly proven = new Map<unknown, Set<unknown>>();

  constructor(private readonly rules: DecodeRules) {}

  /** `template` is the value at the same place in a fresh world of the save's options, `undefined` where none is. */
  node(node: SaveNode, template: unknown, path: string): unknown {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return this.array([], node, template, path);
    if (!isTagged(node)) return this.object({}, node, template, path);
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
        return this.keep(node.id, new Ctor(bytes.buffer as ArrayBuffer) as TypedArray, template, path);
      }
      case 'arr':
        return this.array(this.keep(node.id, [], template, path), node.v, template, path);
      case 'obj':
        return this.object(this.keep(node.id, {}, template, path), node.v, template, path);
      case 'map': {
        const map = this.keep(node.id, new Map<unknown, unknown>(), template, path);
        const shape = template instanceof MapOf ? template : undefined;
        if (shape === undefined) this.rules.unchecked?.(path);
        node.v.forEach(([key, value], i) => map.set(this.checked(key, shape?.key, `${path}{key ${i}}`), this.checked(value, shape?.value, `${path}{${i}}`)));
        return map;
      }
      case 'set': {
        const set = this.keep(node.id, new Set<unknown>(), template, path);
        const item = template instanceof SetOf ? template.item : undefined;
        if (item === undefined) this.rules.unchecked?.(path);
        node.v.forEach((value, i) => set.add(this.checked(value, item, `${path}{${i}}`)));
        return set;
      }
      case 'cls': {
        const cls = Object.hasOwn(SAVED_CLASSES, node.c) ? SAVED_CLASSES[node.c] : undefined;
        if (cls === undefined) throw new SaveError(`${path}: unknown class ${JSON.stringify(node.c)}`);
        const expected = template instanceof NullOr ? template.sample : template;
        if (expected !== null && expected !== undefined && kindOf(expected) !== `class ${node.c}`) {
          throw new SaveError(`${path}: expected ${templateKind(expected)}, found class ${node.c}`);
        }
        const instance = this.keep(node.id, Object.create(cls.prototype) as Record<string, unknown>, template, path);
        const sample = expected ?? this.rules.classes.get(node.c);
        if (sample === undefined) this.rules.unchecked?.(path);
        return this.object(instance, node.v, sample, path, node.c);
      }
      case 'ref': {
        if (!this.byId.has(node.id)) throw new SaveError(`${path}: refers to object #${node.id}, which comes nowhere before it`);
        // An object first read without a template is reported there (`unchecked`); one read against a shape must fit here.
        const readAs = this.readAs.get(node.id);
        if (readAs !== undefined && isShape(template) && !sameShape(readAs, template, this.proven)) {
          throw new SaveError(`${path}: refers to object #${node.id}, which is not of the shape this place holds`);
        }
        return this.byId.get(node.id);
      }
    }
  }

  private keep<T>(id: number | undefined, value: T, template: unknown, path: string): T {
    if (id === undefined) return value;
    if (this.byId.has(id)) throw new SaveError(`${path}: object #${id} is defined twice`);
    this.byId.set(id, value);
    this.readAs.set(id, template);
    return value;
  }

  /** `node` decoded against `template` and held to its kind. */
  checked(node: SaveNode, template: unknown, path: string): unknown {
    if (template instanceof NullOr && node === null) return null;
    const value = this.node(node, template instanceof NullOr ? template.sample : template, path);
    checkKind(value, template, path);
    return value;
  }

  private array(out: unknown[], items: readonly SaveNode[], template: unknown, path: string): unknown[] {
    if (template instanceof TupleOf) {
      if (items.length !== template.items.length) throw new SaveError(`${path}: ${items.length} items, expected ${template.items.length}`);
      items.forEach((item, i) => out.push(this.checked(item, template.items[i], `${path}[${i}]`)));
      return out;
    }
    const item = template instanceof ListOf ? template.item : undefined;
    if (item === undefined) this.rules.unchecked?.(path);
    items.forEach((value, i) => out.push(this.checked(value, item, `${path}[${i}]`)));
    return out;
  }

  /** `className`: the saved class `out` is an instance of, whose `null` fields the rules name as `Class.field`. */
  private object(out: Record<string, unknown>, fields: { readonly [key: string]: SaveNode }, template: unknown, path: string, className?: string): Record<string, unknown> {
    if (template instanceof OneOf) {
      const tag = fields[template.tag];
      if (tag === undefined) throw new SaveError(`${path}.${template.tag}: missing`);
      if (typeof tag !== 'string' || !Object.hasOwn(template.variants, tag)) {
        throw new SaveError(`${path}.${template.tag}: expected one of ${Object.keys(template.variants).join(' | ')}, found ${JSON.stringify(tag)}`);
      }
      template = template.variants[tag];
    }
    if (!isPlainTemplate(template)) {
      this.rules.unchecked?.(path);
      for (const key of Object.keys(fields)) out[key] = this.node(fields[key]!, undefined, `${path}.${key}`);
      return out;
    }
    for (const key of Object.keys(template)) {
      if (!Object.hasOwn(fields, key) && !(template[key] instanceof Optional)) throw new SaveError(`${path}.${key}: missing`);
    }
    for (const key of Object.keys(fields)) {
      if (!Object.hasOwn(template, key)) throw new SaveError(`${path}.${key}: no such field in the world`);
      let expected = template[key];
      if (expected instanceof Optional) expected = expected.sample;
      if (expected === null || expected === undefined) {
        const rule = className === undefined ? `${path}.${key}` : `${className}.${key}`;
        expected = Object.hasOwn(this.rules.nullable, rule) ? new NullOr(this.rules.nullable[rule]) : null;
      } else if (Array.isArray(expected) || expected instanceof Map || expected instanceof Set) {
        // A collection of the fresh world: its items are held to the shape the rules give it.
        const byPath = `${path}.${key}`;
        const byClass = className === undefined ? undefined : `${className}.${key}`;
        if (Object.hasOwn(this.rules.elements, byPath)) expected = this.rules.elements[byPath];
        else if (byClass !== undefined && Object.hasOwn(this.rules.elements, byClass)) expected = this.rules.elements[byClass];
      }
      out[key] = this.checked(fields[key]!, expected, `${path}.${key}`);
    }
    return out;
  }
}

/** The value a save tree describes, checked field by field against `template`, its counterpart in a fresh world. */
export function decodeNode(node: SaveNode, template: unknown, path: string, rules: DecodeRules): unknown {
  return new Decoder(rules).checked(node, template, path);
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ENCODE = Uint8Array.from(ALPHABET, (ch) => ch.charCodeAt(0));
const DECODE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;
const PAD = 61; // '='

/**
 * WHATWG Encoding, in every engine the sim runs on (browser, worker, Node, Bun) though the ES lib does not type it.
 * Decoding the ASCII of the base64 is the fastest way to a string: `String.fromCharCode` over chunks took 4 s for
 * 20 MB in Node, this 0.4 s.
 */
declare const TextDecoder: new (label: string) => { decode(input: Uint8Array): string };
const ASCII = new TextDecoder('latin1');

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
  return ASCII.decode(out);
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
