// FNV-1a 64 over the whole simulation state in a fixed order, per section. The determinism pins,
// the divergence probe and the cross-engine gate compare it: a field missing here is a field no
// pin can see diverge (test `fingerprintCoversEveryStateField`). Typed arrays are hashed as their
// little-endian bytes; every target this ships to is little-endian.
import type { GameCommand } from './commands';
import type { TickEvents } from './events';
import type { Notifications } from './notifications';
import type { Timer } from './timer';
import type { VehicleLayers } from './traffic/vehicles';
import type { World } from './world';

const FNV_OFFSET_HI = 0xcbf2_9ce4;
const FNV_OFFSET_LO = 0x8422_2325;

const f64Scratch = new Float64Array(1);
const f64Bytes = new Uint8Array(f64Scratch.buffer);
const f32Scratch = new Float32Array(1);
const f32Bits = new Uint32Array(f32Scratch.buffer);

/**
 * FNV-1a 64 on two 32-bit halves. The prime is 2^40 + 0x1b3, so `(hi, lo) * prime` is
 * `hi*0x1b3 + carry + lo<<8` over `lo*0x1b3`; the low product is split at 16 bits to stay in int range.
 */
export class Fnv64 {
  private hi = FNV_OFFSET_HI;
  private lo = FNV_OFFSET_LO;

  byte(value: number): void {
    const lo = (this.lo ^ (value & 0xff)) >>> 0;
    const p = (lo & 0xffff) * 0x1b3;
    const mid = (p >>> 16) + (lo >>> 16) * 0x1b3;
    this.lo = (((mid & 0xffff) << 16) | (p & 0xffff)) >>> 0;
    this.hi = (Math.imul(this.hi, 0x1b3) + (mid >>> 16) + (lo << 8)) >>> 0;
  }

  u32(value: number): void {
    this.byte(value);
    this.byte(value >>> 8);
    this.byte(value >>> 16);
    this.byte(value >>> 24);
  }

  i32(value: number): void {
    this.u32(value >>> 0);
  }

  u64(value: bigint): void {
    const v = BigInt.asUintN(64, value);
    this.u32(Number(v & 0xffff_ffffn));
    this.u32(Number(v >> 32n));
  }

  /** A safe integer, hashed as its `i64` two's complement. */
  int(value: number): void {
    this.u64(BigInt(value));
  }

  f32(value: number): void {
    f32Scratch[0] = value;
    this.u32(f32Bits[0]!);
  }

  f64(value: number): void {
    f64Scratch[0] = value;
    for (const b of f64Bytes) this.byte(b);
  }

  bool(value: boolean): void {
    this.byte(value ? 1 : 0);
  }

  str(value: string): void {
    this.u32(value.length);
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      this.byte(unit);
      this.byte(unit >>> 8);
    }
  }

  /** One 32-bit word folded in as a single FNV symbol. */
  word(value: number): void {
    const lo = (this.lo ^ value) >>> 0;
    const p = (lo & 0xffff) * 0x1b3;
    const mid = (p >>> 16) + (lo >>> 16) * 0x1b3;
    this.lo = (((mid & 0xffff) << 16) | (p & 0xffff)) >>> 0;
    this.hi = (Math.imul(this.hi, 0x1b3) + (mid >>> 16) + (lo << 8)) >>> 0;
  }

  /**
   * A typed array: its byte length, then its little-endian 32-bit words as symbols, then the tail
   * bytes. Words rather than bytes: the fingerprint runs every tick in the divergence probe, and
   * the result only has to agree between engines, not with any external FNV implementation.
   */
  bytes(view: ArrayBufferView): void {
    const len = view.byteLength;
    this.u32(len);
    const data = new DataView(view.buffer, view.byteOffset, len);
    const words = len >>> 2;
    let hi = this.hi;
    let lo = this.lo;
    for (let w = 0; w < words; w++) {
      lo = (lo ^ data.getUint32(w * 4, true)) >>> 0;
      const p = (lo & 0xffff) * 0x1b3;
      const mid = (p >>> 16) + (lo >>> 16) * 0x1b3;
      hi = (Math.imul(hi, 0x1b3) + (mid >>> 16) + (lo << 8)) >>> 0;
      lo = (((mid & 0xffff) << 16) | (p & 0xffff)) >>> 0;
    }
    this.hi = hi;
    this.lo = lo;
    for (let i = words * 4; i < len; i++) this.byte(data.getUint8(i));
  }

  digest(): bigint {
    return (BigInt(this.hi) << 32n) | BigInt(this.lo);
  }
}

