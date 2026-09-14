// Render state shared between the sim worker and the main thread without a copy per message:
// a header and two frames. The writer fills the frame the sequence does not point at and publishes
// by bumping the sequence; the reader copies the frame the sequence points at and copies again if
// the sequence moved meanwhile. After the vehicles a frame may carry the load of every meso link (stage 3½d).
import type { VehicleLayers } from '@simcity/sim';

/** `[sequence, capacity, linkCapacity]`; the active frame is `sequence & 1`. */
const HEADER_WORDS = 3;
/** `[tick, count, links, linksFor]` at the start of each frame. */
const FRAME_HEADER_WORDS = 4;
/** x, y, heading, slot, generation. */
const WORD_LAYERS = 5;

function align4(n: number): number {
  return (n + 3) & ~3;
}

export function frameByteLength(capacity: number, linkCapacity = 0): number {
  return FRAME_HEADER_WORDS * 4 + capacity * 4 * WORD_LAYERS + align4(capacity) + align4(linkCapacity);
}

export function frameByteRange(capacity: number, index: number, linkCapacity = 0): { offset: number; length: number } {
  const length = frameByteLength(capacity, linkCapacity);
  return { offset: HEADER_WORDS * 4 + index * length, length };
}

export function createRenderBuffer(capacity: number, linkCapacity = 0): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(HEADER_WORDS * 4 + 2 * frameByteLength(capacity, linkCapacity));
  const header = new Int32Array(sab, 0, HEADER_WORDS);
  header[1] = capacity;
  header[2] = linkCapacity;
  return sab;
}

interface FrameViews {
  readonly header: Int32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly heading: Float32Array;
  readonly slot: Uint32Array;
  readonly generation: Uint32Array;
  readonly kind: Uint8Array;
  readonly load: Uint8Array;
}

function frameViews(sab: SharedArrayBuffer, capacity: number, linkCapacity: number, index: number): FrameViews {
  let offset = frameByteRange(capacity, index, linkCapacity).offset;
  const header = new Int32Array(sab, offset, FRAME_HEADER_WORDS);
  offset += FRAME_HEADER_WORDS * 4;
  const x = new Float32Array(sab, offset, capacity);
  offset += capacity * 4;
  const y = new Float32Array(sab, offset, capacity);
  offset += capacity * 4;
  const heading = new Float32Array(sab, offset, capacity);
  offset += capacity * 4;
  const slot = new Uint32Array(sab, offset, capacity);
  offset += capacity * 4;
  const generation = new Uint32Array(sab, offset, capacity);
  offset += capacity * 4;
  const kind = new Uint8Array(sab, offset, capacity);
  offset += align4(capacity);
  const load = new Uint8Array(sab, offset, linkCapacity);
  return { header, x, y, heading, slot, generation, kind, load };
}

class RenderBufferViews {
  readonly capacity: number;
  /** Links a frame carries the load of at most. */
  readonly linkCapacity: number;
  protected readonly header: Int32Array;
  protected readonly frames: readonly [FrameViews, FrameViews];

  constructor(sab: SharedArrayBuffer) {
    this.header = new Int32Array(sab, 0, HEADER_WORDS);
    this.capacity = this.header[1]!;
    this.linkCapacity = this.header[2]!;
    this.frames = [frameViews(sab, this.capacity, this.linkCapacity, 0), frameViews(sab, this.capacity, this.linkCapacity, 1)];
  }

  activeFrameIndex(): number {
    return Atomics.load(this.header, 0) & 1;
  }

  /** The frame a sequence number points at. */
  protected frameFor(sequence: number): FrameViews {
    return (sequence & 1) === 0 ? this.frames[0] : this.frames[1];
  }
}

/** The kind a parked vehicle is published with, whatever its own kind: the renderer draws it apart from traffic. */
export const PARKED_VEHICLE_KIND = 4;
/** A truck of the region on the road, one standing at a door, and a citizen on foot (stage 3½). */
export const TRUCK_KIND = 5;
export const PARKED_TRUCK_KIND = 6;
export const PEDESTRIAN_KIND = 7;
/** Every id a frame may publish a vehicle under is below this. */
export const RENDER_ID_SPACE = 1 << 23;

/** Cars published after the vehicles: the cars of citizens the sim hands over (stage 3½d), each under its own slot id. */
export interface RenderExtras {
  count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly heading: Float32Array;
  readonly slot: Uint32Array;
  readonly generation: Uint32Array;
  readonly kind: Uint8Array;
}

