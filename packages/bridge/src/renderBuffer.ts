// Render state shared between the sim worker and the main thread without a copy per message:
// a header and two frames. The writer fills the frame the sequence does not point at and publishes
// by bumping the sequence; the reader copies the frame the sequence points at and copies again if
// the sequence moved meanwhile. Layers for pedestrians and buses join with their stages.
import type { VehicleLayers } from '@simcity/sim';

/** `[sequence, capacity]`; the active frame is `sequence & 1`. */
const HEADER_WORDS = 2;
/** `[tick, count]` at the start of each frame. */
const FRAME_HEADER_WORDS = 2;

function align4(n: number): number {
  return (n + 3) & ~3;
}

export function frameByteLength(capacity: number): number {
  return FRAME_HEADER_WORDS * 4 + capacity * 4 * 3 + align4(capacity);
}

export function frameByteRange(capacity: number, index: number): { offset: number; length: number } {
  const length = frameByteLength(capacity);
  return { offset: HEADER_WORDS * 4 + index * length, length };
}

export function createRenderBuffer(capacity: number): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(HEADER_WORDS * 4 + 2 * frameByteLength(capacity));
  new Int32Array(sab, 0, HEADER_WORDS)[1] = capacity;
  return sab;
}

interface FrameViews {
  readonly header: Int32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly heading: Float32Array;
  readonly kind: Uint8Array;
}

function frameViews(sab: SharedArrayBuffer, capacity: number, index: number): FrameViews {
  let offset = frameByteRange(capacity, index).offset;
  const header = new Int32Array(sab, offset, FRAME_HEADER_WORDS);
  offset += FRAME_HEADER_WORDS * 4;
  const x = new Float32Array(sab, offset, capacity);
  offset += capacity * 4;
  const y = new Float32Array(sab, offset, capacity);
  offset += capacity * 4;
  const heading = new Float32Array(sab, offset, capacity);
  offset += capacity * 4;
  const kind = new Uint8Array(sab, offset, capacity);
  return { header, x, y, heading, kind };
}

class RenderBufferViews {
  readonly capacity: number;
  protected readonly header: Int32Array;
  protected readonly frames: readonly [FrameViews, FrameViews];

  constructor(sab: SharedArrayBuffer) {
    this.header = new Int32Array(sab, 0, HEADER_WORDS);
    this.capacity = this.header[1]!;
    this.frames = [frameViews(sab, this.capacity, 0), frameViews(sab, this.capacity, 1)];
  }

  activeFrameIndex(): number {
    return Atomics.load(this.header, 0) & 1;
  }

  /** The frame a sequence number points at. */
  protected frameFor(sequence: number): FrameViews {
    return (sequence & 1) === 0 ? this.frames[0] : this.frames[1];
  }
}

export class RenderWriter extends RenderBufferViews {
  /** Packs the live vehicles into the inactive frame, then makes it the active one. */
  publish(tick: number, vehicles: VehicleLayers): void {
    const sequence = Atomics.load(this.header, 0);
    const target = this.frameFor(sequence + 1);
    const { alive } = vehicles;
    let count = 0;
    for (let slot = 0; slot < alive.length; slot++) {
      if (alive[slot] === 0) continue;
      if (count === this.capacity) throw new RangeError(`more than ${this.capacity} vehicles alive`);
      target.x[count] = vehicles.x[slot]!;
      target.y[count] = vehicles.y[slot]!;
      target.heading[count] = vehicles.heading[slot]!;
      target.kind[count] = vehicles.kind[slot]!;
      count += 1;
    }
    target.header[0] = tick;
    target.header[1] = count;
    Atomics.store(this.header, 0, (sequence + 1) | 0);
  }
}

export interface RenderFrameCopy {
  tick: number;
  count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly heading: Float32Array;
  readonly kind: Uint8Array;
}

export class RenderReader extends RenderBufferViews {
  allocate(): RenderFrameCopy {
    const n = this.capacity;
    return { tick: 0, count: 0, x: new Float32Array(n), y: new Float32Array(n), heading: new Float32Array(n), kind: new Uint8Array(n) };
  }

  readInto(out: RenderFrameCopy): void {
    for (;;) {
      const sequence = Atomics.load(this.header, 0);
      const frame = this.frameFor(sequence);
      const count = frame.header[1]!;
      out.tick = frame.header[0]!;
      out.count = count;
      out.x.set(frame.x.subarray(0, count));
      out.y.set(frame.y.subarray(0, count));
      out.heading.set(frame.heading.subarray(0, count));
      out.kind.set(frame.kind.subarray(0, count));
      if (Atomics.load(this.header, 0) === sequence) return;
    }
  }
}
