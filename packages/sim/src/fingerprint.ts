// FNV-1a 64 over the whole simulation state in a fixed order, per section. The determinism pins,
// the divergence probe and the cross-engine gate compare it: a field missing here is a field no
// pin can see diverge (test `fingerprintCoversEveryStateField`). Typed arrays are hashed as their
// little-endian bytes; every target this ships to is little-endian.
import type { GameCommand } from './commands';
import type { TickEvents } from './events';
import type { Notifications } from './notifications';
import type { Timer } from './timer';
import type { TileLayers, VehicleLayers, World } from './world';

const TWO_POW_32 = 0x1_0000_0000;
const FNV_OFFSET_HI = 0xcbf2_9ce4;
const FNV_OFFSET_LO = 0x8422_2325;

const f64Scratch = new Float64Array(1);
const f64Bytes = new Uint8Array(f64Scratch.buffer);
const f32Scratch = new Float32Array(1);
const f32Bits = new Uint32Array(f32Scratch.buffer);

/** FNV-1a 64 on two 32-bit halves: prime 2^40 + 0x1b3, every partial product exact in a double. */
export class Fnv64 {
  private hi = FNV_OFFSET_HI;
  private lo = FNV_OFFSET_LO;

  byte(value: number): void {
    const lo = (this.lo ^ (value & 0xff)) >>> 0;
    const loMul = lo * 0x1b3;
    this.hi = (this.hi * 0x1b3 + Math.floor(loMul / TWO_POW_32) + ((lo << 8) >>> 0)) >>> 0;
    this.lo = loMul >>> 0;
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

  bytes(view: ArrayBufferView): void {
    const b = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    this.u32(b.length);
    let hi = this.hi;
    let lo = this.lo;
    for (let i = 0; i < b.length; i++) {
      lo = (lo ^ b[i]!) >>> 0;
      const loMul = lo * 0x1b3;
      hi = (hi * 0x1b3 + Math.floor(loMul / TWO_POW_32) + ((lo << 8) >>> 0)) >>> 0;
      lo = loMul >>> 0;
    }
    this.hi = hi;
    this.lo = lo;
  }

  digest(): bigint {
    return (BigInt(this.hi) << 32n) | BigInt(this.lo);
  }
}

export function toHex64(value: bigint): string {
  return value.toString(16).padStart(16, '0');
}

const TILE_LAYER_ORDER: readonly (keyof TileLayers)[] = ['kind', 'zone', 'road', 'landValue', 'pollution'];
const VEHICLE_LAYER_ORDER: readonly (keyof VehicleLayers)[] = [
  'alive',
  'x',
  'y',
  'heading',
  'lanelet',
  'progress',
  'state',
  'kind',
];

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

function commandKey(cmd: GameCommand): string {
  return JSON.stringify(cmd, (_key, value: unknown) => (typeof value === 'bigint' ? `${value}n` : value));
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
    'tiles',
    (h, w) => {
      for (const layer of TILE_LAYER_ORDER) h.bytes(w.tiles[layer]);
    },
  ],
  [
    'vehicles',
    (h, w) => {
      for (const layer of VEHICLE_LAYER_ORDER) h.bytes(w.vehicles[layer]);
    },
  ],
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