export function toHex64(value: bigint): string {
  return value.toString(16).padStart(16, '0');
}

/**
 * The iteration and free lists, every slot's generation, and every layer of the live slots in
 * iteration order. A dead slot's other fields cannot reach the future: `spawnVehicle` overwrites
 * all of them.
 */
function hashVehicles(h: Fnv64, v: VehicleLayers): void {
  h.u32(v.capacity);
  // Lists as words, not JSON: the free list alone is 4096 numbers on an empty map.
  h.u32(v.order.length);
  for (const slot of v.order) h.u32(slot);
  h.u32(v.free.length);
  for (const slot of v.free) h.u32(slot);
  h.bytes(v.generation);
  const layers = Object.entries(v)
    .filter((entry): entry is [string, ArrayBufferView] => ArrayBuffer.isView(entry[1]) && entry[0] !== 'generation')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, layer] of layers) {
    h.str(name);
    if (layer instanceof Float32Array) for (const slot of v.order) h.f32(layer[slot]!);
    else if (layer instanceof Float64Array) for (const slot of v.order) h.f64(layer[slot]!);
    else if (layer instanceof Int32Array) for (const slot of v.order) h.i32(layer[slot]!);
    else if (layer instanceof Uint32Array) for (const slot of v.order) h.u32(layer[slot]!);
    else if (layer instanceof Uint8Array) for (const slot of v.order) h.byte(layer[slot]!);
    else throw new TypeError(`fingerprint: unhandled vehicle layer type for ${name}`);
  }
  h.str(stableJson(v.order.map((slot) => [v.trafficState[slot], v.laneletPlan[slot]])));
}

function hashTraffic(h: Fnv64, w: World): void {
  h.str(stableJson(w.pathPool.fingerprintState()));
  h.int(w.vehicleSeq);
  h.str(stableJson(w.trafficLights));
  h.str(stableJson([[...w.leftTurnDemand.ns], [...w.leftTurnDemand.ew]]));
  h.str(stableJson(w.reservations.fingerprintState()));
}

function hashTimer(h: Fnv64, t: Timer): void {
  h.int(t.durationNs);
  h.str(t.mode);
  h.int(t.elapsedNs);
  h.bool(t.finished);
  h.u32(t.timesFinishedThisTick);
  h.bool(t.paused);
}

function hashEvents(h: Fnv64, e: TickEvents): void {
  h.u32(e.hourAdvanced.length);
  for (const { hour, day } of e.hourAdvanced) {
    h.u32(hour);
    h.u32(day);
  }
  h.u32(e.dayAdvanced.length);
  for (const day of e.dayAdvanced) h.u32(day);
}

function hashNotifications(h: Fnv64, n: Notifications): void {
  h.u32(n.currentDay());
  h.int(n.historyVersion());
  const history = n.history();
  h.u32(history.length);
  for (const line of history) {
    h.u32(line.day);
    h.str(line.kind);
    h.u32(line.count);
    h.str(line.text);
  }
  const toasts = n.messages();
  h.u32(toasts.length);
  for (const toast of toasts) {
    h.str(toast.kind);
    h.u32(toast.count);
    h.f32(toast.duration);
    h.bool(toast.at !== null);
    if (toast.at !== null) {
      h.i32(toast.at.x);
      h.i32(toast.at.y);
    }
    h.str(toast.text);
  }
}