export function extraCars(capacity: number): RenderExtras {
  return {
    count: 0,
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    heading: new Float32Array(capacity),
    slot: new Uint32Array(capacity),
    generation: new Uint32Array(capacity),
    kind: new Uint8Array(capacity),
  };
}

/** The load of every meso link a frame carries: a byte a link, 255 for a full one. */
export interface RenderLinks {
  readonly count: number;
  /** The graph version the links are numbered for. */
  readonly builtFor: number;
  readonly load: Uint8Array;
}

export class RenderWriter extends RenderBufferViews {
  /**
   * Packs the live vehicles (none with `null`), then `extras`, then the link loads into the inactive frame, then makes it
   * the active one. What does not fit is left out: a busy city never stops the worker.
   */
  publish(tick: number, vehicles: VehicleLayers | null, extras?: RenderExtras, links?: RenderLinks): void {
    const sequence = Atomics.load(this.header, 0);
    const target = this.frameFor(sequence + 1);
    let count = 0;
    for (let slot = 0; vehicles !== null && slot < vehicles.alive.length && count < this.capacity; slot++) {
      if (vehicles.alive[slot] === 0) continue;
      target.x[count] = vehicles.x[slot]!;
      target.y[count] = vehicles.y[slot]!;
      target.heading[count] = vehicles.heading[slot]!;
      target.slot[count] = slot;
      target.generation[count] = vehicles.generation[slot]!;
      target.kind[count] = vehicles.parked[slot] === 1 ? PARKED_VEHICLE_KIND : vehicles.kind[slot]!;
      count += 1;
    }
    for (let i = 0; extras !== undefined && i < extras.count && count < this.capacity; i++) {
      target.x[count] = extras.x[i]!;
      target.y[count] = extras.y[i]!;
      target.heading[count] = extras.heading[i]!;
      target.slot[count] = extras.slot[i]!;
      target.generation[count] = extras.generation[i]!;
      target.kind[count] = extras.kind[i]!;
      count += 1;
    }
    const linkCount = links === undefined ? 0 : Math.min(links.count, this.linkCapacity);
    if (links !== undefined) target.load.set(links.load.subarray(0, linkCount));
    target.header[0] = tick;
    target.header[1] = count;
    target.header[2] = linkCount;
    target.header[3] = links?.builtFor ?? -1;
    Atomics.store(this.header, 0, (sequence + 1) | 0);
  }
}

export interface RenderFrameCopy {
  tick: number;
  count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly heading: Float32Array;
  /** Which vehicle each packed index is: packed order shifts whenever one spawns or despawns. */
  readonly slot: Uint32Array;
  readonly generation: Uint32Array;
  readonly kind: Uint8Array;
  /** Links whose load the frame carries, 0 when it carries none; the graph version they are numbered for. */
  links: number;
  linksFor: number;
  readonly load: Uint8Array;
}

export class RenderReader extends RenderBufferViews {
  allocate(): RenderFrameCopy {
    const n = this.capacity;
    return {
      tick: 0,
      count: 0,
      links: 0,
      linksFor: -1,
      load: new Uint8Array(this.linkCapacity),
      x: new Float32Array(n),
      y: new Float32Array(n),
      heading: new Float32Array(n),
      slot: new Uint32Array(n),
      generation: new Uint32Array(n),
      kind: new Uint8Array(n),
    };
  }

  /** The sequence of the newest publish, without copying anything: a reader checks it before `readInto`. */
  sequence(): number {
    return Atomics.load(this.header, 0);
  }

  /** Copies the active frame; returns the sequence it was published under, which moves with every publish. */
  readInto(out: RenderFrameCopy): number {
    for (;;) {
      const sequence = Atomics.load(this.header, 0);
      const frame = this.frameFor(sequence);
      const count = frame.header[1]!;
      out.tick = frame.header[0]!;
      out.count = count;
      out.x.set(frame.x.subarray(0, count));
      out.y.set(frame.y.subarray(0, count));
      out.heading.set(frame.heading.subarray(0, count));
      out.slot.set(frame.slot.subarray(0, count));
      out.generation.set(frame.generation.subarray(0, count));
      out.kind.set(frame.kind.subarray(0, count));
      out.links = frame.header[2]!;
      out.linksFor = frame.header[3]!;
      out.load.set(frame.load.subarray(0, out.links));
      if (Atomics.load(this.header, 0) === sequence) return sequence;
    }
  }
}