/** JSON with bigints spelled out; JSON number formatting is fully specified, so engines agree. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));
}

function commandKey(cmd: GameCommand): string {
  return stableJson(cmd);
}

function hashTransport(h: Fnv64, w: World): void {
  const road = w.roadGraph;
  h.int(road.version);
  h.i32(road.width);
  h.i32(road.height);
  h.bytes(road.edges);
  h.u32(road.roadIndices.length);
  for (const i of road.roadIndices) h.u32(i);

  const regions = w.regionGraph;
  h.int(regions.version);
  h.u32(regions.regionSize);
  h.u32(regions.regionsW);
  h.u32(regions.regionsH);
  h.bytes(regions.edges);

  const lanes = w.laneGraph;
  h.int(lanes.builtFor ?? -1);
  h.str(stableJson(lanes.builtDims));
  h.str(stableJson(lanes.lanes));
  h.u32(lanes.posToId.size);
  for (const [key, id] of lanes.posToId) {
    h.int(key);
    h.u32(id);
  }
  h.u32(lanes.tileLaneToId.size);
  for (const [key, id] of lanes.tileLaneToId) {
    h.str(key);
    h.u32(id);
  }
  h.int(w.turnLaneAutogenVersion);

  h.int(w.pathCache.version);
  h.str(stableJson([...w.pathCache.map]));
  h.str(stableJson(w.pathCache.lru));
  h.str(stableJson(w.pathfindingConfig));

  const ix = w.intersections;
  h.int(ix.version);
  h.str(stableJson(ix.clusters));
  h.u32(ix.tileToIntersection.size);
  for (const [key, id] of ix.tileToIntersection) {
    h.int(key);
    h.u32(id);
  }
  h.str(stableJson([...ix.trafficLightKeys]));
  h.str(stableJson([...ix.trafficLights]));
  h.bool(ix.lightsDirty);

  const lanelets = w.laneletGraph;
  h.int(lanelets.version);
  h.int(lanelets.builtFor ?? -1);
  h.str(stableJson(lanelets.builtDims));
  h.str(stableJson(lanelets.lanelets));
  h.str(stableJson([...lanelets.byIntersection]));
  h.str(stableJson([...lanelets.byEntryLane]));

  const conflicts = w.laneletConflicts;
  h.int(conflicts.version);
  h.u32(conflicts.byIntersection.size);
  for (const [id, matrix] of conflicts.byIntersection) {
    h.u32(id);
    h.u32(matrix.len());
    h.u32(matrix.crosswalkBase());
    for (let i = 0; i < matrix.len(); i++) h.bytes(matrix.row(i));
  }
  h.str(stableJson([...conflicts.crosswalkSides]));
  h.str(stableJson(w.trafficConfig));

  h.bytes(w.trafficOccupancy.perTickVehicles);
}

const SECTIONS: ReadonlyArray<readonly [string, (h: Fnv64, w: World) => void]> = [
  [
    'meta',
    (h, w) => {
      h.int(w.tick);
      h.str(w.appState);
      h.bool(w.nextState !== null);
      if (w.nextState !== null) {
        h.str(w.nextState.state);
        h.bool(w.nextState.ifNeq);
      }
      h.u64(w.mapSeed);
    },
  ],
  [
    'city',
    (h, { city }) => {
      h.int(city.day);
      h.int(city.hour);
      h.int(city.money);
      h.int(city.population);
      h.f32(city.happiness);
      h.int(city.lastIncome);
      h.int(city.lastExpense);
    },
  ],
  [
    'clocks',
    (h, w) => {
      hashTimer(h, w.clock);
      hashTimer(h, w.buildingUpgradeClock);
    },
  ],
  [
    'rng',
    (h, w) => {
      h.bytes(w.simRng.stateWords());
      h.bytes(w.growthRng.stateWords());
    },
  ],
  [
    'events',
    (h, w) => {
      hashEvents(h, w.events);
      hashEvents(h, w.pendingEvents);
    },
  ],
  ['notifications', (h, w) => hashNotifications(h, w.notifications)],
  [
    'commands',
    (h, w) => {
      h.u32(w.commands.length);
      for (const cmd of w.commands) h.str(commandKey(cmd));
    },
  ],
  [
    'map',
    (h, w) => {
      h.i32(w.grid.width);
      h.i32(w.grid.height);
      for (const layer of w.grid.layers()) h.bytes(layer);
      for (const dirty of [w.dirty, w.roadDirty]) {
        const marked = dirty.marked();
        h.u32(marked.length);
        for (const i of marked) h.u32(i);
      }
      h.int(w.mapEditVersion);
      h.int(w.graphVersion);
    },
  ],
  [
    'history',
    (h, w) => {
      const { undo, redo } = w.history.stacks();
      h.str(JSON.stringify(undo));
      h.str(JSON.stringify(redo));
      h.u32(w.undoRedo.length);
      for (const redoRequest of w.undoRedo) h.bool(redoRequest);
    },
  ],
  ['transport', hashTransport],
  ['traffic', hashTraffic],
  ['vehicles', (h, w) => hashVehicles(h, w.vehicles)],
];

export interface FingerprintSection {
  readonly name: string;
  readonly digest: bigint;
}

export function fingerprintSections(w: World): FingerprintSection[] {
  return SECTIONS.map(([name, write]) => {
    const h = new Fnv64();
    write(h, w);
    return { name, digest: h.digest() };
  });
}

export function fingerprint(w: World): bigint {
  const h = new Fnv64();
  for (const section of fingerprintSections(w)) h.u64(section.digest);
  return h.digest();
}
